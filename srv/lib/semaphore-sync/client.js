// srv/lib/semaphore-sync/client.js
//
// Read-only client for the Semaphore SES (Semantic Enhancement Server) hosted
// on the Progress Data Cloud (PDC). Fetches the `allterms` command that returns
// every term of a model as JSON.
//
//   GET {baseUrl}/{model}/{lang}/allterms.json[?FILTER=CL=<class>]
//   e.g. https://sap.data.progress.cloud/semantic/prodses/SAPCore/en/allterms.json
//
// AUTH — two-step, verified live against PDC (issue #2184, 2026-09-22):
//   1. POST {tokenBaseUrl}/token/
//        Content-Type: application/x-www-form-urlencoded
//        body: key=<apiKey>                          ← field is "key", NOT "apikey"
//      → 200 { access_token, token_type:"bearer", expires_in:180, ".expires", userName }
//        NB: the access token lives only ~180s, so we fetch a fresh one per run
//        immediately before the allterms call — there is no cross-run cache.
//   2. GET .../allterms.json
//        Authorization: Bearer <access_token>
//
// The API key itself is a long-lived, SELF-ROTATING credential (see rotation.js)
// resolved via secret-resolver (SEMAPHORE_API_KEY env in dev → BTP Credential
// Store alias in hybrid/prod). The connectivity base URL comes from the BTP
// `semaphore-destination` (cds.requires.semaphore → @sap-cloud-sdk/connectivity);
// dev/unit profiles point it at a mock URL in .cdsrc.json.
//
// FAIL-SHUT: every path throws a descriptive Error rather than returning partial
// data, so the calling job records a FAILED PipelineLog row instead of silently
// wiping tags from an empty/garbled response.
//
// SIZE: the live SAPCore allterms payload is ~61 MB / ~21k terms and completes
// in ~6s on a warm connection, but a cold/slow fetch can run long — hence the
// generous default timeout. Prefer a FILTER (semaphore.sync.filter) to shrink it.

import { getDestination } from '@sap-cloud-sdk/connectivity';
import { resolveSecret } from '../secret-resolver.js';

const DEFAULT_TIMEOUT_MS = 120_000;   // 61 MB payload; 20s was too tight (#2184)
const TOKEN_TIMEOUT_MS = 15_000;
const API_KEY_ALIAS = 'SEMAPHORE_API_KEY';

// The PDC token endpoint is the host root, independent of the SES model path
// (which the destination's `path` may prefix). Derive it from the destination
// URL's origin so a reconfigured base still points token calls at /token/.
export function deriveTokenBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    // baseUrl already an origin, or malformed — strip any trailing path segment
    // after the host. Fall back to the raw value.
    const m = String(baseUrl).match(/^(https?:\/\/[^/]+)/i);
    return m ? m[1] : String(baseUrl).replace(/\/+$/, '');
  }
}

// Build the allterms URL. Pure + exported for unit testing.
export function buildAllTermsUrl(baseUrl, { model, lang = 'en', filter } = {}) {
  if (!baseUrl) throw new Error('semaphore: missing base URL');
  if (!model) throw new Error('semaphore: missing model name');
  const root = String(baseUrl).replace(/\/+$/, '');
  const path = `${root}/${encodeURIComponent(model)}/${encodeURIComponent(lang)}/allterms.json`;
  if (!filter) return path;
  // FILTER is passed through as an SES clause (e.g. "CL=TOPIC"); encode the
  // value so multi-clause filters survive as a single query parameter.
  return `${path}?FILTER=${encodeURIComponent(filter)}`;
}

