import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { seedHomepageShelves } from '../../../srv/lib/homepage/seed-homepage-shelves.js';
import { HOMEPAGE_SHELVES_DEFAULTS } from '../../../srv/lib/homepage/homepage-shelves-defaults.js';

cds.test('serve', '--project', '.', '--in-memory');

describe('seedHomepageShelves (idempotent, non-destructive boot seed)', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('boot (cds.on served) seeded the full baseline incl. third-party links', async () => {
    const { HomepageShelves } = cds.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(HomepageShelves));
    expect(rows.length).toBe(HOMEPAGE_SHELVES_DEFAULTS.length);
    const titles = rows.map((r) => r.title).join(' | ');
    for (const t of ['Dremio', 'Reltio', 'Prior Labs', 'n8n']) {
      expect(titles).toContain(t);
    }
  });

  it('re-running the seed inserts nothing (idempotent on verb+url)', async () => {
    const res = await seedHomepageShelves(db);
    expect(res.inserted).toBe(0);
    expect(res.total).toBe(HOMEPAGE_SHELVES_DEFAULTS.length);
  });

  it('never overwrites an existing (admin-edited) row', async () => {
    const { HomepageShelves } = cds.entities('com.sap.developers.ims');
    const target = HOMEPAGE_SHELVES_DEFAULTS[0];
    const edited = 'ADMIN EDITED TITLE — do not clobber';
    await db.run(
      UPDATE(HomepageShelves).set({ title: edited }).where({ verb: target.verb, url: target.url }),
    );
    const before = (await db.run(SELECT.from(HomepageShelves))).length;

    await seedHomepageShelves(db);

    const row = await db.run(
      SELECT.one.from(HomepageShelves).where({ verb: target.verb, url: target.url }),
    );
    expect(row.title).toBe(edited); // untouched
    const after = (await db.run(SELECT.from(HomepageShelves))).length;
    expect(after).toBe(before); // no duplicate inserted
  });

  it('re-inserts a baseline row that was deleted (self-heals)', async () => {
    const { HomepageShelves } = cds.entities('com.sap.developers.ims');
    const victim = HOMEPAGE_SHELVES_DEFAULTS[1];
    await db.run(DELETE.from(HomepageShelves).where({ verb: victim.verb, url: victim.url }));
    expect(
      await db.run(SELECT.one.from(HomepageShelves).where({ verb: victim.verb, url: victim.url })),
    ).toBeUndefined();

    const res = await seedHomepageShelves(db);
    expect(res.inserted).toBe(1);
    expect(
      await db.run(SELECT.one.from(HomepageShelves).where({ verb: victim.verb, url: victim.url })),
    ).toBeTruthy();
  });
});
