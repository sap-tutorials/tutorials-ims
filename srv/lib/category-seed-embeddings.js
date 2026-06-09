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

/** Drop one entry (sync); next getSeedEmbeddings() call recomputes only it. */
export function invalidateSeedEmbedding(categoryId) {
  if (!_cache) return; // not loaded yet — nothing to do
  _cache.delete(categoryId);
  _stale.add(categoryId);
}

/** Embed an ad-hoc piece of text (used for missions/groups/uncached tutorials). */
export async function embedAdHoc(text) {
  if (!text || !text.trim()) {
    throw new Error('embedAdHoc: empty text');
  }
  const [vec] = await embed([text]);
  return vec;
}
