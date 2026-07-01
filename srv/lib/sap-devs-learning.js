// srv/lib/sap-devs-learning.js
//
// Vendored port of the sap-devs CLI's learning client
// (D:\projects\sap-devs-cli\internal\learning\catalog.go + api.go). Replaces the
// MCP-transport hop that used to sit between our Phase 4.1 fetcher cron
// (srv/jobs/fetch-learning-journeys-job.js) and learning.sap.com's public
// catalog endpoints.
//
// Two entry points, matching the two Go paths:
//
//   1. fetchLearningCatalog()
//      GET https://learning.sap.com/service/catalog-download/json
//      Returns ALL learning journeys (~350 rows). Cheap, single request.
//      Direct port of Go FetchCatalog at
//      D:\projects\sap-devs-cli\internal\learning\catalog.go:13-47.
//
//   2. searchLearningJourneys({ query, limit })
//      For empty `query` (the only path our fetcher cron takes), delegates
//      to fetchLearningCatalog() and slices to `limit`.
//      For non-empty `query`, hits the getCards search endpoint.
//      Port of Go SearchAPI at
//      D:\projects\sap-devs-cli\internal\learning\api.go:14-61.
//
// Return shape (matches the wire contract in
// srv/lib/sap-devs-client.js:validateSearchLearningJourneys — {slug, title,
// level, duration, url} — with `duration` as a stringified decimal of hours):
//
//   { slug, title, level, duration, url, description }
//
// The extra `description` field is accepted by the validator (which only
// checks REQUIRED fields) and consumed by the fetcher's LLM concept
// extraction as additional context.

const CATALOG_URL = 'https://learning.sap.com/service/catalog-download/json';
const SEARCH_URL  = 'https://learning.sap.com/service/learning/search/getCards';
const BASE_URL    = 'https://learning.sap.com/learning-journeys/';
const CATALOG_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS  = 15_000;

/**
 * Fetch the full catalog and return every learning-journey row.
 * Matches Go FetchCatalog. Journeys that lack an extractable slug are
 * dropped (same as the Go code — a journey with no direct link is
 * unreachable and useless downstream).
 */
export async function fetchLearningCatalog() {
  const body = await fetchJSON(CATALOG_URL, { timeoutMs: CATALOG_TIMEOUT_MS });
  if (!Array.isArray(body)) {
    throw new Error(`sap-devs-learning: catalog response is not an array (got ${typeof body})`);
  }
  const journeys = [];
  for (const item of body) {
    if (item?.Learning_type !== 'Learning Journey') continue;
    const j = convertCatalogItem(item);
    if (!j.slug) continue;
    journeys.push(j);
  }
  return journeys;
}

/**
 * Search or list learning journeys.
 * @param {object} opts
 * @param {string} [opts.query='']  — search term; empty = fetch full catalog
 * @param {number} [opts.limit=200] — max rows to return
 * @returns {Promise<Array<{slug, title, level, duration, url, description}>>}
 */
export async function searchLearningJourneys({ query = '', limit = 200 } = {}) {
  // Fetcher cron always passes an empty query — it wants a bulk pull, not
  // a keyword search. The full catalog is authoritative for that path.
  if (!query || !query.trim()) {
    const all = await fetchLearningCatalog();
    return all.slice(0, limit);
  }
  return searchViaGetCards({ query, limit });
}

// ── Internals ─────────────────────────────────────────────────────────

async function searchViaGetCards({ query, limit }) {
  // Matches Go SearchAPI URL construction. Note the double URL-encoding:
  // the filters JSON and types array are each PathEscape'd, then the
  // whole thing is embedded into a positional `(...)` OData-ish path.
  const filters = JSON.stringify({ locale: 'en-US', query });
  const types = JSON.stringify(['learning-journey']);
  const url =
    `${SEARCH_URL}(types='${encodeURIComponent(types)}'` +
    `,filters='${encodeURIComponent(filters)}'` +
    `,sort='',limit=${limit},page=1)`;

  const body = await fetchJSON(url, { timeoutMs: SEARCH_TIMEOUT_MS });
  const results = body?.value?.results;
  if (!Array.isArray(results)) {
    throw new Error(`sap-devs-learning: search response missing value.results`);
  }
  return results.map((r) => ({
    slug: r.slug || '',
    title: r.title || '',
    level: r.experienceLevel || '',
    // Go stringifies Duration as %.2f; mirror so downstream Decimal parse works.
    duration: typeof r.duration === 'number' ? r.duration.toFixed(2) : '',
    url: BASE_URL + (r.slug || ''),
    description: r.description || '',
  }));
}

/**
 * Map one raw catalog-download row to our wire shape. Preserves the
 * Go convertCatalogItem semantics: slug from Direct_link.hyperlink prefix
 * stripping, duration coerced through toDurationString.
 */
function convertCatalogItem(item) {
  const hyperlink = item?.Direct_link?.hyperlink || '';
  const slug = extractSlug(hyperlink);
  return {
    slug,
    title: item.Title || '',
    // The catalog's Level field is a free-text string like "Beginner".
    // The MCP wrapper passed it through as-is; keep parity.
    level: item.Level || '',
    duration: toDurationString(item.Duration_in_hours),
    url: hyperlink,
    description: item.Description || '',
  };
}

function extractSlug(url) {
  if (!url || typeof url !== 'string') return '';
  const prefix = 'https://learning.sap.com/learning-journeys/';
  if (!url.startsWith(prefix)) return '';
  return url.slice(prefix.length).replace(/\/$/, '');
}

/**
 * Coerce Duration_in_hours (which the API returns as string, number, or
 * null depending on the row) to a stringified 2-decimal number. Mirrors
 * Go toDurationString.
 */
function toDurationString(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v.toFixed(2);
  return '';
}

/**
 * Fetch JSON with an AbortController-based timeout. Native fetch is Node
 * 18+; project baseline is Node 20 so this is safe.
 */
async function fetchJSON(url, { timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      // Learning.sap.com returns JSON without any auth headers required.
      headers: { Accept: 'application/json' },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`sap-devs-learning: HTTP ${res.status} for ${url}`);
  }
  return res.json();
}
