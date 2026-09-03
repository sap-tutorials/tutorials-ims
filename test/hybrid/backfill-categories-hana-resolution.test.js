import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

// Runs against real HANA via `cds bind --exec` + the hybrid profile.
// The seed is non-destructive (fills only empty seedDescription); still gated
// behind isSafeForWrites() so it can never touch a prod container.
const RUN = process.env.HYBRID_TESTS === 'true' && isSafeForWrites();

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const NS = 'com.sap.developers.ims';

(RUN ? describe : describe.skip)('hybrid: category backfill entity resolution against real HANA', () => {
  // The backfill (scripts/backfill-categories.cjs) and classifier persist()
  // regressed because they queried bare short-name strings ('Tutorials',
  // 'TutorialCategories'), which resolve on local SQLite but emit bare
  // TUTORIALS / TUTORIALCATEGORIES SQL against HANA (real tables are
  // COM_SAP_DEVELOPERS_IMS_*). The fix resolves entity OBJECTS via a linked
  // model. This test drives that exact load+link path (the standalone
  // `cds bind --exec` branch, where cds.model is unset) against real HANA.

  it('load+link resolution reaches the namespaced HANA tables (no "table not found")', async () => {
    const db = await cds.connect.to('db');
    const linked = cds.linked(await cds.load('*'));
    const ents = linked.entities(NS);

    for (const name of ['Tutorials', 'Missions', 'Groups', 'TutorialCategories', 'MissionCategories', 'GroupCategories']) {
      const ent = ents[name];
      expect(ent, `${name} must resolve from the linked model`).toBeTruthy();
      // Fully-qualified so the emitted SQL targets COM_SAP_DEVELOPERS_IMS_<NAME>,
      // not a bare unqualified table.
      expect(ent.name).toBe(`${NS}.${name}`);
      // The real assertion: a resolved-object SELECT executes on HANA. A bare
      // short-name string here would throw "Could not find table/view <NAME>".
      await expect(
        db.run(SELECT.from(ent).columns('ID').limit(1)),
      ).resolves.toBeDefined();
    }
  });

  it('seedCategoryDescriptions runs against real HANA and leaves all seeds populated', async () => {
    const { seedCategoryDescriptions } = await import('../../srv/lib/seed-category-descriptions.js');
    const { CATEGORY_SEED_DESCRIPTIONS } = await import('../../srv/lib/category-seed-descriptions-defaults.js');
    const db = await cds.connect.to('db');

    const res = await seedCategoryDescriptions(db);
    expect(res.total).toBeGreaterThan(0);
    expect(res.updated).toBeGreaterThanOrEqual(0); // may already be seeded from a prior run

    // Non-destructive + idempotent: after seeding, every category that has a
    // default must carry a non-empty seedDescription, and a second run is a no-op.
    const { Categories } = cds.linked(await cds.load('*')).entities(NS);
    const rows = await db.run(SELECT.from(Categories).columns('slug', 'seedDescription'));
    for (const row of rows) {
      if (CATEGORY_SEED_DESCRIPTIONS[row.slug]) {
        expect((row.seedDescription ?? '').trim().length).toBeGreaterThan(0);
      }
    }
    const again = await seedCategoryDescriptions(db);
    expect(again.updated).toBe(0);
  });
});
