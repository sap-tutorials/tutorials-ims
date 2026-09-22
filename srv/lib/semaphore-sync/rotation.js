// srv/lib/semaphore-sync/rotation.js
//
// Self-rotation of the Semaphore / Progress Data Cloud (PDC) API key (#2184).
//
// The API key is long-lived but expires (current key: 2026-12-20). PDC exposes
// a rotation flow, verified live 2026-09-22:
//
//   GET  {tokenBaseUrl}/api/account/apikey   (Bearer <access_token>)
//     → 200 { apikey, expiryDate:"2026-12-20T14:31:08Z" }
//   PUT  {tokenBaseUrl}/api/account/apikey   (Bearer <access_token>)
//     → 200 { apikey:"<NEW>", ... }
//     ⚠️ generating a new key DISCONNECTS the current session — the caller must
//        persist the returned key and re-authenticate with it next run.
//
// Strategy (folded into the weekly sync job, per #2184 decision): each run, if
// the key is within THRESHOLD_DAYS of expiry, rotate it and persist the new
// value to the same secret store (credstore in prod, env is read-only there so
// a dev env-key is never written back). Fail-SOFT: a rotation error is logged
// and returned as { rotated:false, error } — it must NOT block the taxonomy
// sync (an un-rotated key is still valid until its expiryDate).

import cds from '@sap/cds';
import { writeSecret } from '../credstore.js';
import { invalidateSecret } from '../secret-resolver.js';

const LOG = cds.log('semaphore-sync');
const API_KEY_ALIAS = 'SEMAPHORE_API_KEY';
const THRESHOLD_DAYS = 7;
const TIMEOUT_MS = 15_000;

function apikeyUrl(tokenBaseUrl) {
  return `${String(tokenBaseUrl).replace(/\/+$/, '')}/api/account/apikey`;
}

async function callApiKey(method, { tokenBaseUrl, token, _fetch = fetch }) {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await _fetch(apikeyUrl(tokenBaseUrl), {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: ac.signal,
    });
  } finally {
    clearTimeout(tid);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`semaphore ${method} /api/account/apikey HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

// Days until `expiryDate` (ISO string) from now. Returns Infinity if unparseable
// so a garbled date never triggers a needless rotation.
export function daysUntil(expiryDate, now = Date.now()) {
  const t = Date.parse(expiryDate);
  if (Number.isNaN(t)) return Infinity;
  return (t - now) / 86_400_000;
}

/**
 * Check the API key expiry and rotate if within THRESHOLD_DAYS.
 *
 * @param {object} opts
 * @param {string} opts.tokenBaseUrl   PDC origin (e.g. https://sap.data.progress.cloud)
 * @param {string} opts.token          a valid bearer access_token
 * @param {number} [opts.thresholdDays=7]
 * @param {object} [opts._deps]        test seam: { fetch, writeSecret, invalidateSecret }
 * @returns {Promise<{rotated:boolean, expiryDate?:string, daysLeft?:number, error?:string}>}
 */
export async function checkAndRotateApiKey(opts = {}) {
  const {
    tokenBaseUrl,
    token,
    thresholdDays = THRESHOLD_DAYS,
    _deps = {},
  } = opts;
  const _fetch = _deps.fetch ?? fetch;
  const _writeSecret = _deps.writeSecret ?? writeSecret;
  const _invalidateSecret = _deps.invalidateSecret ?? invalidateSecret;

  try {
    const info = await callApiKey('GET', { tokenBaseUrl, token, _fetch });
    const expiryDate = info?.expiryDate;
    const daysLeft = daysUntil(expiryDate);
    if (daysLeft > thresholdDays) {
      return { rotated: false, expiryDate, daysLeft };
    }

    LOG.info(`semaphore API key expires in ${daysLeft.toFixed(1)}d (≤${thresholdDays}d) — rotating`);
    const rotated = await callApiKey('PUT', { tokenBaseUrl, token, _fetch });
    const newKey = rotated?.apikey;
    if (typeof newKey !== 'string' || !newKey) {
      throw new Error('rotation PUT response missing apikey');
    }
    // Persist FIRST — the old session/key is now dead. If this write fails the
    // new key is lost and the next run's token exchange will 401; we surface
    // that loudly rather than swallow it.
    await _writeSecret(API_KEY_ALIAS, newKey);
    _invalidateSecret(API_KEY_ALIAS);   // next resolveSecret() reads the new value
    LOG.info('semaphore API key rotated and persisted to credential store');
    return { rotated: true, expiryDate, daysLeft, newExpiryDate: rotated?.expiryDate };
  } catch (err) {
    // Fail-soft: never block the sync on a rotation hiccup.
    LOG.warn(`semaphore key rotation failed (non-fatal): ${err.message}`);
    return { rotated: false, error: err.message };
  }
}
