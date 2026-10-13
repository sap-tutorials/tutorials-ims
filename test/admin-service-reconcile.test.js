// test/admin-service-reconcile.test.js
//
// Regression for #2732: when an admin edits a completion path mapping, the
// after-hooks should fire-and-forget reconcileEntityForUsers so already-completed
// users' GROUP/MISSION TaskRecords are healed immediately.
//
// Two code paths are tested:
//   A) Root-entity SAVE path (primary production path via draftActivate):
//      CAP fires SAVE on the root active entity (Missions/Groups) on
//      draftActivate — "events aren't automatically triggered on composition
//      entities" (CAP docs: Deeply Structured Documents). The after('SAVE','Missions')
//      root hook covers this. Tested end-to-end via HTTP draft activate.
//   B) Direct DELETE path: admin removes a CompletionPathItems row directly;
//      after('DELETE','CompletionPathItems') fires + before('DELETE') captures
//      the parent FK before the row is gone.
//
// Auth harness copied from test/admin-service.test.js and admin-drafts.test.js:
//   cds.test('serve', '--project', '.', '--in-memory') + adminAuth HTTP calls.
// Service-level DELETE via admin.tx() pattern copied from test/pat-admin-grant.test.js.
import { describe, it, expect, vi } from 'vitest';
import cds from '@sap/cds';

// Shared CDS server — same pattern as admin-service.test.js.
const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

const NS = 'com.sap.developers.ims';
const adminCtx = { user: { id: 'admin', roles: ['Admin', 'authenticated-user'] } };

