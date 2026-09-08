// srv/lib/semaphore-sync/client.js
//
// Thin read-only client for the Semaphore SES (Semantic Enhancement Server)
// REST API — the `allterms` command that returns every term of a model as JSON.
//
//   GET {baseUrl}/{model}/{lang}/allterms.json[?FILTER=CL=<class>]
//   e.g. https://sap.data.progress.cloud/semantic/prodses/SAPCore/en/allterms.json
//
// Connectivity + auth come from the BTP `semaphore-destination` (resolved via
// cds.requires.semaphore → @sap-cloud-sdk/connectivity). The SES tenant is
// reached with a Service Account token (issue #2184); we read the auth material
// off the resolved SDK Destination and attach an Authorization header, mirroring
// how srv/lib/ngds-client.js handles ngds-destination.
//
// Fail-shut on the network side: every path throws a descriptive Error rather
// than returning partial data, so the calling job records a FAILED PipelineLog
// row instead of silently wiping tags from an empty/garbled response.
//
// ⚠️ The precise auth flavour (OAuth2 client-credentials vs. a long-lived bearer
// token property) is not confirmable until the Service Account is issued. We
// prefer the SDK-resolved auth token, fall back to an explicit token property,
// then to Basic — whichever the destination is configured with will work.

import { getDestination } from '@sap-cloud-sdk/connectivity';

const DEFAULT_TIMEOUT_MS = 20_000;

// Build the allterms URL. Pure + exported for unit testing.
export function buildAllTermsUrl(baseUrl, { model, lang = 'en', filter } = {}) {
  if (!baseUrl) throw new Error('semaphore: missing base URL');
  if (!model) throw new Error('semaphore: missing model name');
  const root = String(baseUrl).replace(/\/+$/, '');
  const path = `${root}/${encodeURIComponent(model)}/${encodeURIComponent(lang)}/allterms.json`;
  if (!filter) return path;
  // FILTER is passed through verbatim (e.g. "CL=INDUSTRY_CLUSTER"); encode the
  // value so multi-clause filters survive as a single query parameter.
  return `${path}?FILTER=${encodeURIComponent(filter)}`;
}

// Derive { baseUrl, authHeader } from a resolved SDK Destination. Prefers an
// SDK-resolved OAuth/token (dest.authTokens), then an explicit token property,
// then Basic auth from username/password.
export function deriveAuth(dest) {
  if (!dest) throw new Error("Destination 'semaphore-destination' not found");
  const op = dest.originalProperties ?? {};
  const baseUrl = (dest.url ?? op.URL ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('semaphore-destination has no URL');

  // 1. SDK already fetched a token for OAuth2*/OAuth2ClientCredentials/token dests.
  const sdkToken = Array.isArray(dest.authTokens) && dest.authTokens[0]?.value;
  if (sdkToken) {
    const type = dest.authTokens[0].type || 'Bearer';
    return { baseUrl, authHeader: `${type} ${sdkToken}` };
  }
  // 2. Explicit long-lived token carried as a custom destination property.
  const apiToken = op.apiToken ?? op.APIToken ?? op.token ?? dest.apiToken;
  if (apiToken) return { baseUrl, authHeader: `Bearer ${apiToken}` };

  // 3. Basic auth fallback.
  const user = dest.username ?? op.User;
  const pass = dest.password ?? op.Password;
  if (user && pass) {
    return { baseUrl, authHeader: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
  }
  throw new Error('semaphore-destination has no usable auth (token/basic)');
}

/**
 * Fetch and parse the SES allterms response for a model.
 *
 * @param {object} opts
 * @param {string} opts.model                model name, e.g. "SAPCore"
 * @param {string} [opts.lang='en']
 * @param {string} [opts.filter]             SES FILTER clause, e.g. "CL=INDUSTRY_CLUSTER"
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.destinationName='semaphore-destination']
 * @param {object} [opts._deps]              test seam: { getDestination, fetch }
 * @returns {Promise<object>} parsed allterms JSON ({ terms:[...] })
 */
export async function fetchAllTerms(opts = {}) {
  const {
    model,
    lang = 'en',
    filter,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    destinationName = 'semaphore-destination',
    _deps = {},
  } = opts;

  const _getDestination = _deps.getDestination ?? getDestination;
  const _fetch = _deps.fetch ?? fetch;

  const dest = await _getDestination({ destinationName });
  const { baseUrl, authHeader } = deriveAuth(dest);
  const url = buildAllTermsUrl(baseUrl, { model, lang, filter });

  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await _fetch(url, {
      method: 'GET',
      headers: { Authorization: authHeader, Accept: 'application/json' },
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
