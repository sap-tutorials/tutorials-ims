// srv/lib/category-seed-embeddings.js
//
// In-memory cache of category seed embeddings. Lazy: populates on first
// `getSeedEmbeddings()` call; entries invalidated by ID on
// `seedDescription` edits (called from the Categories OData UPDATE
// after-hook). `embedAdHoc(text)` is the helper used by the classifier
// to embed missions/groups (which don't have a persistent embedding row)
// and tutorials whose TutorialEmbedding row is missing.
//
// Why no persistent column on Categories.seedEmbedding:
//   - 8 rows, recomputable, ~1.5KB Float32Array per row
//   - Saves a LOB churn on every seedDescription edit
//   - Boot cost is paid lazily on first classify, not on cds boot
//
// Threading note: `getSeedEmbeddings()` is async and re-entrant. If two
// classify calls race the first load, both see the in-flight Promise via
// `_loadingPromise`, so only one batch embed call goes out.

import cds from '@sap/cds';
import { embed } from './embedding-client.js';

const LOG = cds.log('category-seed-embeddings');
let _cache = null;            // Map<categoryId, Float32Array> | null
let _stale = new Set();       // IDs marked invalid; recomputed on next getSeedEmbeddings()
let _loadingPromise = null;   // Promise<Map> | null — in-flight loader

/** Test-only — resets module state between tests. */
export function _resetCache() {
  _cache = null;
  _stale = new Set();
  _loadingPromise = null;
}

/**
 * Load and embed every Category with a non-empty `seedDescription` in one
 * batch. Categories without a seed are absent from the returned Map — the
 * classifier falls back to LLM-only for them.
 */
async function loadAll() {
  const { Categories } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(Categories).columns('ID', 'seedDescription');
  const usable = rows.filter(r => r.seedDescription && r.seedDescription.trim().length > 0);
  if (usable.length === 0) {
    LOG.warn('No categories with seedDescription found — classifier will fall back to LLM for everything');
    return new Map();
  }
  const vectors = await embed(usable.map(r => r.seedDescription));
  const m = new Map();
  for (let i = 0; i < usable.length; i++) {
    m.set(usable[i].ID, vectors[i]);
  }
  return m;
}

/**
 * Refresh `_cache` entries for the given IDs from a fresh embed call.
 *
 * Fetches all Categories rows and filters in JS by `staleIds` rather than
 * chaining a `.where()` after `.columns()` — the CDS QL builder rejects
 * that method order. The extra row read is trivial (Categories has ≤8 rows).
 *
 * Silently no-ops if none of the stale IDs still have a non-empty
 * `seedDescription` (row deleted or seed cleared while stale).
 */
async function recomputeStale(staleIds) {
  // Fetch all rows and filter in JS — avoids chaining .where() after
  // .columns() which the CDS QL builder doesn't support in that order.
  const { Categories } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(Categories).columns('ID', 'seedDescription');
  const targets = rows.filter(r => staleIds.has(r.ID) && r.seedDescription && r.seedDescription.trim().length > 0);
  if (targets.length === 0) return;
  const vectors = await embed(targets.map(r => r.seedDescription));
  for (let i = 0; i < targets.length; i++) {
    _cache.set(targets[i].ID, vectors[i]);
  }
}

/**
 * Get the `categoryId → Float32Array` seed-embedding map, populating lazily.
 *
 * Three states:
 *   - Not loaded and no load in flight → start the load, remember the
 *     Promise in `_loadingPromise`, return it.
 *   - Not loaded but a load IS in flight → return the same Promise (racing
 *     classify calls share one AI Core call).
 *   - Loaded → if any IDs are marked stale, refresh only those before
 *     returning the cache.
 *
 * `_loadingPromise` is cleared in the loader's `finally` so a failed first
 * load doesn't wedge the module — the next call retries.
 *
 * @returns {Promise<Map<string, Float32Array>>}
 */
export async function getSeedEmbeddings() {
  if (!_cache) {
    if (_loadingPromise) return _loadingPromise;
    _loadingPromise = (async () => {
      try {
        _cache = await loadAll();
        _stale = new Set();
        return _cache;
      } finally {
        _loadingPromise = null;
      }
    })();
    return _loadingPromise;
  }
  // Cache exists — check for stale entries and recompute them.
  if (_stale.size > 0) {
    const toRecompute = new Set(_stale);
    _stale = new Set();
    await recomputeStale(toRecompute);
  }
  return _cache;
}

/**
 * Drop one entry (sync); next `getSeedEmbeddings()` call recomputes only it.
 * No-op if the cache isn't populated yet — a subsequent first-load will pick
 * up the current DB state anyway, so there's nothing to invalidate.
 *
 * Called from the Categories OData UPDATE after-hook when `seedDescription`
 * changes.
 */
export function invalidateSeedEmbedding(categoryId) {
  if (!_cache) return; // not loaded yet — nothing to do
  _cache.delete(categoryId);
  _stale.add(categoryId);
}

/**
 * Embed a single ad-hoc string. Used to embed missions/groups (which have
 * no persistent embedding row) and uncached tutorials at classify time.
 *
 * Throws on empty input — unlike `getSeedEmbeddings()`, this is a
 * fire-and-return path where empty text is a programmer error.
 *
 * @param {string} text
 * @returns {Promise<Float32Array>}
 */
export async function embedAdHoc(text) {
  if (!text || !text.trim()) {
    throw new Error('embedAdHoc: empty text');
  }
  const [vec] = await embed([text]);
  return vec;
}