describe('admin path-item SAVE reconciles affected users (#2732)', () => {
  // ─── A) Root-entity SAVE path (draftActivate) ────────────────────────────
  // This test exercises the primary production flow: admin publishes a Mission
  // via Fiori draft (POST /admin/Missions → add path + CPI → draftActivate).
  // CAP fires SAVE on the active Missions entity; our after('SAVE','Missions')
  // hook reconciles users who completed the mapped tutorial before publication.
  it('draftActivate Missions fires after(SAVE) hook and heals user MISSION TaskRecord', async () => {
    const db = await cds.connect.to('db');
    const { Users, Tutorials, TaskRecords, Tags } = cds.entities(NS);

    const USER_ID   = 'aaaaaaaa-2732-s001-0000-000000000001';
    const TUT_ID    = 'bbbbbbbb-2732-s001-0000-000000000001';
    const TAG_ID    = 'tttttttt-2732-s001-0000-000000000001';
    const TUT_LEGACY = 94001;

    // Fixture: a user who has already completed the tutorial. Mission doesn't
    // exist yet — will be created via the draft flow below.
    await db.run(INSERT.into(Users).entries({ ID: USER_ID, legacyId: 94100, uuid: 'u-adm-2732-s01' }));
    await db.run(INSERT.into(Tutorials).entries({
      ID: TUT_ID, legacyId: TUT_LEGACY, slug: 'adm-reconcile-s01-tut',
      title: 'SAVE Test Tutorial', status: 'ACTIVE',
    }));
    // The tag is required to activate a Mission (before('SAVE') validator).
    await db.run(INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 94200, name: '__TEST__ reconcile-s01 tag' }));
    await db.run(INSERT.into(TaskRecords).entries({
      ID: 'ffffffff-2732-s001-0000-000000000001',
      user_ID: USER_ID, taskLegacyId: TUT_LEGACY, taskType: 'TUTORIAL',
      status: 'COMPLETED', progress: 100, legacyId: 94700, attemptNumber: 1,
    }));

    // Create a Mission draft.
    const { status: s1, data: draft } = await project.post('/admin/Missions', {
      title: '__TEST__ Reconcile SAVE Mission',
      slug: 'reconcile-save-mission-2732', description: 'SAVE hook test',
      experienceTag: 'beginner', primaryTagRef_ID: TAG_ID,
    }, { ...adminAuth, headers: { Prefer: 'handling=lenient' } });
    expect(s1).toBe(201);
    const MISS_DRAFT_ID = draft.ID;

    // Add a completion path to the draft.
    const { status: s2, data: path } = await project.post(
      `/admin/Missions(ID=${MISS_DRAFT_ID},IsActiveEntity=false)/completionPaths`,
      { name: 'SAVE Test Path', slug: 'save-test-path', legacyId: 94600 }, adminAuth
    );
    expect(s2).toBe(201);

    // Add a CPI to the draft path (maps the tutorial into the path).
    const { status: s3 } = await project.post(
      `/admin/CompletionPaths(ID=${path.ID},IsActiveEntity=false)/items`,
      { taskType: 'TUTORIAL', taskLegacyId: TUT_LEGACY, itemOrder: 10 }, adminAuth
    );
    expect(s3).toBe(201);

    // Add the required tag.
    await project.post(
      `/admin/Missions(ID=${MISS_DRAFT_ID},IsActiveEntity=false)/tags`,
      { tag_ID: TAG_ID }, adminAuth
    );

    // Activate the draft: CAP fires SAVE on AdminService.Missions.
    // Our after('SAVE','Missions') hook resolves legacyId from req.data and
    // fire-and-forgets reconcileEntityForUsers — which should find USER_ID
    // (completed TUT_LEGACY) and create a COMPLETED MISSION TaskRecord.
    const { status: s4 } = await project.post(
      `/admin/Missions(ID=${MISS_DRAFT_ID},IsActiveEntity=false)/AdminService.draftActivate`,
      {}, adminAuth
    );
    expect([200, 201]).toContain(s4);

    // vi.waitFor polls until the reconcile settles.
    await vi.waitFor(async () => {
      const { Missions, TaskRecords: TR } = cds.entities(NS);
      const [m] = await db.run(SELECT.from(Missions).where({ ID: MISS_DRAFT_ID }));
      expect(m).toBeDefined();
      const [row] = await db.run(
        SELECT.from(TR).where({ user_ID: USER_ID, taskType: 'MISSION', taskLegacyId: m.legacyId })
      );
      expect(row?.status).toBe('COMPLETED');
    }, { timeout: 1500, interval: 40 });
  });

  // ─── B) Direct DELETE path (programmatic write / direct admin action) ─────
  it('DELETE CompletionPathItems resolves mission via before-hook capture and heals user to COMPLETED', async () => {
    const admin = await cds.connect.to('AdminService');
    const db    = await cds.connect.to('db');
    const {
      Users, Tutorials, Missions, CompletionPaths, CompletionPathItems, TaskRecords,
    } = cds.entities(NS);
    const { CompletionPathItems: SvcCPI } = cds.entities('AdminService');

    const USER_ID    = 'aaaaaaaa-2732-0001-0000-000000000001';
    const TUT_A_ID   = 'bbbbbbbb-2732-0001-0000-000000000001';
    const TUT_B_ID   = 'bbbbbbbb-2732-0001-0000-000000000002';
    const MISS_ID    = 'cccccccc-2732-0001-0000-000000000001';
    const CP_ID      = 'dddddddd-2732-0001-0000-000000000001';
    const CPI_A_ID   = 'eeeeeeee-2732-0001-0000-000000000001';
    const CPI_B_ID   = 'eeeeeeee-2732-0001-0000-000000000002';
    const TUT_A_LEGACY  = 93001;
    const TUT_B_LEGACY  = 93002;
    const MISS_LEGACY   = 93500;

    // Fixture: two tutorials in one path. User completed A but not B → IN_PROGRESS.
    // After admin deletes CPI_B, path has only A → user → COMPLETED.
    await db.run(INSERT.into(Users).entries({ ID: USER_ID, legacyId: 93100, uuid: 'u-adm-2732-01' }));
    await db.run(INSERT.into(Tutorials).entries([
      { ID: TUT_A_ID, legacyId: TUT_A_LEGACY, slug: 'adm-reconcile-tut-01a', title: 'Tutorial A', status: 'ACTIVE' },
      { ID: TUT_B_ID, legacyId: TUT_B_LEGACY, slug: 'adm-reconcile-tut-01b', title: 'Tutorial B', status: 'ACTIVE' },
    ]));
    await db.run(INSERT.into(Missions).entries({
      ID: MISS_ID, legacyId: MISS_LEGACY, title: 'Reconcile Test Mission', published: true,
    }));
    await db.run(INSERT.into(CompletionPaths).entries({
      ID: CP_ID, mission_ID: MISS_ID, legacyId: 93600, name: 'Test Path',
    }));
    await db.run(INSERT.into(CompletionPathItems).entries([
      { ID: CPI_A_ID, path_ID: CP_ID, taskType: 'TUTORIAL', taskLegacyId: TUT_A_LEGACY, itemOrder: 10, legacyId: 93701 },
      { ID: CPI_B_ID, path_ID: CP_ID, taskType: 'TUTORIAL', taskLegacyId: TUT_B_LEGACY, itemOrder: 20, legacyId: 93702 },
    ]));
    await db.run(INSERT.into(TaskRecords).entries([
      {
        ID: 'ffffffff-2732-0001-0000-000000000001',
        user_ID: USER_ID, taskLegacyId: TUT_A_LEGACY, taskType: 'TUTORIAL',
        status: 'COMPLETED', progress: 100, legacyId: 93800, attemptNumber: 1,
      },
      {
        ID: 'ffffffff-2732-0001-0000-000000000002',
        user_ID: USER_ID, taskLegacyId: MISS_LEGACY, taskType: 'MISSION',
        status: 'IN_PROGRESS', progress: 50, legacyId: 93801, attemptNumber: 1,
      },
    ]));

    // Act: DELETE CPI_B via AdminService.
    //   before('DELETE','CompletionPathItems') captures path_ID from req.query.DELETE.where[2].val.
    //   after('DELETE','CompletionPathItems') reads req._cpiPathId, resolves mission, fires reconcile.
    await admin.tx(adminCtx, tx =>
      tx.run(DELETE.from(SvcCPI).where({ ID: CPI_B_ID }))
    );

    await vi.waitFor(async () => {
      const [row] = await db.run(
        SELECT.from(TaskRecords).where({ user_ID: USER_ID, taskType: 'MISSION' })
      );
      expect(row?.status).toBe('COMPLETED');
    }, { timeout: 1000, interval: 30 });
  });

  // ─── C) fail-open: DELETE of the only CPI → empty path → reconcile no-op ─
  // With 0 slots, reconcileEntityForUsers returns { flagged: 1 } without
  // touching TaskRecords (early-return on slots.length===0). allowDowngrade:false
  // would also prevent any downgrade even if reconcile ran. MISSION stays COMPLETED.
  it('DELETE of the only CompletionPathItems fires reconcile without crashing; mission row unchanged', async () => {
    const admin = await cds.connect.to('AdminService');
    const db    = await cds.connect.to('db');
    const {
      Users, Tutorials, Missions, CompletionPaths, CompletionPathItems, TaskRecords,
    } = cds.entities(NS);
    const { CompletionPathItems: SvcCPI } = cds.entities('AdminService');

    const USER_ID    = 'aaaaaaaa-2732-0002-0000-000000000001';
    const TUT_ID     = 'bbbbbbbb-2732-0002-0000-000000000001';
    const MISS_ID    = 'cccccccc-2732-0002-0000-000000000001';
    const CP_ID      = 'dddddddd-2732-0002-0000-000000000001';
    const CPI_ID     = 'eeeeeeee-2732-0002-0000-000000000001';
    const TUT_LEGACY  = 93003;
    const MISS_LEGACY = 93503;

    await db.run(INSERT.into(Users).entries({ ID: USER_ID, legacyId: 93103, uuid: 'u-adm-2732-02' }));
    await db.run(INSERT.into(Tutorials).entries({
      ID: TUT_ID, legacyId: TUT_LEGACY, slug: 'adm-reconcile-tut-02',
      title: 'Reconcile Test 2', status: 'ACTIVE',
    }));
    await db.run(INSERT.into(Missions).entries({
      ID: MISS_ID, legacyId: MISS_LEGACY, title: 'Reconcile Test Mission 2', published: true,
    }));
    await db.run(INSERT.into(CompletionPaths).entries({
      ID: CP_ID, mission_ID: MISS_ID, legacyId: 93603, name: 'Test Path 2',
    }));
    await db.run(INSERT.into(CompletionPathItems).entries({
      ID: CPI_ID, path_ID: CP_ID, taskType: 'TUTORIAL', taskLegacyId: TUT_LEGACY,
      itemOrder: 10, legacyId: 93704,
    }));
    // User has COMPLETED MISSION record.
    await db.run(INSERT.into(TaskRecords).entries([
      {
        ID: 'ffffffff-2732-0002-0000-000000000001',
        user_ID: USER_ID, taskLegacyId: TUT_LEGACY, taskType: 'TUTORIAL',
        status: 'COMPLETED', progress: 100, legacyId: 93804, attemptNumber: 1,
      },
      {
        ID: 'ffffffff-2732-0002-0000-000000000002',
        user_ID: USER_ID, taskLegacyId: MISS_LEGACY, taskType: 'MISSION',
        status: 'COMPLETED', progress: 100, legacyId: 93805, attemptNumber: 1,
      },
    ]));

    // Delete the only CPI: path becomes empty (0 slots).
    await admin.tx(adminCtx, tx =>
      tx.run(DELETE.from(SvcCPI).where({ ID: CPI_ID }))
    );

    // Give a short window for setImmediate to flush. No polling needed —
    // we're asserting the status is STILL 'COMPLETED' (no change expected).
    await new Promise(r => setTimeout(r, 80));

    const [row] = await db.run(
      SELECT.from(TaskRecords).where({ user_ID: USER_ID, taskType: 'MISSION' })
    );
    // reconcileEntityForUsers returns { flagged: 1 } on empty path — row unchanged.
    expect(row).toBeDefined();
    expect(row.status).toBe('COMPLETED');
  });
});
