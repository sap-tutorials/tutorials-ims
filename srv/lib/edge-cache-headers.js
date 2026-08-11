import cds from '@sap/cds';

// Shared Cache-Control / edge-cache-tag helper for the public content-serving
// paths (tutorials, group/mission catalog pages, concepts index). A CDN
// (Akamai) fronts the public domain — see test/smoke/security-headers.test.js.
//
// The value splits the *browser* TTL from the *shared-edge* TTL:
//   - max-age (browser): short, so a hard refresh picks up a new publish fast.
//   - s-maxage (edge):   long, because a publish issues a targeted purge-by-tag
//                        (see docs/developers/architecture/cdn-caching.md), so
//                        the edge can safely hold content for a day.
//   - stale-while-revalidate: serve the stale copy instantly while the edge
//                        revalidates in the background.
//
// Only call setContentCacheHeaders on 200 content responses — never on
// redirects, 404s, or the no-cache delta/drift probes.
const CONTENT_CACHE_CONTROL =
  'public, max-age=60, s-maxage=86400, stale-while-revalidate=600';

const LOG = cds.log('edge-cache');

// Sanitize a slug into a valid Cache-Tag token (Akamai tags are alnum + [-_],
// capped in length). Never let an unbounded/exotic slug produce a malformed
// header value.
function tagToken(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128);
}

// Build the Edge-Cache-Tag set for a served content response so a publish can
// purge by tag instead of enumerating URLs. Every response carries the coarse
// `content` tag (full-corpus purge); slugs additionally get a per-item tag and,
// for catalog/concept pages, a kind tag.
function cacheTagsFor(slug) {
  const tags = ['content'];
  if (!slug) return tags;
  if (slug.startsWith('group-')) {
    tags.push('group', `item-${tagToken(slug)}`);
  } else if (slug.startsWith('mission-')) {
    tags.push('mission', `item-${tagToken(slug)}`);
  } else if (slug === 'concepts') {
    tags.push('concepts-index');
  } else if (slug.startsWith('concept-')) {
    tags.push('concepts', `concept-${tagToken(slug.slice('concept-'.length))}`);
  } else if (slug.startsWith('page-')) {
    // Content pages (#1659) — coarse `page` tag + a per-page tag so a publish
    // can purge one page or the whole page set.
    tags.push('page', `page-${tagToken(slug.slice('page-'.length))}`);
  } else {
    tags.push(`item-${tagToken(slug)}`);
  }
  return tags;
}

// Apply the shared cacheable-content headers: Cache-Control (split browser/edge
// + SWR), Vary: Accept-Encoding (so the edge keys gzip/br/identity correctly),
// and Edge-Cache-Tag (for purge-by-tag). Fail-open — a header fault must never
// break content serving.
function setContentCacheHeaders(res, { slug } = {}) {
  try {
    res.setHeader('Cache-Control', CONTENT_CACHE_CONTROL);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Edge-Cache-Tag', cacheTagsFor(slug).join(', '));
  } catch (err) {
    LOG.warn('failed to set edge cache headers:', err?.message ?? err);
  }
}

export { CONTENT_CACHE_CONTROL, cacheTagsFor, setContentCacheHeaders };
