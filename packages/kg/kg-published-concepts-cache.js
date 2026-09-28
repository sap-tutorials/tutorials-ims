// srv/lib/kg-published-concepts-cache.js
//
// #1182 — bust helper for the @cache pilot on
// KnowledgeGraphService.PublishedConceptsWithAliases (the ⌘K palette concept
// search). Structural twin of kg-neighborhood-cache.js: the @cache annotation
// owns TTL + storage; this module owns the write-driven invalidation.
//
// The annotation tags every entry PUBLISHED_CONCEPTS_TAG; bustPublishedConceptsCache()
// is a single deleteByTag() called from the existing KG Concepts CRUD +
// publishConcept/unpublishConcept after-write handlers in srv/server.js.
//
// Fail-open: a bust fault is logged and swallowed — stale entries then expire
// via the annotation's TTL. A caching hiccup must never break a concept write.
import cds from '@sap/cds';

export const PUBLISHED_CONCEPTS_TAG = 'kg-published-concepts';

let _cachePromise;
function cache() {
  if (!_cachePromise) _cachePromise = cds.connect.to('caching');
  return _cachePromise;
}

/**
 * Bust every PublishedConceptsWithAliases @cache entry via the shared tag.
 * Called from the KG write hooks after a concept publish/unpublish/edit.
 * Fail-open: logs and returns on any fault; TTL is the backstop.
 */
export async function bustPublishedConceptsCache() {
  try {
    const c = await cache();
    await c.deleteByTag(PUBLISHED_CONCEPTS_TAG);
  } catch (err) {
    cds.log('kg-published-concepts-cache').warn(
      `bust failed, relying on TTL: ${err.message}`,
    );
  }
}

/** Test seam: clear the memoized connect promise between suites. */
export function _resetConnection() {
  _cachePromise = undefined;
}
