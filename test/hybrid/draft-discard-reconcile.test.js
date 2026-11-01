// test/hybrid/draft-discard-reconcile.test.js
//
// #2909 — hybrid (real HANA) verification of optimized draft deletion
// (cds.fiori.draft_admin_integrity). When a Mission draft is discarded, the
// DB cascade removes the draft composition children (CompletionPathItems),
// bypassing the per-row after('DELETE') reconcile hooks. The root
// after('DISCARD','Missions.drafts') handler must still reconcile the parent
// Mission rollup.
//
// Scenario: an active Mission has one CompletionPath → CPI → tutorial. A user
// completed the tutorial but their MISSION TaskRecord is stale IN_PROGRESS.
// We draftEdit the Mission (creating a draft) then discard it; the DISCARD
// handler fires reconcile for the active Mission's legacyId, healing the
// stale record to COMPLETED.
//
// Runs against HANA via `npm run test:hybrid` (cds bind --exec … --project hybrid).
// Guarded by isSafeForWrites() so it never runs against a prod DB. Idempotent:
// supporting rows are keyed by high legacyId (outside real-data range) and
// cleaned up in afterAll; the Mission draft is cleared via the HTTP active
// delete (which removes draft + active, avoiding orphaned draft-shadow rows).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

const NS = 'com.sap.developers.ims';
// Stable legacy IDs well outside real-data range.
const USER_LEGACY = 990901;
const TUT_LEGACY  = 990902;
const MISS_LEGACY = 990903;
const CP_LEGACY   = 990904;
const CPI_LEGACY  = 990905;

describe.runIf(isSafeForWrites())('draft DISCARD reconcile on real HANA (#2909)', () => {
  let userID, tutID, missID, cpID;

  async function wipeByLegacy() {
    const { Users, Tutorials, Missions, CompletionPaths, CompletionPathItems, TaskRecords } = cds.entities(NS);
    // Resolve the (possibly auto-generated) user ID so we can clear its TaskRecords.
    const [u] = await SELECT.from(Users).columns('ID').where({ legacyId: USER_LEGACY });
    if (u?.ID) await DELETE.from(TaskRecords).where({ user_ID: u.ID });
    await DELETE.from(CompletionPathItems).where({ legacyId: CPI_LEGACY });
    await DELETE.from(CompletionPaths).where({ legacyId: CP_LEGACY });
    await DELETE.from(Missions).where({ legacyId: MISS_LEGACY });
    await DELETE.from(Tutorials).where({ legacyId: TUT_LEGACY });
    await DELETE.from(Users).where({ legacyId: USER_LEGACY });
  }

  beforeAll(async () => {
    const { Users, Tutorials, Missions, CompletionPaths, CompletionPathItems, TaskRecords } = cds.entities(NS);
    // Idempotent: clear any residue from a prior aborted run first.
    await wipeByLegacy();

    // Seed; let CAP generate UUID keys, then read them back by legacyId.
    await INSERT.into(Users).entries({ legacyId: USER_LEGACY, uuid: 'test-2909-uuid' });
    await INSERT.into(Tutorials).entries({ legacyId: TUT_LEGACY, slug: 'test-2909-discard-tut', title: '__TEST__ 2909 Tut', status: 'ACTIVE' });
    await INSERT.into(Missions).entries({ legacyId: MISS_LEGACY, title: '__TEST__ 2909 Mission', published: true });

    [{ ID: userID }] = await SELECT.from(Users).columns('ID').where({ legacyId: USER_LEGACY });
    [{ ID: tutID }]  = await SELECT.from(Tutorials).columns('ID').where({ legacyId: TUT_LEGACY });
    [{ ID: missID }] = await SELECT.from(Missions).columns('ID').where({ legacyId: MISS_LEGACY });

    await INSERT.into(CompletionPaths).entries({ legacyId: CP_LEGACY, mission_ID: missID, name: '__TEST__ 2909 Path' });
    [{ ID: cpID }] = await SELECT.from(CompletionPaths).columns('ID').where({ legacyId: CP_LEGACY });
    await INSERT.into(CompletionPathItems).entries({ legacyId: CPI_LEGACY, path_ID: cpID, taskType: 'TUTORIAL', taskLegacyId: TUT_LEGACY, itemOrder: 10 });

    // User completed the tutorial but their MISSION rollup is stale IN_PROGRESS.
    await INSERT.into(TaskRecords).entries([
      { user_ID: userID, taskLegacyId: TUT_LEGACY, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 990906, attemptNumber: 1 },
      { user_ID: userID, taskLegacyId: MISS_LEGACY, taskType: 'MISSION', status: 'IN_PROGRESS', progress: 50, legacyId: 990907, attemptNumber: 1 },
    ]);
  });

  afterAll(async () => {
    // Clear any live Mission draft via the HTTP active delete (removes draft +
    // active together, no orphaned draft-shadow rows), then wipe supporting rows.
    if (missID) {
      await project.delete(`/admin/Missions(ID=${missID},IsActiveEntity=true)`, { ...adminAuth, validateStatus: () => true }).catch(() => {});
    }
    await wipeByLegacy();
  });

  it('heals a stale MISSION rollup when a Mission draft is discarded', async () => {
    const { TaskRecords } = cds.entities(NS);
    const db = await cds.connect.to('db');

    // draftEdit the active Mission (creates a draft), then discard the draft.
    const edit = await project.post(
      `/admin/Missions(ID=${missID},IsActiveEntity=true)/AdminService.draftEdit`,
      {}, { ...adminAuth, validateStatus: () => true }
    );
    expect([200, 201]).toContain(edit.status);

    const disc = await project.delete(
      `/admin/Missions(ID=${missID},IsActiveEntity=false)`,
      { ...adminAuth, validateStatus: () => true }
    );
    expect([200, 204]).toContain(disc.status);

    // after('DISCARD','Missions.drafts') fires detached reconcile; poll for heal.
    let healed = false;
    for (let i = 0; i < 30 && !healed; i++) {
      const [row] = await db.run(
        SELECT.from(TaskRecords).where({ user_ID: userID, taskType: 'MISSION', taskLegacyId: MISS_LEGACY })
      );
      if (row?.status === 'COMPLETED') healed = true;
      else await new Promise(r => setTimeout(r, 300));
    }
    expect(healed).toBe(true);
  });
});
