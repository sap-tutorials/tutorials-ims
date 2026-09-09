//
// Single source of truth for the product-tag → Semaphore-ID mapping used to
// emit <meta name="sm_tech_ids"> tags for the site-search crawler.
//
// - getSemaphoreMdMap(db): build-time map keyed by mdFormat (joins to Hugo
//   frontmatter tag slugs the same way /build/tags does).
// - formatSmTechIds(ids, locale): the exact meta `content` string.
//
// Fail-open: callers treat an empty map / '' as "emit nothing".

import { titlePathToMdFormat } from './tag-md-format.js';

const TAGS = 'com.sap.developers.ims.Tags';

// Product-tag semaphore IDs keyed by mdFormat slug. Mirrors /build/tags:
// raw entity-name SELECT + JS-side titlePathToMdFormat + dedupe. Last-write-
// wins on a duplicate mdFormat (deterministic, matches the /build/tags set).
export async function getSemaphoreMdMap(db) {
  const rows = await db.run(
    SELECT.from(TAGS).columns('titlePath', 'semaphoreId', 'isActualTag').where({ isActualTag: true }),
  );
  const map = {};
  for (const r of rows) {
    if (r.semaphoreId === null || r.semaphoreId === undefined || r.semaphoreId === '') continue;
    const md = titlePathToMdFormat(r.titlePath);
    if (!md) continue;
    map[md] = String(r.semaphoreId);
  }
  return map;
}

// The meta `content` value: locale first, then de-duped IDs (first-seen
// order), comma-joined, no spaces. Empty/nullish list → '' (caller emits
// no tag).
export function formatSmTechIds(ids, locale = 'en-US') {
  if (!Array.isArray(ids) || ids.length === 0) return '';
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    const s = String(id ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  if (out.length === 0) return '';
  return `${locale},${out.join(',')}`;
}
