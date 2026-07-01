// srv/lib/sap-devs-discovery.js
//
// Vendored port of the sap-devs CLI's discovery client
// (D:\projects\sap-devs-cli\internal\discovery\client.go). Talks directly to
// SAP Discovery Center's OData V2 platformx service via the CSRF + $batch
// dance the sap-devs CLI figured out.
//
// One entry point:
//
//   searchDiscoveryMissions({ query, top }) → Promise<Array<Mission>>
//
// Direct port of Go Client.SearchMissions + Client.fetchCSRF +
// Client.batchGET + extractBatchJSON. See client.go:47-65, 156-174,
// 182-239, and 244-301 respectively for the reference implementation.
//
// Wire flow:
//
//   1. HEAD /platformx/           with header  x-csrf-token: Fetch
//                                 → response  x-csrf-token: <token>
//   2. POST /platformx/$batch     multipart/mixed body wrapping a
//                                 single GET GetViewFuzzySearchesCustomV3
//                                 → response  OData batch envelope
//   3. Extract the JSON from the batch response's "d.<FunctionName>"
//      field, unwrap any double-encoded string, return the array.
//
// The returned array element shape (after our post-processing) is
// `{ id, name, effort, category, description }` — matching the wire
// contract that srv/lib/sap-devs-client.js:validateSearchDiscovery
// expects. `id` is stringified (was `int` in Go, but the fetcher +
// validator both treat it as string, matching the MCP wrapper).

const BASE_URL             = 'https://discovery-center.cloud.sap';
const PLATFORMX_PATH       = '/platformx/';
const REQUEST_TIMEOUT_MS   = 15_000;

/**
 * Search Discovery Center missions.
 *
 * @param {object} opts
 * @param {string} [opts.query='']  — search term; empty returns everything up to `top`.
 * @param {number} [opts.top=200]   — server-side page size cap.
 * @returns {Promise<Array<{id: string, name: string, effort: string, category: string, description: string}>>}
 */
export async function searchDiscoveryMissions({ query = '', top = 200 } = {}) {
  // Two attempts — an expired CSRF token may need a refresh. Same
  // behavior the Go client leaves implicit (single retry loop callers
  // wrap around batchGET).
  let csrfToken = await fetchCSRF();
  let missions;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      missions = await batchSearchMissions({ query, top, csrfToken });
      break;
    } catch (err) {
      // Re-fetch CSRF once on the specific "token invalid" path. Any
      // other failure surfaces to the caller unchanged.
      if (attempt === 0 && /csrf/i.test(err.message || '')) {
        csrfToken = await fetchCSRF();
        continue;
      }
      throw err;
    }
  }
  return missions.map(normalizeMission);
}

// ── Internals ─────────────────────────────────────────────────────────

async function fetchCSRF() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(BASE_URL + PLATFORMX_PATH, {
      method: 'HEAD',
      signal: controller.signal,
      headers: {
        'x-csrf-token': 'Fetch',
        'x-requested-with': 'XMLHttpRequest',
      },
    });
  } finally {
    clearTimeout(timer);
  }
  const token = res.headers.get('x-csrf-token');
  if (!token) {
    throw new Error(`sap-devs-discovery: CSRF fetch failed — no x-csrf-token header (HTTP ${res.status})`);
  }
  return token;
}

