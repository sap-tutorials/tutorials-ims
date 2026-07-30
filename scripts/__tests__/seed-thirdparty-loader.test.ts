import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { seedThirdParty } from '../seed-thirdparty.js';

let db;
let HomepageShelves;

beforeAll(async () => {
  const model = await cds.load('*');
  db = await cds.deploy(model).to('sqlite::memory:');
  ({ HomepageShelves } = cds.entities('com.sap.developers.ims'));
}, 60000);

describe('seedThirdParty', () => {
  it('first run inserts all rows', async () => {
    const res = await seedThirdParty(db);
    expect(res.inserted).toBe(23);
    expect(res.updated).toBe(0);
    const staged = await db.run(SELECT.from(HomepageShelves).columns('ID').where(
      `ID like '66333900-3rd0-%' or ID like '66333900-rpt1-%'`
    ));
    expect(staged.length).toBe(23);
  });

  it('second run updates in place, inserts nothing (idempotent)', async () => {
    const res = await seedThirdParty(db);
    expect(res.inserted).toBe(0);
    expect(res.updated).toBe(23);
    const staged = await db.run(SELECT.from(HomepageShelves).columns('ID').where(
      `ID like '66333900-3rd0-%' or ID like '66333900-rpt1-%'`
    ));
    expect(staged.length).toBe(23);
  });

  it('persists personaTags as an array and clears the THIRD_PARTY badge', async () => {
    const vercel = await db.run(SELECT.one.from(HomepageShelves).where({ verb: 'BUILD', url: 'https://vercel.com' }));
    expect(vercel).toBeTruthy();
    expect(vercel.personaTags).toContain('role:developer');
    expect(vercel.badge).toBeNull();
  });

  it('marks the RPT-1 rows with the NEW badge', async () => {
    const rpt = await db.run(SELECT.one.from(HomepageShelves).where({ verb: 'AI', url: 'https://rpt.cloud.sap' }));
    expect(rpt).toBeTruthy();
    expect(rpt.title).toBe('SAP RPT-1 Playground');
    expect(rpt.badge).toBe('NEW');
  });
});
