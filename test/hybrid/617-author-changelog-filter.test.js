/**
 * #617 hybrid test — AuthorService.TutorialChanges projection (filtered to
 * AdminService.Tutorials rows via the AuthorTutorialChanges view) over real
 * HANA. Read-only; uses existing change-log data if present.
 *
 * The view definition (db/views.cds) filters `entity = 'AdminService.Tutorials'`
 * so authors don't see Mission/Group/Tag/etc. change rows. This hybrid test
 * proves the filter holds on HANA — the unit test (test/unit/author-service-changelog.test.js)
 * covers it with SQLite fixtures.
 *
 * Run with: cf login + cds bind --exec -- npx vitest run test/hybrid/617-author-changelog-filter.test.js
 */
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('#617 — AuthorService.TutorialChanges filter (hybrid)', () => {
  let AuthorService;

  beforeAll(async () => {
    AuthorService = await cds.connect.to('AuthorService');
  });

  it('TutorialChanges returns only AdminService.Tutorials change rows (if any exist)', async () => {
    const { TutorialChanges } = AuthorService.entities;
    const rows = await SELECT.from(TutorialChanges).limit(50);
    if (rows.length === 0) {
      console.warn('[skip] No change-log rows on bound HANA — change-tracking dataset may be empty');
      return;
    }
    // Every row must have entity = 'AdminService.Tutorials' (no Missions/Groups/Tags).
    const entities = new Set(rows.map((r) => r.entity));
    expect(entities.size).toBe(1);
    expect(entities.has('AdminService.Tutorials')).toBe(true);
  });
});
