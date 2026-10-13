// test/admin-service-reconcile.test.js
//
// Regression for #2732: when an admin creates/updates/deletes a
// CompletionPathItems or GroupPathItems row, the after-hook should
// fire-and-forget reconcileEntityForUsers so already-completed users'
// GROUP/MISSION TaskRecords are healed immediately.
//
// Auth harness copied from test/admin-service.test.js and admin-drafts.test.js:
//   - cds.test('serve', '--project', '.', '--in-memory') + adminAuth HTTP calls.
//   - admin.tx({ user: { id, roles } }, tx => tx.run(...)) pattern from
//     test/pat-admin-grant.test.js for service-level DELETE.
//
// DELETE parent-resolution strategy:
//   A before('DELETE', 'CompletionPathItems') hook stashes path_ID on
//   req._cpiPathId before the row is deleted; the after('DELETE') hook reads
//   it from there, so the parent mission can always be resolved.
//
// Why DELETE for the primary test:
//   CompletionPathItems is a composition of draft-enabled Missions. CAP's
//   lean-draft enforces that CREATE/UPDATE on active compositions must go
//   through the root draft (DRAFT_MODIFICATION_ONLY_VIA_ROOT). DELETE on
//   active entities is allowed directly. The after('DELETE') hook fires with
//   the captured path_ID and the reconcile reads from active tables — which
//   IS the correct production scenario (admin removes a path item that was
//   causing a user to be stuck IN_PROGRESS, freeing the mission to COMPLETE).
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

// Shared CDS server — same pattern as admin-service.test.js and admin-drafts.test.js.
cds.test('serve', '--project', '.', '--in-memory');

const NS = 'com.sap.developers.ims';

describe('admin path-item SAVE reconciles affected users (#2732)', () => {
  it('DELETE CompletionPathItems resolves mission via before-hook capture and heals user to COMPLETED', async () => {
    const admin = await cds.connect.to('AdminService');
    const db    = await cds.connect.to('db');
    const {
      Users, Tutorials, Missions, CompletionPaths, CompletionPathItems, TaskRecords,
    } = cds.entities(NS);
    const { CompletionPathItems: SvcCPI } = cds.entities('AdminService');

    const USER_ID    = 'aaaaaaaa-2732-0001-0000-000000000001';
    const TUT_A_ID   = 'bbbbbbbb-2732-0001-0000-000000000001';  // user has completed this
    const TUT_B_ID   = 'bbbbbbbb-2732-0001-0000-000000000002';  // user has NOT completed this
    const MISS_ID    = 'cccccccc-2732-0001-0000-000000000001';
    const CP_ID      = 'dddddddd-2732-0001-0000-000000000001';
    const CPI_A_ID   = 'eeeeeeee-2732-0001-0000-000000000001';  // CPI for tutorial A
    const CPI_B_ID   = 'eeeeeeee-2732-0001-0000-000000000002';  // CPI for tutorial B (to be deleted)
    const TUT_A_LEGACY  = 93001;
    const TUT_B_LEGACY  = 93002;
    const MISS_LEGACY   = 93500;

    // Fixture: two tutorials in one completion path. User has completed tutorial A
    // but not B. Mission is IN_PROGRESS. When admin deletes CPI_B (the blocking
    // item), reconcile should upgrade the user's mission to COMPLETED.
    await db.run(INSERT.into(Users).entries({
      ID: USER_ID, legacyId: 93100, uuid: 'u-adm-2732-01',
    }));
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
    // Two path items: A (completed by user) and B (not completed).
    await db.run(INSERT.into(CompletionPathItems).entries([
      { ID: CPI_A_ID, path_ID: CP_ID, taskType: 'TUTORIAL', taskLegacyId: TUT_A_LEGACY, itemOrder: 10, legacyId: 93701 },
      { ID: CPI_B_ID, path_ID: CP_ID, taskType: 'TUTORIAL', taskLegacyId: TUT_B_LEGACY, itemOrder: 20, legacyId: 93702 },
    ]));
    // User has completed tutorial A only; mission is IN_PROGRESS.
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

    // Act: Admin DELETEs CPI_B (the tutorial the user hasn't completed).
    // - before('DELETE', 'CompletionPathItems') captures path_ID = CP_ID on req._cpiPathId
    // - DELETE fires
    // - after('DELETE', 'CompletionPathItems') fires, reads req._cpiPathId = CP_ID
    // - resolveMissionLegacyForPath(CP_ID) → Missions.legacyId = 93500
    // - fireReconcile('MISSION', 93500) via setImmediate
    // - reconcile runs: path now has only CPI_A → user has completed tutorial A → COMPLETED
    const adminCtx = { user: { id: 'admin', roles: ['Admin', 'authenticated-user'] } };
    await admin.tx(adminCtx, tx =>
      tx.run(DELETE.from(SvcCPI).where({ ID: CPI_B_ID }))
    );

    // The after-hook is fire-and-forget (setImmediate + own cds.tx).
    // Give it a tick to settle before asserting.
    await new Promise(r => setTimeout(r, 150));

    // Assert: user's MISSION TaskRecord should now be COMPLETED (path has only
    // tutorial A which the user has completed).
    const [row] = await db.run(
      SELECT.from(TaskRecords).where({ user_ID: USER_ID, taskType: 'MISSION' })
    );
    expect(row?.status).toBe('COMPLETED');
  });

  it('DELETE CompletionPathItems fires reconcile without crashing (fail-open contract)', async () => {
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
    // User has COMPLETED mission record.
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

    // Act: Delete the only CPI — this fires the hook without crashing.
    // With 0 slots remaining after delete, reconcile is a no-op (flagged:1),
    // which is correct: an empty path cannot be completed/failed.
    const adminCtx = { user: { id: 'admin', roles: ['Admin', 'authenticated-user'] } };
    await admin.tx(adminCtx, tx =>
      tx.run(DELETE.from(SvcCPI).where({ ID: CPI_ID }))
    );

    await new Promise(r => setTimeout(r, 150));

    // DELETE itself succeeded; hook fired without throwing.
    // Mission row still exists (reconcile is a no-op with empty path).
    const [row] = await db.run(
      SELECT.from(TaskRecords).where({ user_ID: USER_ID, taskType: 'MISSION' })
    );
    expect(row).toBeDefined();
    // With empty path (0 slots), reconcile flags without changing status.
    expect(['COMPLETED', 'IN_PROGRESS']).toContain(row.status);
  });
});
