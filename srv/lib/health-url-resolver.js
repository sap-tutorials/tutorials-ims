import cds from '@sap/cds';
import { toAbsoluteUrl, resolvePublicBaseUrl } from './link-health-core.js';

const NS = 'com.sap.developers.ims';

/**
 * Build the canonical public URL for a content entity.
 *
 * - Lowercases the slug (slugs are lowercase-canonical per project convention).
 * - TUTORIAL → <base>/tutorials/<slug>/
 * - MISSION  → <base>/missions/<slug>/
 * - GROUP    → <base>/tutorials/group-<slug>
 * - Returns null for a falsy slug or an unknown kind.
 *
 * @param {{ kind: string, slug: string }} entity
 * @param {string} baseUrl
 * @returns {string|null}
 */
export function resolveEntityUrl({ kind, slug }, baseUrl) {
  const s = (slug || '').toLowerCase();
  if (!s) return null;
  let path;
  if (kind === 'TUTORIAL') path = `/tutorials/${s}/`;
  else if (kind === 'MISSION') path = `/missions/${s}/`;
  else if (kind === 'GROUP') path = `/tutorials/group-${s}`;
  else return null;
  return toAbsoluteUrl(path, baseUrl);
}

/**
 * Collect all content entities that should have their public URL probed.
 *
 * Selects:
 *   - All ACTIVE tutorials (status == null || 'ACTIVE')
 *   - Published + ACTIVE missions
 *   - Published + ACTIVE groups
 *
 * De-duplicates the result by URL so that slug collisions (which violate the
 * DB unique constraint but can occur transiently) produce exactly one probe.
 *
 * @param {import('@sap/cds').DatabaseService} db
 * @returns {Promise<Array<{
 *   kind: 'TUTORIAL'|'MISSION'|'GROUP',
 *   legacyId: number,
 *   slug: string,
 *   url: string,
 *   override: string|null
 * }>>}
 */
export async function collectHealthTargets(db) {
  const { Tutorials, Missions, Groups } = cds.entities(NS);
  const baseUrl = await resolvePublicBaseUrl(db);

  // "active" condition: status is null or 'ACTIVE'.
  // Use the string form (consistent with build-catalog.js, featured-resolve.js,
  // build-topic-cluster-content.js) because the object { or: [...] } spread form
  // is not reliably supported by the CQL builder across SQLite + HANA.
  const activeWhere = `status = 'ACTIVE' or status is null`;

  const tuts = await db.run(
    SELECT.from(Tutorials)
      .columns('legacyId', 'slug', 'linkStatusOverride')
      .where(activeWhere),
  );

  const missions = await db.run(
    SELECT.from(Missions)
      .columns('legacyId', 'slug', 'linkStatusOverride')
      .where({ published: true })
      .and(activeWhere),
  );

  const groups = await db.run(
    SELECT.from(Groups)
      .columns('legacyId', 'slug', 'linkStatusOverride')
      .where({ published: true })
      .and(activeWhere),
  );

  const rows = [
    ...tuts.map(r => ({ kind: 'TUTORIAL', ...r })),
    ...missions.map(r => ({ kind: 'MISSION', ...r })),
    ...groups.map(r => ({ kind: 'GROUP', ...r })),
  ];

  // De-duplicate by resolved URL (first occurrence wins).
  const byUrl = new Map();
  for (const r of rows) {
    const url = resolveEntityUrl({ kind: r.kind, slug: r.slug }, baseUrl);
    if (!url || byUrl.has(url)) continue;
    byUrl.set(url, {
      kind: r.kind,
      legacyId: r.legacyId,
      slug: r.slug,
      url,
      override: r.linkStatusOverride ?? null,
    });
  }

  return [...byUrl.values()];
}
