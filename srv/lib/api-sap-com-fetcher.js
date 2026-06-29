// srv/lib/api-sap-com-fetcher.js
//
// Phase 4.5 (#746): corpus fetcher for api.sap.com.
//
// PROBE_FAILURE branch: the api.sap.com discovery probe (Plan Task 1
// Step 1, recorded in docs/superpowers/plans/2026-06-29-746-api-sap-com-probe-results.md)
// found no usable public discovery endpoint. This module operates in
// YAML-only mode: the cron passes a yamlFallbackLoader that reads
// db/data/api-docs.yaml. _setMockFetcher remains as a test seam so a
// future PROBE_SUCCESS retrofit can wire HTTP mode without rewriting
// the contract.
//
// Spec: docs/superpowers/specs/2026-06-29-746-phase4.5-api-docs.md §4.3 + §7.4

const SYM = Symbol.for('com.sap.developers.ims.api-sap-com-fetcher');
globalThis[SYM] ??= { mockFetcher: null };

/** Test seam — inject a function that returns a parsed JSON page. */
export function _setMockFetcher(fn) {
  globalThis[SYM].mockFetcher = fn;
}

/** Test seam — clear state between tests. */
export function _resetForTests() {
  globalThis[SYM].mockFetcher = null;
}

/**
 * @typedef {Object} ApiDocCorpusRow
 * @property {string} sourceId
 * @property {string} title
 * @property {string} description
 * @property {string} url
 * @property {string} category
 * @property {string} apiType
 */

/**
 * Discover api.sap.com packages. In the PROBE_FAILURE branch, HTTP mode
 * is a stub — the canonical path is the YAML fallback supplied by the
 * caller. If a test injects a mockFetcher, we use it (so a future
 * PROBE_SUCCESS retrofit can exercise HTTP-shaped logic without
 * rewriting this module's signature).
 *
 * @param {Object} [opts]
 * @param {Set<string>} [opts.seenSourceIds] — skip these (cron's per-cycle filter)
 * @param {number} [opts.limit] — total row cap (default 5000)
 * @param {Function} [opts.yamlFallbackLoader] — async () => ApiDocCorpusRow[]; canonical source in YAML-only mode
 * @returns {Promise<ApiDocCorpusRow[]>}
 */
export async function fetchApiSapComCorpus({
  seenSourceIds = null,
  limit = 5000,
  yamlFallbackLoader = null,
} = {}) {
  // PROBE_FAILURE branch: HTTP mode is stub. YAML is canonical.
  // If a test injects a mockFetcher, use it (so future PROBE_SUCCESS
  // retrofit tests can exercise HTTP-shaped logic).
  const mock = globalThis[SYM].mockFetcher;
  if (mock) {
    try {
      const page = await mock(null);
      const items = Array.isArray(page?.items) ? page.items : [];
      return filterAndLimit(items, seenSourceIds, limit);
    } catch (err) {
      if (yamlFallbackLoader) return filterAndLimit(await yamlFallbackLoader(), seenSourceIds, limit);
      throw err;
    }
  }
  if (!yamlFallbackLoader) {
    throw new Error('api-sap-com-fetcher: YAML-only mode requires a yamlFallbackLoader');
  }
  const yamlRows = await yamlFallbackLoader();
  return filterAndLimit(yamlRows, seenSourceIds, limit);
}

function filterAndLimit(items, seenSourceIds, limit) {
  const out = [];
  for (const item of items) {
    if (out.length >= limit) break;
    if (seenSourceIds && seenSourceIds.has(item.sourceId)) continue;
    out.push(item);
  }
  return out;
}
