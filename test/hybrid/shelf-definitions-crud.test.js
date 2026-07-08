import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { SHELF_DEFAULTS, SHELF_KEYS_SORTED } from '../../srv/lib/homepage/verb-shelf-defaults.js';   // #1089

describe.runIf(isSafeForWrites())('ShelfDefinitions — admin CRUD on HANA (#759 PR 1)', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });
  afterAll(async () => {
    await db.run(
      DELETE.from('com.sap.developers.ims.ShelfDefinitions')
        .where("label like '__TEST__%'")
    );
  });

  it('AdminService.ShelfDefinitions returns SHELF_DEFAULTS.length rows after auto-init', async () => {
    const admin = await cds.connect.to('AdminService');
    const rows = await admin.run(SELECT.from('AdminService.ShelfDefinitions'));
    expect(rows.length).toBe(SHELF_DEFAULTS.length);
  });

  it('all SHELF_DEFAULTS enum values are represented exactly once', async () => {
    const rows = await db.run(SELECT.from('com.sap.developers.ims.ShelfDefinitions'));
    const keys = rows.map(r => r.shelfKey).sort();
    expect(keys).toEqual([...SHELF_KEYS_SORTED]);
  });

  it('@assert.unique.shelfKey rejects duplicate insert', async () => {
    await expect(
      db.run(INSERT.into('com.sap.developers.ims.ShelfDefinitions').entries({
        shelfKey: 'START_HERE',
        label: '__TEST__ duplicate',
      }))
    ).rejects.toThrow();
  });

  it('@assert.range rejects invalid shelfKey value', async () => {
    await expect(
      db.run(INSERT.into('com.sap.developers.ims.ShelfDefinitions').entries({
        shelfKey: 'BOGUS_VALUE',
        label: '__TEST__ bogus',
      }))
    ).rejects.toThrow();
  });
});
