// test/admin-drafts-discard-reconcile.test.js
//
// Regression for #2909: with cds.fiori.draft_admin_integrity enabled, discarding
// a draft of a Mission/Group cascade-deletes its draft composition children
// (CompletionPathItems / GroupPathItems) at the DB level, bypassing the per-row
// after('DELETE') reconcile hooks. The root after('DISCARD','Missions'/'Groups')
// handlers restore rollup correctness by firing reconcileEntityForUsers for the
// active entity's legacyId on discard.
//
// Assertion strategy mirrors admin-service-reconcile.test.js: seed a user whose
// active-entity rollup is out of sync, perform the draft action, and vi.waitFor
// the observable TaskRecords heal. Reconcile is a static ESM import in
// admin-service.js (not spyable across the module boundary), so we assert the
// side effect, not the call.
//
// Harness: cds.test('serve', '--project', '.', '--in-memory') + adminAuth HTTP,
// matching test/admin-drafts.test.js and admin-service-reconcile.test.js.
import { describe, it, expect, vi } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };
const NS = 'com.sap.developers.ims';

describe('draft DISCARD reconciles rollups (#2909 draft_admin_integrity)', () => {
  // ─── A) Discarding an edit of an active Mission fires MISSION reconcile ───
  // Active Mission has one CPI→tutorial. User completed the tutorial but their
  // MISSION TaskRecord is stale IN_PROGRESS. Admin draftEdits the Mission then
  // DISCARDs. The after('DISCARD','Missions') handler resolves the active
  // Mission's legacyId and fires reconcile → user heals to COMPLETED.
  it('fires MISSION reconcile when a Mission draft (edit) is discarded', async () => {
    const db = await cds.connect.to('db');
    const { Users, Tutorials, Missions, CompletionPaths, CompletionPathItems, TaskRecords, Tags } = cds.entities(NS);

    const USER_ID = 'aaaaaaaa-2909-0001-0000-000000000001';
    const TUT_ID  = 'bbbbbbbb-2909-0001-0000-000000000001';
    const MISS_ID = 'cccccccc-2909-0001-0000-000000000001';
    const CP_ID   = 'dddddddd-2909-0001-0000-000000000001';
    const CPI_ID  = 'eeeeeeee-2909-0001-0000-000000000001';
    const TAG_ID  = 'tttttttt-2909-0001-0000-000000000001';
    const TUT_LEGACY  = 92001;
    const MISS_LEGACY = 92501;

    await db.run(INSERT.into(Users).entries({ ID: USER_ID, legacyId: 92101, uuid: 'u-2909-01' }));
    await db.run(INSERT.into(Tutorials).entries({
      ID: TUT_ID, legacyId: TUT_LEGACY, slug: 'disc-reconcile-tut-01', title: 'Disc Tut 01', status: 'ACTIVE',
    }));
    await db.run(INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 92201, name: '__TEST__ disc-01' }));
    await db.run(INSERT.into(Missions).entries({
      ID: MISS_ID, legacyId: MISS_LEGACY, title: 'Disc Reconcile Mission', published: true,
    }));
    await db.run(INSERT.into(CompletionPaths).entries({
      ID: CP_ID, mission_ID: MISS_ID, legacyId: 92601, name: 'Disc Path',
    }));
    await db.run(INSERT.into(CompletionPathItems).entries({
      ID: CPI_ID, path_ID: CP_ID, taskType: 'TUTORIAL', taskLegacyId: TUT_LEGACY, itemOrder: 10, legacyId: 92701,
    }));
    // User completed the tutorial but MISSION record is stale IN_PROGRESS.
    await db.run(INSERT.into(TaskRecords).entries([
      { ID: 'ffffffff-2909-0001-0000-000000000001', user_ID: USER_ID, taskLegacyId: TUT_LEGACY, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 92801, attemptNumber: 1 },
      { ID: 'ffffffff-2909-0001-0000-000000000002', user_ID: USER_ID, taskLegacyId: MISS_LEGACY, taskType: 'MISSION', status: 'IN_PROGRESS', progress: 50, legacyId: 92802, attemptNumber: 1 },
    ]));

    // draftEdit the active Mission, then DISCARD the draft.
    const { status: sEdit } = await project.post(
      `/admin/Missions(ID=${MISS_ID},IsActiveEntity=true)/AdminService.draftEdit`, {}, adminAuth
    );
    expect([200, 201]).toContain(sEdit);
    const { status: sDisc } = await project.delete(
      `/admin/Missions(ID=${MISS_ID},IsActiveEntity=false)`, adminAuth
    );
    expect([200, 204]).toContain(sDisc);

    // DISCARD handler fires MISSION reconcile for the active legacyId → heal.
    await vi.waitFor(async () => {
      const [row] = await db.run(
        SELECT.from(TaskRecords).where({ user_ID: USER_ID, taskType: 'MISSION', taskLegacyId: MISS_LEGACY })
      );
      expect(row?.status).toBe('COMPLETED');
    }, { timeout: 2000, interval: 40 });
  });

  // ─── B) Discarding an empty freshly-created Mission draft does not throw ──
  it('DISCARD of an empty new Mission draft does not throw', async () => {
    const { status: sNew, data: draft } = await project.post('/admin/Missions', {
      title: '__TEST__ Disc Empty Mission', slug: 'disc-empty-mission-2909',
    }, { ...adminAuth, headers: { Prefer: 'handling=lenient' } });
    expect(sNew).toBe(201);
    const { status: sDisc } = await project.delete(
      `/admin/Missions(ID=${draft.ID},IsActiveEntity=false)`, adminAuth
    );
    expect([200, 204]).toContain(sDisc);
  });

  // ─── C) Discarding an edit of an active Group fires GROUP reconcile ───────
  it('fires GROUP reconcile when a Group draft (edit) is discarded', async () => {
    const db = await cds.connect.to('db');
    const { Users, Tutorials, Groups, GroupPathItems, TaskRecords } = cds.entities(NS);

    const USER_ID = 'aaaaaaaa-2909-0003-0000-000000000001';
    const TUT_ID  = 'bbbbbbbb-2909-0003-0000-000000000001';
    const GRP_ID  = 'cccccccc-2909-0003-0000-000000000001';
    const GPI_ID  = 'eeeeeeee-2909-0003-0000-000000000001';
    const TUT_LEGACY = 92003;
    const GRP_LEGACY = 92503;

    await db.run(INSERT.into(Users).entries({ ID: USER_ID, legacyId: 92103, uuid: 'u-2909-03' }));
    await db.run(INSERT.into(Tutorials).entries({
      ID: TUT_ID, legacyId: TUT_LEGACY, slug: 'disc-reconcile-tut-03', title: 'Disc Tut 03', status: 'ACTIVE',
    }));
    await db.run(INSERT.into(Groups).entries({
      ID: GRP_ID, legacyId: GRP_LEGACY, title: 'Disc Reconcile Group', published: true,
    }));
    await db.run(INSERT.into(GroupPathItems).entries({
      ID: GPI_ID, group_ID: GRP_ID, tutorial_ID: TUT_ID, itemOrder: 10, legacyId: 92703,
    }));
    await db.run(INSERT.into(TaskRecords).entries([
      { ID: 'ffffffff-2909-0003-0000-000000000001', user_ID: USER_ID, taskLegacyId: TUT_LEGACY, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 92803, attemptNumber: 1 },
      { ID: 'ffffffff-2909-0003-0000-000000000002', user_ID: USER_ID, taskLegacyId: GRP_LEGACY, taskType: 'GROUP', status: 'IN_PROGRESS', progress: 50, legacyId: 92804, attemptNumber: 1 },
    ]));

    const { status: sEdit } = await project.post(
      `/admin/Groups(ID=${GRP_ID},IsActiveEntity=true)/AdminService.draftEdit`, {}, adminAuth
    );
    expect([200, 201]).toContain(sEdit);
    const { status: sDisc } = await project.delete(
      `/admin/Groups(ID=${GRP_ID},IsActiveEntity=false)`, adminAuth
    );
    expect([200, 204]).toContain(sDisc);

    await vi.waitFor(async () => {
      const [row] = await db.run(
        SELECT.from(TaskRecords).where({ user_ID: USER_ID, taskType: 'GROUP', taskLegacyId: GRP_LEGACY })
      );
      expect(row?.status).toBe('COMPLETED');
    }, { timeout: 2000, interval: 40 });
  });
});
