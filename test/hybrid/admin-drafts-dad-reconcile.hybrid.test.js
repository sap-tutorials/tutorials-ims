// test/hybrid/admin-drafts-dad-reconcile.hybrid.test.js
//
// Task 5 of #2993: HANA-level proof that the after('DISCARD','Missions.drafts')
// reconcile hook still fires under CAP's `deleteStrategy: dad`.
//
// Background (#2993):
//   With `draft_admin_integrity: true` + `deleteStrategy: dad`, discarding a
//   Mission draft deletes only the DraftAdministrativeData row; the DB ON DELETE
//   CASCADE constraint removes all child draft rows (CompletionPathItems.drafts,
//   etc.). This bypasses CAP's per-row after('DELETE') handlers. The project
//   relies on after('DISCARD','Missions.drafts') root handlers (srv/admin-service.js)
//   to call reconcileEntityForUsers — keeping Mission completion rollups correct
//   even when cascade skips the per-row hooks.
//
// This test proves two invariants against REAL HANA (SQLite has no real cascade):
//
//   (a) Reconcile side effect — seed a user whose MISSION TaskRecord is stale
//       IN_PROGRESS (tutorial complete, mission not). After draftEdit→DISCARD,
//       the after('DISCARD') root handler fires reconcile → user heals to
//       COMPLETED. Asserted via vi.waitFor polling the TaskRecords table.
//
//   (b) Zero orphaned child draft rows — after the DISCARD, query the HANA
//       shadow table ADMINSERVICE_COMPLETIONPATHITEMS_DRAFTS by the discarded
//       DraftAdministrativeData_DraftUUID → expect 0 rows. Proves the ON DELETE
//       CASCADE constraint deployed by #2993 is live on the HANA schema.
//
// HARNESS
//   cds.test('serve', '--project', '.', '--profile', 'hybrid') boots the full
//   CAP server with HANA binding. HTTP calls go through adminAuth to trigger the
//   service-layer DISCARD handler. Raw db.run() is used for HANA draft shadow
//   table queries (CDS QL has LOB-locator issues on HANA; draft shadow tables
//   are HANA-only and not exposed as CDS QL targets safely).
//
// SAFETY
//   Gated by isSafeForWrites() (blocks PROD / NODE_ENV=production).
//   All seeded rows use the unique prefix 'dad5-' and are cleaned up in afterAll.
//   IDs sit in the 'dad5-' UUID range; legacyIds use HANA sequences (getNextLegacyId).
//
// HOW TO RUN
//   npm run test:hybrid -- test/hybrid/admin-drafts-dad-reconcile.hybrid.test.js
//   (which expands to: cds bind --exec -- npx vitest run --project hybrid ...)
//   Requires: cf login to eu10-005/tutorial-system/dev.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

// Boot the full CAP server (required so after('DISCARD','Missions.drafts') fires).
// Must be at module level; cds.test resolves before beforeAll runs.
// Override the hybrid profile's xsuaa auth so basic auth (admin:admin) works against
// the cds.test('serve') HTTP listener. The hybrid profile is only needed for the HANA
// db binding; xsuaa auth is irrelevant for in-process tests and has no instance bound
// (mirrors test/hybrid/migration-mode.test.js).
process.env.cds_requires_auth_kind = 'mocked';
// draftEdit triggers the @cap-js/ai RPT-1 recommendation hook (#959), which calls
// real BTP AI Core via _getToken — that 500s ("reading 'url'") when no aicore
// service is bound to the test process. The dad/cascade behaviour under test is
// independent of AI recommendations, so mock AICore for the in-process boot.
process.env.cds_requires_AICore_kind = 'AICore-mocked';
// Full cold boot against remote HANA runs all startup seeders (HomepageShelves,
// JobLocks, config) — each query ~300-600ms over the network — so the 60s hybrid
// default hookTimeout is not enough. Raise to 120s for the cds.test('serve') boot.
vi.setConfig({ hookTimeout: 120_000 });
// This test VERIFIES the dad/cascade behaviour, so it must force those flags ON for
// the in-process boot regardless of which package.json profile is ambient (the flags
// live in base cds.fiori on DEV but may be false in a main-based checkout, and CDS_*
// env-var overrides do NOT reach cds.env.fiori.*). Set them programmatically before
// cds.test resolves. The matching ON DELETE CASCADE constraints must already exist on
// the bound HANA schema (preflight asserts 46/46) — this only flips runtime behaviour.
cds.env.fiori.draft_admin_integrity = true;
cds.env.fiori.draft_orphan_cleanup = true;
cds.env.drafts = { ...cds.env.drafts, deleteStrategy: 'dad' };
const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };
const NS = 'com.sap.developers.ims';

