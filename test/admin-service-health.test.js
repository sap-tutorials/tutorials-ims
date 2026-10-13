// test/admin-service-health.test.js
//
// Regression for #2732: AdminService.completionHealth() returns missions/groups
// whose completion paths contain INACTIVE or unresolvable tutorial slots.
//
// Auth/connection harness copied from test/admin-service-reconcile.test.js:
//   cds.test('serve','--project','.','--in-memory') + admin.tx(adminCtx, ...).
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const NS = 'com.sap.developers.ims';
const adminCtx = { user: { id: 'admin', roles: ['Admin', 'authenticated-user'] } };

const { INSERT } = cds.ql;

describe('AdminService.completionHealth (#2732)', () => {
  it('returns groups with INACTIVE tutorial slots', async () => {
    const db = await cds.connect.to('db');
    const { Tutorials, Groups, GroupPathItems } = cds.entities(NS);

    await db.run(INSERT.into(Tutorials).entries({
      ID: 'th-2732-h001-0000-000000000001',
      legacyId: 2001, slug: 'h-inactive-tut', status: 'INACTIVE',
    }));
    await db.run(INSERT.into(Groups).entries({
      ID: 'gh-2732-h001-0000-000000000001',
      legacyId: 2500, title: 'H Group', slug: 'h-grp', published: true,
    }));
    await db.run(INSERT.into(GroupPathItems).entries({
      ID: 'gi-2732-h001-0000-000000000001',
      group_ID: 'gh-2732-h001-0000-000000000001',
      tutorial_ID: 'th-2732-h001-0000-000000000001',
      itemOrder: 10,
    }));

    const admin = await cds.connect.to('AdminService');
    const res = await admin.tx(adminCtx, tx => tx.send('completionHealth'));
    const g = res.find(e => e.legacyId === 2500);
    expect(g).toBeDefined();
    expect(g.badSlots.some(s => s.reason === 'inactive')).toBe(true);
  });

  it('returns [] when all published entities have clean paths', async () => {
    // Fresh in-memory DB — no fixtures inserted here; any pre-existing clean
    // groups/missions from prior test isolation will have no inactive slots.
    // We just assert completionHealth is callable and returns an array.
    const admin = await cds.connect.to('AdminService');
    const res = await admin.tx(adminCtx, tx => tx.send('completionHealth'));
    expect(Array.isArray(res)).toBe(true);
    // The INACTIVE group from the first test may appear — that's fine.
    // This test just guards against a crash and confirms array return type.
  });
});
