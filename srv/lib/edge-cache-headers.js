import cds from '@sap/cds';
import { isFlagEnabled } from './feature-flags/db-flags.js';

// Shared Cache-Control / edge-cache-tag helper for the public content-serving
// paths (tutorials, group/mission catalog pages, concepts index). A CDN
// (Akamai) fronts the public domain — see test/smoke/security-headers.test.js.
//
// The value splits the *browser* TTL from the *shared-edge* TTL:
//   - max-age (browser): short (60s), so a hard refresh picks up a new publish fast.
//   - s-maxage (edge):   the shared-edge TTL is COUPLED to whether an active
//                        purge-by-tag signal exists (EDGE_PURGE_ENABLED / the
//                        Akamai Fast-Purge hook in srv/lib/fast-purge.js):
//                          * flag OFF  → 600s (10 min). With no purge, the edge
//                            TTL is the ONLY thing bounding post-publish
//                            staleness, so it stays short (worst-case ~10 min).
//                          * flag ON   → 86400s (1 day). A publish now issues a
//                            targeted purge-by-tag within seconds, so the long
//                            TTL is safe and offloads scraper/bot floods to the
//                            edge instead of HANA.
//                        Coupling them means we can never raise the staleness
//                        ceiling without a purge mechanism in place to bound it.
//   - stale-while-revalidate: serve the stale copy instantly while the edge
//                        revalidates in the background.
//
// The Edge-Cache-Tag header below drives that purge-by-tag hook (see
// fast-purge.js — it maps freshly published slugs to their item-<slug> tags).
//
// Only call setContentCacheHeaders on 200 content responses — never on
// redirects, 404s, or the no-cache delta/drift probes.

// Base (flag-off) value — kept as the exported constant for tests/importers.
const CONTENT_CACHE_CONTROL =
  'public, max-age=60, s-maxage=600, stale-while-revalidate=600';

// Long shared-edge TTL applied only when EDGE_PURGE_ENABLED is on.
const CONTENT_CACHE_CONTROL_PURGE =
  'public, max-age=60, s-maxage=86400, stale-while-revalidate=600';

const LOG = cds.log('edge-cache');

// Effective Cache-Control for a cacheable content response. Fail-open: any
// fault reading the flag falls back to the short-TTL base value (never the long
// TTL — a stale-ceiling regression must never be the failure mode).
function effectiveCacheControl() {
  try {
    return isFlagEnabled('EDGE_PURGE_ENABLED') ? CONTENT_CACHE_CONTROL_PURGE : CONTENT_CACHE_CONTROL;
  } catch {
    return CONTENT_CACHE_CONTROL;
  }
}

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
    res.setHeader('Cache-Control', effectiveCacheControl());
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Edge-Cache-Tag', cacheTagsFor(slug).join(', '));
  } catch (err) {
    LOG.warn('failed to set edge cache headers:', err?.message ?? err);
  }
}

export { CONTENT_CACHE_CONTROL, cacheTagsFor, setContentCacheHeaders };