// Resolve the SES base URL from the connectivity destination. The API key is
// resolved separately (secret-resolver), NOT off the destination — the PDC auth
// is a token exchange, not a static destination credential.
export async function resolveBaseUrl(dest) {
  if (!dest) throw new Error("Destination 'semaphore-destination' not found");
  const op = dest.originalProperties ?? {};
  const baseUrl = (dest.url ?? op.URL ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('semaphore-destination has no URL');
  return baseUrl;
}

/**
 * PDC step 1: exchange the API key for a short-lived (~180s) bearer token.
 * @returns {Promise<string>} access_token
 */
export async function fetchAccessToken(apiKey, { tokenBaseUrl, timeoutMs = TOKEN_TIMEOUT_MS, _fetch = fetch } = {}) {
  if (!apiKey) throw new Error('semaphore: no API key (SEMAPHORE_API_KEY) resolved');
  if (!tokenBaseUrl) throw new Error('semaphore: no token base URL');
  const url = `${tokenBaseUrl.replace(/\/+$/, '')}/token/`;
  const body = new URLSearchParams({ key: apiKey }).toString();

  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await _fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: ac.signal,
    });
  } catch (err) {
    throw new Error(`semaphore token fetch failed: ${err.message}`);
  } finally {
    clearTimeout(tid);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`semaphore token HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`semaphore token returned non-JSON: ${err.message}`);
  }
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('semaphore token response missing access_token');
  }
  return data.access_token;
}

/**
 * Resolve everything needed to talk to PDC in one place: the SES base URL
 * (destination), the token endpoint origin, and a fresh ~180s access token.
 * Shared by the sync fetch AND the rotation pre-check so a single run does one
 * token exchange. Fail-shut.
 *
 * @param {object} [opts]
 * @param {string} [opts.destinationName='semaphore-destination']
 * @param {object} [opts._deps]  { getDestination, fetch, resolveSecret }
 * @returns {Promise<{baseUrl:string, tokenBaseUrl:string, token:string}>}
 */
export async function resolveConnection(opts = {}) {
  const { destinationName = 'semaphore-destination', _deps = {} } = opts;
  const _getDestination = _deps.getDestination ?? getDestination;
  const _fetch = _deps.fetch ?? fetch;
  const _resolveSecret = _deps.resolveSecret ?? resolveSecret;

  const dest = await _getDestination({ destinationName });
  const baseUrl = await resolveBaseUrl(dest);
  const tokenBaseUrl = deriveTokenBaseUrl(baseUrl);
  const apiKey = await _resolveSecret(API_KEY_ALIAS, { logTag: '[semaphore]' });
  const token = await fetchAccessToken(apiKey, { tokenBaseUrl, _fetch });
  return { baseUrl, tokenBaseUrl, token };
}

/**
 * Fetch and parse the SES allterms response for a model. Does the full PDC
 * two-step: resolve base URL (destination) + API key (secret-resolver), exchange
 * the key for a bearer token, then GET allterms with that token.
 *
 * Pass `opts.connection` (from resolveConnection) to reuse an already-fetched
 * token — the sync job does this so rotation + fetch share one exchange.
 *
 * @param {object} opts
 * @param {string} opts.model                model name, e.g. "SAPCore"
 * @param {string} [opts.lang='en']
 * @param {string} [opts.filter]             SES FILTER clause, e.g. "CL=TOPIC"
 * @param {number} [opts.timeoutMs]
 * @param {object} [opts.connection]         pre-resolved { baseUrl, token }
 * @param {string} [opts.destinationName='semaphore-destination']
 * @param {object} [opts._deps]              test seam: { getDestination, fetch, resolveSecret }
 * @returns {Promise<object>} parsed allterms JSON ({ terms:[...] })
 */
export async function fetchAllTerms(opts = {}) {
  const {
    model,
    lang = 'en',
    filter,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    connection,
    _deps = {},
  } = opts;

  const _fetch = _deps.fetch ?? fetch;
  const { baseUrl, token } = connection ?? (await resolveConnection(opts));

  const url = buildAllTermsUrl(baseUrl, { model, lang, filter });

  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await _fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: ac.signal,
    });
  } catch (err) {
    throw new Error(`semaphore allterms fetch failed: ${err.message}`);
  } finally {
    clearTimeout(tid);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`semaphore allterms HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`semaphore allterms returned non-JSON: ${err.message}`);
  }
  if (!data || !Array.isArray(data.terms)) {
    throw new Error('semaphore allterms response missing terms[] array');
  }
  return data;
}
