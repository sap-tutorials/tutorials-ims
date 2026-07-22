import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateKeyPair, exportPKCS8, jwtVerify, importSPKI, exportSPKI } from 'jose';
import { generateKeyPairSync } from 'node:crypto';

// secret-resolver is the only dependency — mock it so no credstore/env needed.
vi.mock('../../srv/lib/secret-resolver.js', () => ({
  resolveSecret: vi.fn(),
}));
import { resolveSecret } from '../../srv/lib/secret-resolver.js';
import {
  getInstallationToken, resolveGithubToken,
  invalidateInstallationToken, _resetForTests, _primeForTests,
} from '../../srv/lib/github-app-token.js';

let publicPem, privatePem;
beforeEach(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  publicPem = await exportSPKI(publicKey);
  privatePem = await exportPKCS8(privateKey);
  _resetForTests();
  resolveSecret.mockReset();
  delete process.env.USE_GITHUB_APP;
});

function primeAppCreds() {
  resolveSecret.mockImplementation(async (alias) => {
    if (alias === 'TUTORIALS_APP_ID') return '123456';
    if (alias === 'TUTORIALS_APP_INSTALLATION_ID') return '789';
    if (alias === 'TUTORIALS_APP_PRIVATE_KEY') return privatePem;
    return null;
  });
}

it('mints an installation token with a correctly-signed RS256 App JWT', async () => {
  primeAppCreds();
  let sentAuthHeader, sentUrl;
  global.fetch = vi.fn(async (url, init) => {
    sentUrl = url; sentAuthHeader = init.headers.Authorization;
    return { ok: true, status: 201, json: async () => ({
      token: 'ghs_installationtoken', expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }) };
  });

  const tok = await getInstallationToken();
  expect(tok).toBe('ghs_installationtoken');
  expect(sentUrl).toBe('https://api.github.com/app/installations/789/access_tokens');

  const jwt = sentAuthHeader.replace('Bearer ', '');
  const pub = await importSPKI(publicPem, 'RS256');
  const { payload, protectedHeader } = await jwtVerify(jwt, pub);
  expect(protectedHeader.alg).toBe('RS256');
  expect(payload.iss).toBe('123456');
  expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
});

// #1154 field bug: GitHub App private keys download in PKCS#1 format
// ("-----BEGIN RSA PRIVATE KEY-----"). jose's importPKCS8 only accepts
// PKCS#8, so the runtime mint failed-open to the PAT on the real key.
// The module must accept BOTH formats. This test uses a real PKCS#1 key
// (as GitHub delivers) and asserts a valid JWT is still minted + verifiable.
it('mints from a PKCS#1 (BEGIN RSA PRIVATE KEY) key as GitHub delivers it', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },   // GitHub's format
  });
  expect(privateKey.startsWith('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
  resolveSecret.mockImplementation(async (alias) => {
    if (alias === 'TUTORIALS_APP_ID') return '123456';
    if (alias === 'TUTORIALS_APP_INSTALLATION_ID') return '789';
    if (alias === 'TUTORIALS_APP_PRIVATE_KEY') return privateKey;
    return null;
  });
  let sentAuthHeader;
  global.fetch = vi.fn(async (url, init) => {
    sentAuthHeader = init.headers.Authorization;
    return { ok: true, status: 201, json: async () => ({
      token: 'ghs_pkcs1', expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }) };
  });

  const tok = await getInstallationToken();
  expect(tok).toBe('ghs_pkcs1');   // fails (null) before the fix — mint threw + fell open
  const jwt = sentAuthHeader.replace('Bearer ', '');
  const pub = await importSPKI(publicKey, 'RS256');
  const { payload, protectedHeader } = await jwtVerify(jwt, pub);
  expect(protectedHeader.alg).toBe('RS256');
  expect(payload.iss).toBe('123456');
});

