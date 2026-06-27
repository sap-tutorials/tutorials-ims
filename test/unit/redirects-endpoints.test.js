// test/unit/redirects-endpoints.test.js
// Tests for HomepageService redirect endpoints (#639):
//   redirectsActive()           → array of RedirectRow (isActive=true rows only)
//   recordRedirectHits(hits)    → Integer (count of updated rows)

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('Redirect endpoints', () => {
  let svc;
  beforeAll(async () => {
    svc = await cds.connect.to('HomepageService');
  });

  it('redirectsActive returns active rows only', async () => {
    const rows = await svc.send('redirectsActive', {});
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(3);  // 3 seed rows from Task 2

    // Insert an inactive row and confirm it doesn't appear in the result.
    const db = await cds.connect.to('db');
    const inactiveId = cds.utils.uuid();
    await db.run(INSERT.into('com.sap.developers.ims.LegacyRedirects').entries({
      ID: inactiveId,
      fromPath: '/__test_inactive__.html',
      toPath: '/never/',
      statusCode: 301,
      isPattern: false,
      isActive: false
    }));
    const rows2 = await svc.send('redirectsActive', {});
    expect(rows2.find(r => r.ID === inactiveId)).toBeUndefined();
  });

  it('recordRedirectHits increments hitCount on existing rows', async () => {
    const db = await cds.connect.to('db');
    const before = await db.run(SELECT.one.from('com.sap.developers.ims.LegacyRedirects')
      .where({ fromPath: '/index.html' }));
    expect(before).toBeTruthy();

    const updated = await svc.send('recordRedirectHits', { hits: [{ id: before.ID, count: 7 }] });
    expect(updated).toBe(1);

    const after = await db.run(SELECT.one.from('com.sap.developers.ims.LegacyRedirects')
      .where({ fromPath: '/index.html' }));
    expect(after.hitCount).toBe((before.hitCount || 0) + 7);
  });

  it('recordRedirectHits ignores invalid hits (missing id, zero/negative count)', async () => {
    const updated = await svc.send('recordRedirectHits', {
      hits: [
        { id: '00000000-0000-0000-0000-000000000000', count: 5 },  // nonexistent ID — skipped
        { count: 3 },                                               // missing id — skipped
        { id: 'xxx', count: 0 },                                    // zero count — skipped
        { id: 'xxx', count: -5 }                                    // negative — skipped
      ]
    });
    expect(updated).toBe(0);
  });

  it('recordRedirectHits returns 0 on empty hits array', async () => {
    const updated = await svc.send('recordRedirectHits', { hits: [] });
    expect(updated).toBe(0);
  });
});
