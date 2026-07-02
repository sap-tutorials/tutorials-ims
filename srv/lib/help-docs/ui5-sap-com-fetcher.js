// srv/lib/help-docs/ui5-sap-com-fetcher.js
//
// Phase 4.7 (#748): UI5 Demo Kit narrative-docs fetcher.
// Two endpoints (both verified 2026-07-01 via live Playwright inspection):
//   1. GET https://ui5.sap.com/docs/topics/index.json  → hierarchical tree
//      of [{ key, text, links: [...] }] where key is a 32-char hex loio id.
//   2. GET https://ui5.sap.com/docs/topics/<key>.html  → clean per-topic HTML
//      (not the SPA shell) starting with
//      <html><head></head><body><div id="d4h5-main-container">...
//
// Filter rules (spec §4.2.4):
//   - HTTP 200 required on both endpoints
//   - Stripped body >= 200 chars
//   - Title non-empty
//   - Per-topic failure is survivable (log + skip; other topics continue).
//     Failure of the index call itself aborts the source (returns []).
//
// Spec: docs/superpowers/specs/2026-07-01-748-phase4.7-help-docs.md §4.2.4

const SYM = Symbol.for('com.sap.developers.ims.ui5-sap-com-fetcher');
globalThis[SYM] ??= { mockFetcher: null };

const INDEX_URL = 'https://ui5.sap.com/docs/topics/index.json';
const TOPIC_HTML_BASE = 'https://ui5.sap.com/docs/topics';
const CANONICAL_BASE = 'https://ui5.sap.com/#/topic';
const PER_PAGE_TIMEOUT_MS = 30_000;
const DESCRIPTION_MAX_CHARS = 2000;
const MIN_BODY_CHARS = 200;

export function _setMockFetcher(fn) { globalThis[SYM].mockFetcher = fn; }
export function _resetForTests() { globalThis[SYM].mockFetcher = null; }

/**
 * @typedef {Object} HelpDocRow
 * @property {'ui5-sap-com'} source
 * @property {string} sourceId       — 'topic/<key>'
 * @property {string} title
 * @property {string} description    — stripped body first 2000 chars
 * @property {string} url            — https://ui5.sap.com/#/topic/<key>
 * @property {'ui5'} product
 * @property {string|null} section   — immediate parent index entry title, or null
 */

/**
 * Fetch UI5 Demo Kit topics via the internal /docs/topics/* API.
 * Index-fetch failure aborts this source (returns []); per-topic failures
 * are logged and skipped.
 *
 * @param {Object} [opts]
 * @param {Set<string>} [opts.seenSourceIds]
 * @param {number} [opts.limit]
 * @returns {Promise<HelpDocRow[]>}
 */
export async function fetchUi5SapComCorpus({
  seenSourceIds = null,
  limit = null,
} = {}) {
  let index;
  try {
    index = await fetchIndex();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('ui5-sap-com-fetcher: index fetch failed', {
      status: err && err.status, message: err && err.message,
    });
    return [];
  }

  const roots = Array.isArray(index) ? index : [];
  const rows = [];

  // Walk the hierarchical tree. Each node yields { key, title, parentTitle }.
  for (const node of walkIndex(roots, null)) {
    if (limit != null && rows.length >= limit) break;
    if (!node.title || node.title.length === 0) continue;
    if (!node.key) continue;

    const sourceId = `topic/${node.key}`;
    if (seenSourceIds && seenSourceIds.has(sourceId)) continue;

    let bodyHtml;
    try {
      bodyHtml = await fetchTopicBody(node.key);
    } catch (err) {
      console.warn('ui5-sap-com-fetcher: topic body fetch failed', { key: node.key, message: err?.message });
      continue;   // per-topic 404 or timeout — skip
    }
    const stripped = stripHtml(bodyHtml);
    if (stripped.length < MIN_BODY_CHARS) continue;

    rows.push({
      source: 'ui5-sap-com',
      sourceId,
      title: node.title,
      description: stripped.slice(0, DESCRIPTION_MAX_CHARS),
      url: `${CANONICAL_BASE}/${node.key}`,
      product: 'ui5',
      section: node.parentTitle,
    });
  }
  return rows;
}

// Recursively walk the index tree. Yields { key, title, parentTitle } for each node.
function* walkIndex(nodes, parentTitle) {
  for (const n of nodes) {
    // Skip composite keys — they're anchors within a parent doc that's already
    // fetched separately and 404 on /docs/topics/<key>.html (#910).
    if (n.key && n.key.includes('#')) continue;
    yield { key: n.key, title: n.text, parentTitle };
    if (Array.isArray(n.links) && n.links.length > 0) {
      yield* walkIndex(n.links, n.text);
    }
  }
}

async function fetchIndex() {
  const mock = globalThis[SYM].mockFetcher;
  if (mock) return mock(INDEX_URL);
  const res = await fetch(INDEX_URL, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'sap-tutorials-fetch-help-docs' },
    signal: AbortSignal.timeout(PER_PAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`ui5.sap.com index ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function fetchTopicBody(key) {
  const url = `${TOPIC_HTML_BASE}/${key}.html`;
  const mock = globalThis[SYM].mockFetcher;
  if (mock) return mock(url);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'sap-tutorials-fetch-help-docs' },
    signal: AbortSignal.timeout(PER_PAGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`ui5.sap.com topic ${res.status} for ${key}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

function stripHtml(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
