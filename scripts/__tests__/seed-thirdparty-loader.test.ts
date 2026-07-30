import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { seedThirdParty } from '../seed-thirdparty.js';

let db;

beforeAll(async () => {
  const model = await cds.load('*');
  db = await cds.deploy(model).to('sqlite::memory:');
}, 60000);

describe('seedThirdParty', () => {
  it('first run inserts all rows', async () => {
    const res = await seedThirdParty(db);
    expect(res.inserted).toBe(20);
    expect(res.updated).toBe(0);
    const { HomepageShelves } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(HomepageShelves).where({ badge: 'THIRD_PARTY', ID: { like: '66333900-3rd0-%' } });
    expect(rows.length).toBe(20);
  });

  it('second run updates in place, inserts nothing (idempotent)', async () => {
    const res = await seedThirdParty(db);
    expect(res.inserted).toBe(0);
    expect(res.updated).toBe(20);
    const { HomepageShelves } = cds.entities('com.sap.developers.ims');
    const all = await SELECT.from(HomepageShelves).where({ ID: { like: '66333900-3rd0-%' } });
    expect(all.length).toBe(20);
  });

  it('persists personaTags as an array', async () => {
    const { HomepageShelves } = cds.entities('com.sap.developers.ims');
    const vercel = await SELECT.one.from(HomepageShelves).where({ verb: 'BUILD', url: 'https://vercel.com' });
    expect(vercel).toBeTruthy();
    expect(vercel.personaTags).toContain('role:developer');
    expect(vercel.badge).toBe('THIRD_PARTY');
  });
});