// #1154 field bug #2: the admin Secrets UI collapsed the pasted PEM's
// newlines to spaces, so the stored value is a single line
// "-----BEGIN RSA PRIVATE KEY----- MIIEp... -----END RSA PRIVATE KEY-----".
// OpenSSL's createPrivateKey then throws DECODER routines::unsupported.
// The module must reconstruct a valid multi-line PEM from the mangled form.
it('mints from a whitespace-mangled single-line PEM (admin-UI newline stripping)', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  // Reproduce exactly what was stored: all newlines → single spaces.
  const mangled = privateKey.replace(/\r?\n/g, ' ').trim();
  expect(mangled.includes('\n')).toBe(false);
  resolveSecret.mockImplementation(async (alias) => {
    if (alias === 'TUTORIALS_APP_ID') return '123456';
    if (alias === 'TUTORIALS_APP_INSTALLATION_ID') return '789';
    if (alias === 'TUTORIALS_APP_PRIVATE_KEY') return mangled;
    return null;
  });
  let sentAuthHeader;
  global.fetch = vi.fn(async (url, init) => {
    sentAuthHeader = init.headers.Authorization;
    return { ok: true, status: 201, json: async () => ({
      token: 'ghs_mangled', expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }) };
  });

  const tok = await getInstallationToken();
  expect(tok).toBe('ghs_mangled');   // null before the fix — createPrivateKey threw
  const jwt = sentAuthHeader.replace('Bearer ', '');
  const pub = await importSPKI(publicKey, 'RS256');
  const { payload } = await jwtVerify(jwt, pub);
  expect(payload.iss).toBe('123456');
});

it('caches the token — second call within TTL does not re-POST', async () => {
  primeAppCreds();
  const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({
    token: 'ghs_cached', expires_at: new Date(Date.now() + 3600_000).toISOString(),
  }) }));
  global.fetch = fetchMock;
  await getInstallationToken();
  await getInstallationToken();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('re-mints when cached token is within 5 min of expiry', async () => {
  primeAppCreds();
  const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({
    token: 'ghs_fresh', expires_at: new Date(Date.now() + 3600_000).toISOString(),
  }) }));
  global.fetch = fetchMock;
  _primeForTests('ghs_stale', Date.now() - 1);   // already past early-expiry
  const tok = await getInstallationToken();
  expect(tok).toBe('ghs_fresh');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('fails open to null on non-2xx', async () => {
  primeAppCreds();
  global.fetch = vi.fn(async () => ({ ok: false, status: 403, text: async () => 'forbidden' }));
  expect(await getInstallationToken()).toBeNull();
});

it('fails open to null when App creds are missing', async () => {
  resolveSecret.mockResolvedValue(null);
  global.fetch = vi.fn();
  expect(await getInstallationToken()).toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
});

it('resolveGithubToken returns PAT (no mint) when USE_GITHUB_APP is off', async () => {
  resolveSecret.mockImplementation(async (a) => a === 'MY_PAT' ? 'pat-value' : null);
  global.fetch = vi.fn();
  const tok = await resolveGithubToken('MY_PAT');
  expect(tok).toBe('pat-value');
  expect(global.fetch).not.toHaveBeenCalled();
});

it('resolveGithubToken prefers App token when USE_GITHUB_APP=true', async () => {
  process.env.USE_GITHUB_APP = 'true';
  primeAppCreds();
  global.fetch = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({
    token: 'ghs_app', expires_at: new Date(Date.now() + 3600_000).toISOString(),
  }) }));
  expect(await resolveGithubToken('TUTORIALS_GITHUB_TOKEN')).toBe('ghs_app');
});

it('resolveGithubToken falls back to PAT when App token is null even with flag on', async () => {
  process.env.USE_GITHUB_APP = 'true';
  resolveSecret.mockImplementation(async (a) => a === 'TUTORIALS_GITHUB_TOKEN' ? 'pat-fallback' : null);
  global.fetch = vi.fn();   // creds missing → getInstallationToken returns null without fetch
  expect(await resolveGithubToken('TUTORIALS_GITHUB_TOKEN')).toBe('pat-fallback');
});
