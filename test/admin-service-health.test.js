// test/admin-service-health.test.js
//
// Regression for #2732: AdminService.completionHealth() returns missions/groups
// whose completion paths contain INACTIVE or unresolvable tutorial slots.
//
// Auth/connection harness copied from test/admin-service-reconcile.test.js:
//   cds.test('serve','--project','.','--in-memory') + admin.tx(adminCtx, ...).
//
// Fixtures are cleaned in afterEach so test 2 sees a genuinely-clean DB.
import { describe, it, expect, afterEach } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const NS = 'com.sap.developers.ims';
const adminCtx = { user: { id: 'admin', roles: ['Admin', 'authenticated-user'] } };

const { INSERT, DELETE } = cds.ql;

// Fixed IDs used across tests so afterEach can target them precisely.
const TUT_ID  = 'th-2732-h001-0000-000000000001';
const GRP_ID  = 'gh-2732-h001-0000-000000000001';
const GPI_ID  = 'gi-2732-h001-0000-000000000001';

afterEach(async () => {
  const db = await cds.connect.to('db');
  const { Tutorials, Groups, GroupPathItems } = cds.entities(NS);
  await db.run(DELETE.from(GroupPathItems).where({ ID: GPI_ID }));
  await db.run(DELETE.from(Groups).where({ ID: GRP_ID }));
  await db.run(DELETE.from(Tutorials).where({ ID: TUT_ID }));
});

describe('AdminService.completionHealth (#2732)', () => {
  it('returns groups with INACTIVE tutorial slots', async () => {
    const db = await cds.connect.to('db');
    const { Tutorials, Groups, GroupPathItems } = cds.entities(NS);

    await db.run(INSERT.into(Tutorials).entries({
      ID: TUT_ID, legacyId: 2001, slug: 'h-inactive-tut', status: 'INACTIVE',
    }));
    await db.run(INSERT.into(Groups).entries({
      ID: GRP_ID, legacyId: 2500, title: 'H Group', slug: 'h-grp', published: true,
    }));
    await db.run(INSERT.into(GroupPathItems).entries({
      ID: GPI_ID,
      group_ID: GRP_ID,
      tutorial_ID: TUT_ID,
      itemOrder: 10,
    }));

    const admin = await cds.connect.to('AdminService');
    const res = await admin.tx(adminCtx, tx => tx.send('completionHealth'));
    const g = res.find(e => e.legacyId === 2500);
    expect(g).toBeDefined();
    expect(g.badSlots.some(s => s.reason === 'inactive')).toBe(true);
  });

  it('returns [] when all published entities have clean paths', async () => {
    // afterEach from test 1 deleted the INACTIVE fixture rows before this runs.
    // No fixtures inserted here — DB has no published missions/groups with bad slots.
    const admin = await cds.connect.to('AdminService');
    const res = await admin.tx(adminCtx, tx => tx.send('completionHealth'));
    expect(res).toEqual([]);
  });
});
