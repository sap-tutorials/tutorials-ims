// srv/lib/seed-category-descriptions.js
//
// Idempotent, NON-DESTRUCTIVE boot-seed for Category.seedDescription.
//
// Categories.csv ships ID/slug/label/sortOrder only — the admin-editable
// seedDescription column is deliberately absent (a CSV column would
// full-replace admin edits on every deploy; see CLAUDE.md "CSV changes wipe
// admin-editable columns"). So the baseline seed texts live in
// ./category-seed-descriptions-defaults.js and are applied here, filling ONLY
// rows whose seedDescription is currently empty/null. Rows an author has
// already edited (non-empty) are never touched.
//
// Called from:
//   - srv/server.js  cds.on('served')  (guarded by globalThis sentinel + VITEST gate)
//   - test/unit + test/hybrid           (via dynamic import, passing a db override)

import cds from '@sap/cds';
import { CATEGORY_SEED_DESCRIPTIONS } from './category-seed-descriptions-defaults.js';

const NAMESPACE = 'com.sap.developers.ims';

/**
 * Seed missing Category.seedDescription values idempotently.
 *
 * @param {object} [dbOverride] — already-connected cds db (tests). When omitted,
 *   connects via cds.connect.to('db').
 * @returns {Promise<{updated: number, total: number}>}
 *   updated = rows whose empty seedDescription we filled this run
 *   total   = category rows examined
 */
export async function seedCategoryDescriptions(dbOverride) {
  const db = dbOverride ?? await cds.connect.to('db');

  // Resolve Categories robustly across contexts (booted server / cds.test →
  // cds.entities() installed; standalone `cds bind --exec` → model not linked
  // into globals, so load+link). Same gotcha as seed-poc-puzzle.js.
  let Categories;
  if (typeof cds.entities === 'function' && cds.model) {
    ({ Categories } = cds.entities(NAMESPACE));
  } else {
    const linked = cds.linked(await cds.load('*'));
    ({ Categories } = linked.entities(NAMESPACE));
  }

  // Explicit columns: a bare SELECT emits `SELECT *`, which HANA cannot infer
  // when the entity comes from a separately-linked model (standalone path).
  const rows = await db.run(
    SELECT.from(Categories).columns('ID', 'slug', 'seedDescription')
  );

  let updated = 0;
  for (const row of rows) {
    const seed = CATEGORY_SEED_DESCRIPTIONS[row.slug];
    if (!seed) continue;                                   // slug not in defaults → leave alone
    const current = (row.seedDescription ?? '').trim();
    if (current) continue;                                 // author-authored / already seeded → preserve
    await db.run(
      UPDATE(Categories).set({ seedDescription: seed }).where({ ID: row.ID })
    );
    updated++;
  }

  return { updated, total: rows.length };
}
