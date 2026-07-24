import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('Homepage seed data', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('loads HomepageShelves seed (>= 40 entries; verbs are all in the 7-verb set)', async () => {
    // (#1029) MODEL added as 7th verb; shelf content authored in a
    // follow-up. Existing seeded verbs must still all be present.
    const { HomepageShelves } = cds.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(HomepageShelves));
    expect(rows.length).toBeGreaterThanOrEqual(40);
    const verbs = new Set(rows.map(r => r.verb));
    const valid = new Set(['LEARN','BUILD','INTEGRATE','MODEL','OPERATE','AI','CONNECT']);
    for (const v of verbs) expect(valid).toContain(v);
    for (const required of ['LEARN','BUILD','INTEGRATE','OPERATE','AI','CONNECT']) {
      expect(verbs).toContain(required);
    }
  });

  it('loads exactly one HomepageConfig row', async () => {
    const { HomepageConfig } = cds.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(HomepageConfig));
    expect(rows.length).toBe(1);
  });

  it('loads the 3 named seed LegacyRedirects plus the 30 migrated AEM rows (#752)', async () => {
    const { LegacyRedirects } = cds.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(LegacyRedirects));
    expect(rows.length).toBe(33);
    const froms = new Set(rows.map(r => r.fromPath));
    for (const seed of ['/tutorial-navigator.html', '/index.html', '/groups.html']) {
      expect(froms).toContain(seed);
    }
  });
});
