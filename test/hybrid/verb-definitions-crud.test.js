import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { VERB_DEFAULTS, VERB_KEYS_SORTED } from '../../srv/lib/homepage/verb-shelf-defaults.js';   // #1089

describe.runIf(isSafeForWrites())('VerbDefinitions — admin CRUD on HANA (#759 PR 1)', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });
  afterAll(async () => {
    await db.run(
      DELETE.from('com.sap.developers.ims.VerbDefinitions')
        .where("label like '__TEST__%'")
    );
  });

  it('AdminService.VerbDefinitions returns VERB_DEFAULTS.length rows after auto-init', async () => {
    const admin = await cds.connect.to('AdminService');
    const rows = await admin.run(SELECT.from('AdminService.VerbDefinitions'));
    expect(rows.length).toBe(VERB_DEFAULTS.length);
  });

  it('all VERB_DEFAULTS enum values are represented exactly once', async () => {
    const rows = await db.run(SELECT.from('com.sap.developers.ims.VerbDefinitions'));
    const keys = rows.map(r => r.verbKey).sort();
    expect(keys).toEqual([...VERB_KEYS_SORTED]);
  });

  it('@assert.unique.verbKey rejects duplicate insert', async () => {
    await expect(
      db.run(INSERT.into('com.sap.developers.ims.VerbDefinitions').entries({
        verbKey: 'LEARN',
        label: '__TEST__ duplicate',
      }))
    ).rejects.toThrow();
  });

  it('@assert.range rejects invalid verbKey value', async () => {
    await expect(
      db.run(INSERT.into('com.sap.developers.ims.VerbDefinitions').entries({
        verbKey: 'BOGUS_VALUE',
        label: '__TEST__ bogus',
      }))
    ).rejects.toThrow();
  });
});
