// srv/lib/github-app-token.js
//
// GitHub App installation-token minting for #1154. Signs an RS256 App JWT
// with the App private key (resolved via secret-resolver, credstore-first),
// exchanges it for a 1-hour installation token, and caches that token on a
// globalThis Symbol singleton until ~5 min before its real expiry.
//
// resolveGithubToken() is the single flag-gated entry point every runtime
// GitHub consumer calls: App token when USE_GITHUB_APP==='true' and
// available, classic PAT fallback otherwise. Fail-open on every fault.
//
// Spec: docs/superpowers/specs/2026-07-22-1154-github-app-migration-design.md

import { SignJWT } from 'jose';
import { createPrivateKey } from 'node:crypto';
import { resolveSecret } from './secret-resolver.js';

const GITHUB_API = 'https://api.github.com';
const EARLY_EXPIRY_MS = 5 * 60 * 1000;   // refresh 5 min before real expiry
const WARN_WINDOW_MS = 5 * 60 * 1000;

const STATE_KEY = Symbol.for('com.sap.developers.ims:github-app-token');
const _state = (globalThis[STATE_KEY] ??= {
  token: null,
  expiresAt: 0,        // ms epoch, already minus EARLY_EXPIRY_MS
  warnedWindowAt: 0,
});

function warnOnce(msg) {
  const now = Date.now();
  if (now - _state.warnedWindowAt > WARN_WINDOW_MS) {
    console.warn(`[github-app-token] ${msg}`);
    _state.warnedWindowAt = now;
  }
}

/**
 * Reconstruct a valid multi-line PEM from a value whose newlines were
 * collapsed to whitespace. The admin Secrets UI stored the pasted GitHub App
 * key as a single line ("-----BEGIN RSA PRIVATE KEY----- MIIE... -----END
 * RSA PRIVATE KEY-----"), which OpenSSL/createPrivateKey cannot decode
 * (DECODER routines::unsupported). We pull the BEGIN/END label + base64 body,
 * strip the injected whitespace, and re-wrap the body at 64 chars.
 *
 * Idempotent: a value that already contains newlines is returned trimmed,
 * unchanged. A value that doesn't look like a single-line PEM is returned
 * as-is (createPrivateKey then produces the original error for the caller's
 * try/catch to fail-open on).
 */
function normalizePem(raw) {
  const s = String(raw).trim();
  if (s.includes('\n')) return s;               // already multi-line — leave it
  const m = s.match(/^-----BEGIN ([A-Z0-9 ]+?)-----\s*([\s\S]*?)\s*-----END \1-----$/);
  if (!m) return s;                             // not a recognizable single-line PEM
  const label = m[1];
  const body = m[2].replace(/\s+/g, '');        // strip the injected whitespace
  const wrapped = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`;
}

/**
 * Get a cached GitHub App installation token, minting a fresh one if the
 * cache is empty or within EARLY_EXPIRY_MS of expiry. Fail-open: returns
 * null on any fault (missing App creds, sign failure, non-2xx, network).
 * @returns {Promise<string|null>}
 */
export async function getInstallationToken() {
  if (_state.token && Date.now() < _state.expiresAt) {
    return _state.token;
  }
  try {
    const [appId, installationId, privateKeyPem] = await Promise.all([
      resolveSecret('TUTORIALS_APP_ID', { logTag: '[github-app-token]' }),
      resolveSecret('TUTORIALS_APP_INSTALLATION_ID', { logTag: '[github-app-token]' }),
      resolveSecret('TUTORIALS_APP_PRIVATE_KEY', { logTag: '[github-app-token]' }),
    ]);
    if (!appId || !installationId || !privateKeyPem) {
      warnOnce('App credentials incomplete (need TUTORIALS_APP_ID + _INSTALLATION_ID + _PRIVATE_KEY) — falling back.');
      return null;
    }

    // GitHub App private keys download in PKCS#1 ("-----BEGIN RSA PRIVATE
    // KEY-----"); jose's importPKCS8 only accepts PKCS#8 and threw on the real
    // key (#1154 field fix). Node's createPrivateKey auto-detects PKCS#1 AND
    // PKCS#8 (and the resulting KeyObject is accepted by jose's signer), so it
    // works regardless of which format GitHub or a future rotation delivers.
    // normalizePem() first repairs a key whose newlines the admin UI collapsed
    // to spaces (else createPrivateKey throws DECODER routines::unsupported).
    const key = createPrivateKey(normalizePem(privateKeyPem));
    const nowSec = Math.floor(Date.now() / 1000);
    const appJwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(String(appId))
      .setIssuedAt(nowSec - 60)          // clock-skew guard
      .setExpirationTime(nowSec + 540)   // 9 min (GitHub caps at 10)
      .sign(key);

    const url = `${GITHUB_API}/app/installations/${installationId}/access_tokens`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appJwt}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      warnOnce(`installation-token exchange ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const json = await res.json();
    if (!json?.token) {
      warnOnce('installation-token response missing token field');
      return null;
    }
    const realExpiryMs = json.expires_at ? Date.parse(json.expires_at) : (Date.now() + 3600_000);
    _state.token = json.token;
    _state.expiresAt = realExpiryMs - EARLY_EXPIRY_MS;
    return _state.token;
  } catch (err) {
    warnOnce(`mint failed (falling back): ${err.message ?? err}`);
    return null;
  }
}

/**
 * Single flag-gated GitHub-token entry point for runtime consumers.
 * @param {string} fallbackAlias — PAT alias when App is off/unavailable.
 * @param {object} [opts] — { logTag } forwarded to resolveSecret fallback.
 * @returns {Promise<string|null>}
 */
export async function resolveGithubToken(fallbackAlias, opts = {}) {
  if (process.env.USE_GITHUB_APP === 'true') {
    const appTok = await getInstallationToken();
    if (appTok) return appTok;
    // fail-open: fall through to PAT
  }
  return resolveSecret(fallbackAlias, opts);
}

/** Force-flush the cached installation token (admin rotation hook). */
export function invalidateInstallationToken() {
  _state.token = null;
  _state.expiresAt = 0;
}

/** Test-only: clear cache + warn window. */
export function _resetForTests() {
  _state.token = null;
  _state.expiresAt = 0;
  _state.warnedWindowAt = 0;
}

/** Test-only: prime the cache without minting. */
export function _primeForTests(token, expiresAtMs) {
  _state.token = token;
  _state.expiresAt = expiresAtMs;
}
