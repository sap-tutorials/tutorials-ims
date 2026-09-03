import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { seedCategoryDescriptions } from '../../srv/lib/seed-category-descriptions.js';
import { CATEGORY_SEED_DESCRIPTIONS } from '../../srv/lib/category-seed-descriptions-defaults.js';

cds.test('serve', '--project', '.', '--in-memory');

// NOTE: the boot seed (srv/server.js) is VITEST-gated, so category
// seedDescriptions are NOT auto-filled here — every test drives
// seedCategoryDescriptions(db) explicitly. Categories rows themselves come from
// db/data/com.sap.developers.ims-Categories.csv (ID/slug/label/sortOrder), which
// loads into the in-memory DB; their seedDescription starts null.

describe('CATEGORY_SEED_DESCRIPTIONS (defaults integrity)', () => {
  it('has non-empty descriptions and keys match the shipped category slugs', async () => {
    const db = await cds.connect.to('db');
    const { Categories } = cds.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(Categories).columns('slug'));
    const csvSlugs = new Set(rows.map((r) => r.slug));

    const defaultSlugs = Object.keys(CATEGORY_SEED_DESCRIPTIONS);
    expect(defaultSlugs.length).toBe(rows.length); // one default per shipped category
    for (const slug of defaultSlugs) {
      expect(csvSlugs.has(slug), `default slug '${slug}' not in Categories.csv`).toBe(true);
      const text = CATEGORY_SEED_DESCRIPTIONS[slug];
      expect(typeof text).toBe('string');
      expect(text.trim().length).toBeGreaterThan(40); // rich enough to embed
    }
  });
});

describe('seedCategoryDescriptions (idempotent, non-destructive boot seed)', () => {
  let db;
  let Categories;
  beforeAll(async () => {
    db = await cds.connect.to('db');
    ({ Categories } = cds.entities('com.sap.developers.ims'));
  });

  it('fills every empty seedDescription on first run', async () => {
    const res = await seedCategoryDescriptions(db);
    expect(res.total).toBe(Object.keys(CATEGORY_SEED_DESCRIPTIONS).length);
    expect(res.updated).toBe(res.total); // all started empty

    const rows = await db.run(SELECT.from(Categories).columns('slug', 'seedDescription'));
    for (const row of rows) {
      expect(row.seedDescription).toBe(CATEGORY_SEED_DESCRIPTIONS[row.slug]);
    }
  });

  it('is idempotent — a second run updates nothing', async () => {
    const res = await seedCategoryDescriptions(db);
    expect(res.updated).toBe(0);
  });

  it('never overwrites an admin-edited seedDescription', async () => {
    const edited = 'ADMIN EDITED SEED — do not clobber';
    const target = Object.keys(CATEGORY_SEED_DESCRIPTIONS)[0];
    await db.run(UPDATE(Categories).set({ seedDescription: edited }).where({ slug: target }));

    const res = await seedCategoryDescriptions(db);
    expect(res.updated).toBe(0); // nothing empty → nothing changed

    const row = await db.run(
      SELECT.one.from(Categories).columns('seedDescription').where({ slug: target }),
    );
    expect(row.seedDescription).toBe(edited); // untouched
  });

  it('re-seeds a description that was cleared back to empty (self-heals)', async () => {
    const target = Object.keys(CATEGORY_SEED_DESCRIPTIONS)[1];
    await db.run(UPDATE(Categories).set({ seedDescription: '' }).where({ slug: target }));

    const res = await seedCategoryDescriptions(db);
    expect(res.updated).toBe(1);

    const row = await db.run(
      SELECT.one.from(Categories).columns('seedDescription').where({ slug: target }),
    );
    expect(row.seedDescription).toBe(CATEGORY_SEED_DESCRIPTIONS[target]);
  });
});
