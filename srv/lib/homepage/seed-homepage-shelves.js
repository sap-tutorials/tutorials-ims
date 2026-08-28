// srv/lib/homepage/seed-homepage-shelves.js
//
// Idempotent, NON-DESTRUCTIVE seed for the HomepageShelves table.
//
// Runs from cds.on('served') (srv/server.js) on every boot, in every profile
// (dev cds watch, unit tests via cds.test, hybrid, production). Inserts ONLY
// the baseline (verb,url) rows that are missing — it never updates or deletes
// existing rows, so admin edits made at /admin-ui/#homepage are preserved and a
// deploy can never full-replace the table.
//
// This replaces two fragile mechanisms:
//   1. the test/data seed CSV, which compiled to an .hdbtabledata with
//      include_filter:[] and full-replaced the table on every deploy whose CSV
//      hash changed (the pre-#1404c4c4 data-loss bug), and
//   2. the manual, DEV/PROD-ambiguous `npm run seed:thirdparty` promotion step.
//
// Single source of truth: ./homepage-shelves-defaults.js.

import cds from '@sap/cds';
import { HOMEPAGE_SHELVES_DEFAULTS } from './homepage-shelves-defaults.js';

const NAMESPACE = 'com.sap.developers.ims';

export async function seedHomepageShelves(dbOverride) {
  const db = dbOverride ?? (await cds.connect.to('db'));
  // Reflect the entity via cds.linked so CQL is type-aware and serializes the
  // personaTags/personaHidden arrays to JSON for the HANA NCLOB columns.
  // (cds.entities is undefined in a standalone context; a fully-qualified
  // string name is not type-aware and fails on HANA for the array columns.)
  const linked = cds.linked(cds.model ?? (await cds.load('*')));
  const { HomepageShelves } = linked.entities(NAMESPACE);

  const existing = await db.run(
    SELECT.from(HomepageShelves).columns('verb', 'url'),
  );
  const have = new Set(existing.map((r) => `${r.verb}|${r.url}`));
  const missing = HOMEPAGE_SHELVES_DEFAULTS.filter(
    (r) => !have.has(`${r.verb}|${r.url}`),
  );

  if (missing.length > 0) {
    await db.run(INSERT.into(HomepageShelves).entries(missing));
  }
  return { inserted: missing.length, total: HOMEPAGE_SHELVES_DEFAULTS.length };
}
