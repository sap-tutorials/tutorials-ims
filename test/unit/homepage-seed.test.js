import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('Homepage seed data', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('loads HomepageShelves seed (>= 40 entries spanning all 6 verbs)', async () => {
    const { HomepageShelves } = db.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(HomepageShelves));
    expect(rows.length).toBeGreaterThanOrEqual(40);
    const verbs = new Set(rows.map(r => r.verb));
    expect(verbs).toEqual(new Set(['LEARN','BUILD','INTEGRATE','OPERATE','AI','CONNECT']));
  });

  it('loads exactly one HomepageConfig row', async () => {
    const { HomepageConfig } = db.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(HomepageConfig));
    expect(rows.length).toBe(1);
  });

  it('loads 3 LegacyRedirects (tutorial-navigator.html, index.html, groups.html)', async () => {
    const { LegacyRedirects } = db.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(LegacyRedirects));
    const froms = rows.map(r => r.fromPath).sort();
    expect(froms).toEqual(['/groups.html', '/index.html', '/tutorial-navigator.html']);
  });
});
