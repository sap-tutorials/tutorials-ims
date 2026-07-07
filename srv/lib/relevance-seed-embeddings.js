// srv/lib/relevance-seed-embeddings.js
//
// In-memory cache of RelevanceSeedExemplars embeddings, grouped by label.
// Modeled after category-seed-embeddings.js — same lazy-load + in-flight-
// promise-sharing + per-ID staleness pattern. (#1034)

import cds from '@sap/cds';
import { embed } from './embedding-client.js';

const LOG = cds.log('relevance-seed-embeddings');

/** Map<seedId, { label: 'relevant'|'not-relevant', vec: Float32Array, text: string }> */
let _cache = null;
let _stale = new Set();
let _loadingPromise = null;

/** Test-only — resets module state between tests. */
export function _resetCacheForTests() {
  _cache = null;
  _stale = new Set();
  _loadingPromise = null;
}

/**
 * Load and embed every active RelevanceSeedExemplars row with non-empty text
 * in one batch. Returns a Map<id, { label, vec, text }>.
 */
async function loadAll() {
  const { RelevanceSeedExemplars } = cds.entities('com.sap.developers.ims.external');
  const rows = await SELECT.from(RelevanceSeedExemplars)
    .columns('ID', 'label', 'text', 'active')
    .where({ active: true });
  const usable = rows.filter(r => r.text && r.text.trim().length > 0);
  if (usable.length === 0) {
    LOG.warn('No active RelevanceSeedExemplars — classifier will fall back to keyword rules');
    return new Map();
  }
  const vectors = await embed(usable.map(r => r.text));
  const m = new Map();
  for (let i = 0; i < usable.length; i++) {
    m.set(usable[i].ID, { label: usable[i].label, vec: vectors[i], text: usable[i].text });
  }
  return m;
}

/**
 * Refresh _cache entries for the given IDs from a fresh embed call.
 *
 * Fetches all active rows and filters in JS by staleIds — avoids chaining
 * .where() after .columns() which the CDS QL builder rejects. The extra row
 * read is trivial (table has ≤20 rows in practice).
 *
 * Silently no-ops if none of the stale IDs still have a non-empty text
 * (row deleted or cleared while stale).
 */
async function recomputeStale(staleIds) {
  const { RelevanceSeedExemplars } = cds.entities('com.sap.developers.ims.external');
  const rows = await SELECT.from(RelevanceSeedExemplars)
    .columns('ID', 'label', 'text', 'active')
    .where({ active: true });
  const targets = rows.filter(r =>
    staleIds.has(r.ID) && r.text && r.text.trim().length > 0);
  if (targets.length === 0) return;
  const vectors = await embed(targets.map(r => r.text));
  for (let i = 0; i < targets.length; i++) {
    _cache.set(targets[i].ID, { label: targets[i].label, vec: vectors[i], text: targets[i].text });
  }
}

/**
 * Build { relevant, notRelevant } arrays from the current cache map.
 */
function groupByLabel(map) {
  const relevant = [];
  const notRelevant = [];
  for (const { label, vec } of map.values()) {
    if (label === 'relevant') relevant.push(vec);
    else if (label === 'not-relevant') notRelevant.push(vec);
  }
  return { relevant, notRelevant };
}

/**
 * Get the cached seed embeddings grouped by label.
 * Racing callers share the in-flight promise — only one embed batch goes out.
 *
 * Three states:
 *   - Not loaded and no load in flight → start load, remember Promise in
 *     _loadingPromise, return it.
 *   - Not loaded but a load IS in flight → return the same Promise.
 *   - Loaded → if any IDs are stale, refresh only those, then return result.
 *
 * _loadingPromise is cleared in the loader's `finally` so a failed first load
 * doesn't wedge the module — the next call retries.
 *
 * @returns {Promise<{ relevant: Float32Array[], notRelevant: Float32Array[] }>}
 */
export async function getSeedEmbeddings() {
  if (!_cache) {
    if (_loadingPromise) return _loadingPromise;
    _loadingPromise = (async () => {
      try {
        _cache = await loadAll();
        _stale = new Set();
        return groupByLabel(_cache);
      } finally {
        _loadingPromise = null;
      }
    })();
    return _loadingPromise;
  }
  if (_stale.size > 0) {
    const toRecompute = new Set(_stale);
    _stale = new Set();
    await recomputeStale(toRecompute);
  }
  return groupByLabel(_cache);
}

/**
 * Mark one entry stale (sync). Next getSeedEmbeddings() call recomputes only it.
 * No-op if the cache isn't populated yet — a subsequent first-load will pick
 * up the current DB state anyway.
 *
 * Called by the content-moderation-service after-UPDATE handler when a seed's
 * text changes.
 *
 * @param {string} id  UUID of the RelevanceSeedExemplars row that changed
 */
export function invalidateSeed(id) {
  if (!_cache) return; // not loaded yet — nothing to do
  _cache.delete(id);
  _stale.add(id);
}
