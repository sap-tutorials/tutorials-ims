// test/admin-drafts-cascade-gate.test.js
//
// Flag-agnostic gate test for #2993: Mission draftEdit → discard must leave
// zero orphaned child CompletionPathItems draft rows, regardless of whether
// cds.fiori.draft_admin_integrity is true or false.
//
// When draft_admin_integrity is OFF (current default): CAP's built-in draft
// discard deletes the parent Missions draft and its composition children
// (CompletionPaths + CompletionPathItems) in the same operation. The child
// draft rows are removed before any after('DISCARD') hook fires.
//
// When draft_admin_integrity is ON (#2993 target): a DB-level CASCADE constraint
// is added so the same deletion cascade still removes child draft rows even
// though CAP 10.2 changes the discard implementation.
//
// This test proves the invariant holds NOW (flag OFF) so it will turn red
// the moment a future flag-on or schema change breaks the cascade — acting as
// the re-enable gate described in the #2993 design doc.
//
// Harness: cds.test('serve', '--project', '.', '--in-memory') + adminAuth HTTP,
// matching test/admin-drafts-discard-reconcile.test.js. All seeded rows use the
// 93xxx legacyId range to avoid collisions with 92xxx rows in that file.
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };
const NS = 'com.sap.developers.ims';

describe('Mission draftEdit→discard leaves zero child draft orphans (#2993 gate)', () => {
  // ─── A) Mission with one CompletionPath + one CompletionPathItem ─────────
  // Seed an active Mission composition hierarchy, draftEdit it, confirm
  // CompletionPathItems.drafts rows exist for the draft UUID (sanity), then
  // discard and assert zero CompletionPathItems.drafts remain for that UUID.
  it('leaves zero CompletionPathItems draft rows after Mission draftEdit→discard', async () => {
    const db  = await cds.connect.to('db');
    const srv = await cds.connect.to('AdminService');
    const { Tutorials, Missions, CompletionPaths, CompletionPathItems } = cds.entities(NS);

    // Unique IDs in the 93xxx range — distinct from the 92xxx range in
    // admin-drafts-discard-reconcile.test.js to avoid collision.
    const MISS_ID = 'cccccccc-2993-0001-0000-000000000001';
    const CP_ID   = 'dddddddd-2993-0001-0000-000000000001';
    const CPI_ID  = 'eeeeeeee-2993-0001-0000-000000000001';
    const TUT_ID  = 'bbbbbbbb-2993-0001-0000-000000000001';
    const TUT_LEGACY  = 93001;
    const MISS_LEGACY = 93501;

    // Seed active entities.
    await db.run(INSERT.into(Tutorials).entries({
      ID: TUT_ID, legacyId: TUT_LEGACY, slug: 'cascade-gate-tut-01',
      title: 'Cascade Gate Tut 01', status: 'ACTIVE',
    }));
    await db.run(INSERT.into(Missions).entries({
      ID: MISS_ID, legacyId: MISS_LEGACY,
      title: '__TEST__ Cascade Gate Mission 01', published: false,
    }));
    await db.run(INSERT.into(CompletionPaths).entries({
      ID: CP_ID, mission_ID: MISS_ID, legacyId: 93601, name: 'Cascade Gate Path',
    }));
    await db.run(INSERT.into(CompletionPathItems).entries({
      ID: CPI_ID, path_ID: CP_ID, taskType: 'TUTORIAL',
      taskLegacyId: TUT_LEGACY, itemOrder: 10, legacyId: 93701,
    }));

    // draftEdit the active Mission.
    const { status: sEdit } = await project.post(
      `/admin/Missions(ID=${MISS_ID},IsActiveEntity=true)/AdminService.draftEdit`, {}, adminAuth
    );
    expect([200, 201]).toContain(sEdit);

    // Capture the DraftAdministrativeData_DraftUUID from the Missions.drafts row.
    // srv.entities['Missions'].drafts is the draft-shadow entity exposed by the
    // AdminService runtime (the .drafts accessor is on service entities, not raw
    // model entities from cds.entities(NS)).
    const [missionDraftRow] = await db.run(
      SELECT.from(srv.entities['Missions'].drafts).where({ ID: MISS_ID })
    );
    expect(missionDraftRow).toBeTruthy();
    const draftUUID = missionDraftRow.DraftAdministrativeData_DraftUUID;
    expect(draftUUID).toBeTruthy();

    // Sanity: CompletionPathItems.drafts for this UUID must be non-empty
    // (proves the test can detect orphans — the assertion is non-vacuous).
    const before = await db.run(
      SELECT.from(srv.entities['CompletionPathItems'].drafts)
        .where({ DraftAdministrativeData_DraftUUID: draftUUID })
    );
    expect(before.length).toBeGreaterThan(0);

    // Discard the draft.
    const { status: sDisc } = await project.delete(
      `/admin/Missions(ID=${MISS_ID},IsActiveEntity=false)`, adminAuth
    );
    expect([200, 204]).toContain(sDisc);

    // Gate assertion: zero CompletionPathItems.drafts must remain after discard.
    const after = await db.run(
      SELECT.from(srv.entities['CompletionPathItems'].drafts)
        .where({ DraftAdministrativeData_DraftUUID: draftUUID })
    );
    expect(after).toHaveLength(0);
  });

  // ─── B) Empty-composition Mission (no child items) ───────────────────────
  // A Mission with no CompletionPaths at all should draftEdit and discard
  // cleanly, resulting in zero orphaned child draft rows (trivially zero in,
  // zero out — but ensures the code path does not throw on an empty hierarchy).
  it('discard of a Mission draft with no child items leaves zero orphans', async () => {
    const db  = await cds.connect.to('db');
    const srv = await cds.connect.to('AdminService');
    const { Missions } = cds.entities(NS);

    const MISS_ID2     = 'cccccccc-2993-0002-0000-000000000001';
    const MISS_LEGACY2 = 93502;

    // Seed active Mission with no CompletionPaths / CompletionPathItems.
    await db.run(INSERT.into(Missions).entries({
      ID: MISS_ID2, legacyId: MISS_LEGACY2,
      title: '__TEST__ Cascade Gate Mission 02 (empty)', published: false,
    }));

    // draftEdit.
    const { status: sEdit } = await project.post(
      `/admin/Missions(ID=${MISS_ID2},IsActiveEntity=true)/AdminService.draftEdit`, {}, adminAuth
    );
    expect([200, 201]).toContain(sEdit);

    // Capture draft UUID via service entity's .drafts accessor.
    const [missionDraftRow] = await db.run(
      SELECT.from(srv.entities['Missions'].drafts).where({ ID: MISS_ID2 })
    );
    expect(missionDraftRow).toBeTruthy();
    const draftUUID = missionDraftRow.DraftAdministrativeData_DraftUUID;
    expect(draftUUID).toBeTruthy();

    // Discard.
    const { status: sDisc } = await project.delete(
      `/admin/Missions(ID=${MISS_ID2},IsActiveEntity=false)`, adminAuth
    );
    expect([200, 204]).toContain(sDisc);

    // Zero orphans expected (and zero before, so this is a clean-pass assertion).
    const after = await db.run(
      SELECT.from(srv.entities['CompletionPathItems'].drafts)
        .where({ DraftAdministrativeData_DraftUUID: draftUUID })
    );
    expect(after).toHaveLength(0);
  });
});