async function batchSearchMissions({ query, top, csrfToken }) {
  // Query construction matches Go SearchMissions. The empty filter
  // fields (`filterCategory=''` etc.) are load-bearing — the OData
  // function requires them present even when unused.
  const q =
    `GetViewFuzzySearchesCustomV3?searchString='${encodeQueryLiteral(query)}'` +
    `&filterCategory=''&filterType=mission-catalog-search` +
    `&filterProduct=''&filterLob=''&filterIndustry=''` +
    `&filterFocusTags=''&filterPartners=''` +
    `&filterQuickFilter=''&top='${top}'`;

  const boundary = `batch_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const body = [
    `--${boundary}`,
    'Content-Type: application/http',
    'Content-Transfer-Encoding: binary',
    '',
    `GET ${q} HTTP/1.1`,
    'sap-cancel-on-close: false',
    'sap-contextid-accept: header',
    'Accept: application/json',
    'Accept-Language: en',
    'DataServiceVersion: 2.0',
    'MaxDataServiceVersion: 2.0',
    'X-Requested-With: XMLHttpRequest',
    `x-csrf-token: ${csrfToken}`,
    '',
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(BASE_URL + PLATFORMX_PATH + '$batch', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': `multipart/mixed;boundary=${boundary}`,
        'x-csrf-token': csrfToken,
        'x-requested-with': 'XMLHttpRequest',
        'DataServiceVersion': '2.0',
        'MaxDataServiceVersion': '2.0',
        'Accept': 'multipart/mixed',
        'Accept-Language': 'en',
      },
      body,
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 403) {
    // CSRF-invalid path — the caller retries once with a fresh token.
    throw new Error(`sap-devs-discovery: CSRF token rejected (HTTP 403)`);
  }
  if (!res.ok && res.status !== 202) {
    throw new Error(`sap-devs-discovery: batch HTTP ${res.status}`);
  }
  const text = await res.text();
  const missions = extractBatchJSON(text);
  if (!Array.isArray(missions)) {
    throw new Error(`sap-devs-discovery: batch response inner value is not an array`);
  }
  return missions;
}

/**
 * Pull the single OData function result out of a multipart $batch
 * response body. The wrapper looks like:
 *
 *   --changesetX
 *   Content-Type: application/http
 *   HTTP/1.1 200 OK
 *   Content-Type: application/json
 *
 *   {"d":{"GetViewFuzzySearchesCustomV3":"[{...}]"}}
 *   --changesetX--
 *
 * The value under `d.<funcname>` is EITHER a double-encoded JSON string
 * (Discovery Center returns it this way) OR a native JSON array/object.
 * We handle both. Ported from Go extractBatchJSON.
 */
export function extractBatchJSON(text) {
  const start = text.indexOf('{');
  if (start < 0) {
    throw new Error(`sap-devs-discovery: no JSON in batch response`);
  }
  // Walk to the matching closing brace so we don't feed multipart
  // boundary lines into JSON.parse.
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) {
    throw new Error(`sap-devs-discovery: unterminated JSON in batch response`);
  }
  const envelope = JSON.parse(text.slice(start, end));
  if (!envelope || typeof envelope !== 'object' || !('d' in envelope)) {
    throw new Error(`sap-devs-discovery: batch response missing "d" envelope`);
  }
  const inner = envelope.d;
  if (!inner || typeof inner !== 'object') {
    throw new Error(`sap-devs-discovery: batch response "d" is not an object`);
  }
  // There's exactly one key inside `d` — the OData function name.
  // Grab whatever's under it.
  const keys = Object.keys(inner);
  if (keys.length === 0) {
    throw new Error(`sap-devs-discovery: batch response "d" is empty`);
  }
  const value = inner[keys[0]];
  // Discovery Center double-encodes: the value is a JSON string that
  // itself parses to the array. Native OData functions can also return
  // the object directly. Handle both.
  if (typeof value === 'string') {
    return JSON.parse(value);
  }
  return value;
}

/**
 * Turn the raw Mission object (matching Go's Mission struct field
 * names: capitalized JSON keys like Id, Name, Category, Effort,
 * UCLongDescription) into the wire shape the fetcher expects.
 *
 * `id` is stringified because the fetcher's validator (see
 * srv/lib/sap-devs-client.js:validateSearchDiscovery) requires it to be
 * a string. The Go struct uses `int` but the MCP wrapper stringifies.
 */
function normalizeMission(m) {
  return {
    id: String(m?.Id ?? ''),
    name: String(m?.Name ?? ''),
    // The API returns Effort as a bare integer 0-3 (as a string), e.g. "2".
    // The MCP wrapper passes it through unchanged; the fetcher parses it.
    effort: String(m?.Effort ?? ''),
    category: String(m?.Category ?? ''),
    description: String(m?.UCLongDescription ?? ''),
  };
}

/**
 * Escape a single-quote inside an OData literal by SQL-style doubling
 * ('' represents a single '). Also strips any characters that could
 * break out of the ' ' quoting (control chars).
 */
function encodeQueryLiteral(s) {
  if (!s) return '';
  return String(s).replace(/'/g, "''").replace(/[\x00-\x1F]/g, '');
}