// Unique run ID so concurrent CI runs do not collide on shared DEV HANA.
const RUN_HEX = crypto.randomBytes(4).toString('hex');
const PREFIX = `dad5-${RUN_HEX}`;

// Deterministic UUIDs scoped to this test run: 8-4-4-4-12, all hex.
// RUN_HEX is 8 chars (4 bytes); last segment = RUN_HEX + 4 zero-padding = 12 chars.
// Each entity discriminator is in the first segment (dad50001…dad50005).
const USER_ID = `dad50001-2993-0005-${RUN_HEX.slice(0, 4)}-${RUN_HEX}0000`;
const TUT_ID  = `dad50002-2993-0005-${RUN_HEX.slice(0, 4)}-${RUN_HEX}0000`;
const MISS_ID = `dad50003-2993-0005-${RUN_HEX.slice(0, 4)}-${RUN_HEX}0000`;
const CP_ID   = `dad50004-2993-0005-${RUN_HEX.slice(0, 4)}-${RUN_HEX}0000`;
const CPI_ID  = `dad50005-2993-0005-${RUN_HEX.slice(0, 4)}-${RUN_HEX}0000`;

describe.runIf(isSafeForWrites())('dad deleteStrategy: after(DISCARD) reconcile + zero orphan CPI drafts (#2993 hybrid)', () => {
  let db;
  let TUT_LEGACY;
  let MISS_LEGACY;
  let discardedDraftUUID;

  beforeAll(async () => {
    db = await cds.connect.to('db');

    // Confirm we actually connected to HANA — fail loudly if we fell back to SQLite.
    const kind = db?.options?.kind ?? db?.constructor?.name ?? db?.kind ?? 'unknown';
    const isHana = kind === 'hana' || kind === 'HANAService' || String(kind).toLowerCase().includes('hana');
    if (!isHana) {
      throw new Error(
        `admin-drafts-dad-reconcile.hybrid: expected HANA binding, got kind=${kind}. ` +
        `Run via: npm run test:hybrid -- test/hybrid/admin-drafts-dad-reconcile.hybrid.test.js`
      );
    }

    const { getNextLegacyId } = await import('../../srv/lib/legacy-id.js');
    const { Users, Tutorials, Missions, CompletionPaths, CompletionPathItems, TaskRecords } =
      cds.entities(NS);

    TUT_LEGACY  = await getNextLegacyId('Tutorials', db);
    MISS_LEGACY = await getNextLegacyId('Missions', db);
    const USER_LEGACY = await getNextLegacyId('Users', db);
    const CP_LEGACY   = await getNextLegacyId('CompletionPaths', db);
    const CPI_LEGACY  = await getNextLegacyId('CompletionPathItems', db);
    const TR_TUT_LEG  = await getNextLegacyId('TaskRecords', db);
    const TR_MISS_LEG = await getNextLegacyId('TaskRecords', db);

    // Seed a Tutorial.
    await INSERT.into(Tutorials).entries({
      ID: TUT_ID,
      legacyId: TUT_LEGACY,
      slug: `${PREFIX}-tut`,
      title: `__TEST__ dad5 Tutorial`,
      status: 'ACTIVE',
    });

    // Seed the Mission (published so the discard handler can look up a real legacyId).
    await INSERT.into(Missions).entries({
      ID: MISS_ID,
      legacyId: MISS_LEGACY,
      slug: `${PREFIX}-mission`,
      title: `__TEST__ dad5 Mission`,
      published: true,
    });

    // Seed CompletionPath + CompletionPathItem under the Mission.
    await INSERT.into(CompletionPaths).entries({
      ID: CP_ID,
      legacyId: CP_LEGACY,
      mission_ID: MISS_ID,
      name: `dad5 Path`,
    });
    await INSERT.into(CompletionPathItems).entries({
      ID: CPI_ID,
      legacyId: CPI_LEGACY,
      path_ID: CP_ID,
      taskType: 'TUTORIAL',
      taskLegacyId: TUT_LEGACY,
      itemOrder: 10,
    });

    // Seed the User.
    await INSERT.into(Users).entries({
      ID: USER_ID,
      legacyId: USER_LEGACY,
      uuid: `u-${PREFIX}`,
    });

    // Seed TaskRecords: tutorial COMPLETED, mission stale IN_PROGRESS.
    // This is the reconcile precondition — after DISCARD, the MISSION record
    // should heal to COMPLETED because the tutorial is done.
    const TR_TUT_ID  = crypto.randomUUID();
    const TR_MISS_ID = crypto.randomUUID();
    await INSERT.into(TaskRecords).entries([
      {
        ID: TR_TUT_ID,
        legacyId: TR_TUT_LEG,
        user_ID: USER_ID,
        taskLegacyId: TUT_LEGACY,
        taskType: 'TUTORIAL',
        status: 'COMPLETED',
        progress: 100,
        attemptNumber: 1,
      },
      {
        ID: TR_MISS_ID,
        legacyId: TR_MISS_LEG,
        user_ID: USER_ID,
        taskLegacyId: MISS_LEGACY,
        taskType: 'MISSION',
        status: 'IN_PROGRESS',
        progress: 50,
        attemptNumber: 1,
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    // FK-ordered cleanup: TaskRecords → Users → CPI → CP → Missions → Tutorials.
    // Use raw SQL with UPPER-CASED column names (HANA stores unquoted identifiers uppercase).
    // LIKE on the run-scoped PREFIX to catch rows from crashed prior runs, too.
    try {
      await db.run(
        `DELETE FROM "COM_SAP_DEVELOPERS_IMS_TASKRECORDS" WHERE "USER_ID" = ?`,
        [USER_ID]
      );
      await db.run(
        `DELETE FROM "COM_SAP_DEVELOPERS_IMS_USERS" WHERE "ID" = ?`,
        [USER_ID]
      );
      await db.run(
        `DELETE FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS" WHERE "PATH_ID" = ?`,
        [CP_ID]
      );
      await db.run(
        `DELETE FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS" WHERE "MISSION_ID" = ?`,
        [MISS_ID]
      );
      await db.run(
        `DELETE FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS" WHERE "ID" = ?`,
        [MISS_ID]
      );
      await db.run(
        `DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "ID" = ?`,
        [TUT_ID]
      );
    } catch (err) {
      // Log but don't rethrow — a cleanup failure must not mask test failures.
      console.error('[dad5-afterAll] cleanup error (non-fatal):', err.message);
    }
  }, 60_000);

  it('fires MISSION reconcile when a Mission draft is discarded under dad (hybrid HANA)', async () => {
    const { TaskRecords } = cds.entities(NS);
    const srv = await cds.connect.to('AdminService');

    // ── 1. draftEdit the active Mission ──────────────────────────────────────
    const { status: sEdit } = await project.post(
      `/admin/Missions(ID=${MISS_ID},IsActiveEntity=true)/AdminService.draftEdit`,
      {},
      adminAuth
    );
    expect([200, 201]).toContain(sEdit);

    // ── 2. Capture the DraftAdministrativeData_DraftUUID for the orphan check ─
    // Use srv.entities['Missions'].drafts — the service-entity .drafts accessor.
    // This is SQLite-safe CDS QL on the draft shadow table (no LOB columns selected).
    const [missionDraftRow] = await db.run(
      SELECT.from(srv.entities['Missions'].drafts).where({ ID: MISS_ID })
    );
    expect(missionDraftRow, 'draftEdit must have created a Missions.drafts row').toBeTruthy();
    discardedDraftUUID = missionDraftRow.DraftAdministrativeData_DraftUUID;
    expect(discardedDraftUUID, 'DraftAdministrativeData_DraftUUID must be populated').toBeTruthy();

    // ── 3. Sanity: CompletionPathItems draft rows exist for this UUID ─────────
    // Proves the assertion below is non-vacuous (we CAN detect orphans).
    // Use raw db.run() against the HANA shadow table (ADMINSERVICE_COMPLETIONPATHITEMS_DRAFTS).
    // HANA column names are stored UPPERCASE (unquoted declaration → HANA uppercases them).
    const beforeRows = await db.run(
      `SELECT COUNT(*) AS "CNT" FROM "ADMINSERVICE_COMPLETIONPATHITEMS_DRAFTS"
       WHERE "DRAFTADMINISTRATIVEDATA_DRAFTUUID" = ?`,
      [discardedDraftUUID]
    );
    const beforeCount = beforeRows?.[0]?.CNT ?? beforeRows?.[0]?.cnt ?? 0;
    expect(Number(beforeCount), 'CPI draft rows must exist before DISCARD (sanity — proves orphan detection works)').toBeGreaterThan(0);

    // ── 4. DISCARD the draft ──────────────────────────────────────────────────
    const { status: sDisc } = await project.delete(
      `/admin/Missions(ID=${MISS_ID},IsActiveEntity=false)`,
      adminAuth
    );
    expect([200, 204]).toContain(sDisc);

    // ── 5. Assert (a): reconcile fired — MISSION TaskRecord heals to COMPLETED ─
    // after('DISCARD','Missions.drafts') fires reconcileEntityForUsers via setImmediate.
    // vi.waitFor polls until the side effect lands. Timeout is generous for HANA latency.
    await vi.waitFor(
      async () => {
        const [row] = await db.run(
          SELECT.from(TaskRecords)
            .where({ user_ID: USER_ID, taskType: 'MISSION', taskLegacyId: MISS_LEGACY })
        );
        expect(
          row?.status,
          `MISSION TaskRecord must heal to COMPLETED after dad DISCARD — got ${row?.status}. ` +
          `If undefined: the after('DISCARD') handler may not have fired, or reconcile is failing silently.`
        ).toBe('COMPLETED');
      },
      { timeout: 8000, interval: 100 }
    );

    // ── 6. Assert (b): ZERO orphaned CPI draft rows after the DISCARD ────────
    // Under dad + ON DELETE CASCADE the DB cascade removes child draft rows when
    // DraftAdministrativeData is deleted. Zero rows here proves the cascade is live.
    const afterRows = await db.run(
      `SELECT COUNT(*) AS "CNT" FROM "ADMINSERVICE_COMPLETIONPATHITEMS_DRAFTS"
       WHERE "DRAFTADMINISTRATIVEDATA_DRAFTUUID" = ?`,
      [discardedDraftUUID]
    );
    const afterCount = afterRows?.[0]?.CNT ?? afterRows?.[0]?.cnt ?? 0;
    expect(
      Number(afterCount),
      `ADMINSERVICE_COMPLETIONPATHITEMS_DRAFTS must have 0 rows for draft UUID ${discardedDraftUUID} after DISCARD. ` +
      `Non-zero means ON DELETE CASCADE constraints are not in place — the #2993 cascade deploy must be completed first.`
    ).toBe(0);
  }, 30_000);
});
