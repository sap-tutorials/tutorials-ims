// test/hybrid/kg-community-coverage.hybrid.test.js
//
// Hybrid test for the KG community curator-assist coverage nudges (#1172).
// Exercises the after('READ','KgCommunities') coverage decorator in
// srv/admin-service.js against real HANA. Three cases:
//
//   1. Coverage round-trip  — seeded community (3 pub-covered, 1 draft-covered,
//      1 orphan) reads back with correct missionCoveragePct / orphanTutorialCount /
//      dominantMissionTitle / dominantMissionSlug / coverageHigh values.
//
//   2. Packet-safe width    — community with >500 tutorial members forces the
//      chunked .in() loop (COVERAGE_SLUG_CHUNK = 500) to iterate > once.
//      Asserts the read succeeds and yields a numeric missionCoveragePct —
//      proves the chunked queries stay under HANA's bound-param cap.
//      SQLite unit tests would never catch an unbounded .in() overflow.
//
//   3. Fail-quiet catch     — temporarily replace cds.entities so the coverage
//      decorator's try-block throws. Asserts the read still succeeds and
//      returns a row, but coverage fields are unset (null/undefined). This is
//      the ONLY test covering the fail-quiet catch branch.
//
// BOOTSTRAP
//   cds.test('serve', ...) boots the full CAP server (model + AdminService +
//   after('READ') decorators all wired up). Required for the decorators to fire
//   when reading through AdminService.
//
//   Reading through AdminService requires the 'Admin' role. We use
//   `admin.tx({ user: new cds.User.Privileged() }, ...)` which bypasses all
//   authorization checks while still triggering the after('READ') decorator.
//   This matches the pattern in test/hybrid/concepts-published-view.test.js.
//
// SEEDING
//   INSERT.into(entity) calls bypass service auth and write directly to the DB
//   (same pattern as test/hybrid/admin-crud.test.js). Raw SQL via db.run() is
//   used for KgCommunity rows (entity is @cds.autoexpose:false).
//
// COLUMN NAME CASING
//   HANA stores unquoted column names UPPERCASE. Raw SQL must use quoted
//   UPPERCASE names (e.g. "SLUG", "COMMUNITYID"). CQL INSERT.into() handles
//   this automatically. LOWER("SLUG") — not LOWER("slug") — in WHERE clauses.
//
// SAFETY
//   Gated by isSafeForWrites(). All fixture slugs use `__test__kg-comm-cov-`
//   so cleanup via LOWER("SLUG") LIKE '...' is deterministic. Cleanup in
//   afterAll respects FK order: CompletionPathItems → CompletionPaths →
//   Missions → KgCommunity → Tutorials.
//
// HOW TO RUN
//   npx cds bind --exec -- npx vitest run --project hybrid \
//     test/hybrid/kg-community-coverage.hybrid.test.js

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import crypto from 'node:crypto';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

// Boot the full CAP server (required so after('READ','KgCommunities') fires).
// Must be at module level; cds.test resolves before beforeAll runs.
cds.test('serve', '--project', '.', '--profile', 'hybrid');

const TEST_PREFIX = `__test__kg-comm-cov-`;
const RUN_HEX = crypto.randomBytes(3).toString('hex');   // 6 hex chars
const RUN_ID = `${Date.now()}-${RUN_HEX}`;
const P = `${TEST_PREFIX}${RUN_ID}-`;

// Collision-safe communityId range: Louvain IDs in production are ~thousands.
// Test IDs in 9_900_000+ range are safe to use temporarily.
const RUN_INT = parseInt(RUN_HEX, 16) % 50_000;  // 0-49999
const COMM_ID_1 = 9_900_000 + RUN_INT;            // round-trip + fail-quiet
const COMM_ID_2 = 9_950_000 + RUN_INT;            // packet-safe

// HANA table — columns stored UPPERCASE (unquoted at declaration → HANA uppercases).
const KGCOMMUNITY_TABLE = '"COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY"';
const KGCOMMUNITY_INSERT_SQL = `INSERT INTO ${KGCOMMUNITY_TABLE}
  ("COMMUNITYID","VERTEXKEY","VERTEXTYPE","SLUG","DETECTEDAT","COMMUNITYFINGERPRINT")
  VALUES (?, ?, ?, ?, ?, ?)`;
const NOW = new Date().toISOString();

// ── Round-trip fixture (COMM_ID_1) ────────────────────────────────────────────
// 5 tutorials in the community:
//   T1, T2, T3 — in a PUBLISHED mission (covered)
//   T4         — in a DRAFT-only mission (must NOT count toward coverage)
//   T5         — true orphan (no mission)
//
// Expected:
//   missionCoveragePct   = 60   (3/5 * 100, rounded)
//   orphanTutorialCount  = 2    (T4 + T5)
//   dominantMissionSlug  = `${P}mission-pub`
//   dominantMissionTitle = 'Published Mission'
//   coverageHigh         = false (60 < 70 default threshold)
const T_SLUGS = [1, 2, 3, 4, 5].map((n) => `${P}t${n}`);
const missionPubId   = crypto.randomUUID();
const missionDraftId = crypto.randomUUID();
const pathPubId      = crypto.randomUUID();
const pathDraftId    = crypto.randomUUID();
const itemPubIds     = [0, 1, 2].map(() => crypto.randomUUID());
const itemDraftId    = crypto.randomUUID();

// ── Packet-safe fixture (COMM_ID_2) ───────────────────────────────────────────
// 510 tutorials (> COVERAGE_SLUG_CHUNK = 500) → chunk loop iterates > once.
const BIG_COUNT = 510;
const BIG_SLUGS = Array.from({ length: BIG_COUNT }, (_, i) => `${P}big-${i + 1}`);

let db;
let tutorialIdBySlug;

describe('KgCommunities coverage nudges (hybrid, real HANA) #1172', () => {

  beforeAll(async () => {
    if (!isSafeForWrites()) throw new Error('kg-community-coverage: write-safety guard refused');
    process.env.ALLOW_HYBRID_WRITES = 'true';

    db = await cds.connect.to('db');
    const kind = db.options?.kind || db.constructor?.name;
    if (!(kind === 'hana' || kind === 'HANAService')) {
      throw new Error(`kg-community-coverage: expected HANA binding, got ${kind}. Run via cds bind.`);
    }

    const { Tutorials, Missions, CompletionPaths, CompletionPathItems } =
      cds.entities('com.sap.developers.ims');

    // ── Seed tutorials ──────────────────────────────────────────────────────
    // INSERT.into() bypasses service auth and writes directly to the DB.
    // Batch at 500 to avoid HANA's bound-param packet cap (515 slugs total).
    const allSlugs = [...T_SLUGS, ...BIG_SLUGS];
    const TUT_INSERT_BATCH = 500;
    for (let i = 0; i < allSlugs.length; i += TUT_INSERT_BATCH) {
      await INSERT.into(Tutorials).entries(
        allSlugs.slice(i, i + TUT_INSERT_BATCH).map((slug) => ({
          slug,
          title: `Coverage test ${slug}`,
          status: 'ACTIVE',
        })),
      );
    }

    // Fetch auto-generated UUIDs for T_SLUGS (needed as tutorial_ID in path items).
    const tutRows = await SELECT.from(Tutorials).columns('ID', 'slug').where({ slug: { in: T_SLUGS } });
    tutorialIdBySlug = Object.fromEntries(tutRows.map((r) => [r.slug, r.ID]));

    // ── Seed missions + paths for round-trip community ──────────────────────
    // Published mission covering T1, T2, T3.
    await INSERT.into(Missions).entries({
      ID: missionPubId,
      title: 'Published Mission',
      slug: `${P}mission-pub`,
      published: true,
      status: 'ACTIVE',
    });
    await INSERT.into(CompletionPaths).entries({
      ID: pathPubId,
      mission_ID: missionPubId,
      name: 'Path Pub',
      slug: `${P}path-pub`,
    });
    await INSERT.into(CompletionPathItems).entries([
      { ID: itemPubIds[0], path_ID: pathPubId, taskType: 'TUTORIAL', tutorial_ID: tutorialIdBySlug[T_SLUGS[0]], itemOrder: 1 },
      { ID: itemPubIds[1], path_ID: pathPubId, taskType: 'TUTORIAL', tutorial_ID: tutorialIdBySlug[T_SLUGS[1]], itemOrder: 2 },
      { ID: itemPubIds[2], path_ID: pathPubId, taskType: 'TUTORIAL', tutorial_ID: tutorialIdBySlug[T_SLUGS[2]], itemOrder: 3 },
    ]);

    // Draft mission covering T4 — must NOT count toward coverage.
    await INSERT.into(Missions).entries({
      ID: missionDraftId,
      title: 'Draft Mission',
      slug: `${P}mission-draft`,
      published: false,
      status: 'ACTIVE',
    });
    await INSERT.into(CompletionPaths).entries({
      ID: pathDraftId,
      mission_ID: missionDraftId,
      name: 'Path Draft',
      slug: `${P}path-draft`,
    });
    await INSERT.into(CompletionPathItems).entries([
      { ID: itemDraftId, path_ID: pathDraftId, taskType: 'TUTORIAL', tutorial_ID: tutorialIdBySlug[T_SLUGS[3]], itemOrder: 1 },
    ]);

    // ── Seed KgCommunity rows (raw SQL — @cds.autoexpose:false entity) ──────
    // Columns are stored UPPERCASE in HANA; raw SQL must use quoted uppercase.
    // Round-trip community: 5 tutorial members.
    const comm1Batch = T_SLUGS.map((slug) => [
      COMM_ID_1, `tutorial:${slug}`, 'tutorial', slug, NOW, null,
    ]);
    await db.run(KGCOMMUNITY_INSERT_SQL, comm1Batch);

    // Packet-safe community: 510 tutorial members.
    // Split at 500 (mirrors production INSERT_BATCH_SIZE in kg-communities-job.js)
    // so the KgCommunity INSERT itself doesn't hit HANA's batch-param limit.
    const KGCOMMUNITY_INSERT_BATCH = 500;
    const comm2Rows = BIG_SLUGS.map((slug) => [COMM_ID_2, `tutorial:${slug}`, 'tutorial', slug, NOW, null]);
    for (let i = 0; i < comm2Rows.length; i += KGCOMMUNITY_INSERT_BATCH) {
      await db.run(KGCOMMUNITY_INSERT_SQL, comm2Rows.slice(i, i + KGCOMMUNITY_INSERT_BATCH));
    }
  }, 180_000);

  afterAll(async () => {
    if (!db) return;
    // FK-ordered cleanup mirrors test/hybrid/kg-communities.test.js.
    // Column-name quoting must match what HANA actually stored:
    //   KgCommunity (generated .hdbtable)    → "VERTEXKEY", "COMMUNITYID" (uppercase)
    //   Missions / CompletionPaths / CPI
    //   (.hdbmigrationtable, cds-compiler)   → "slug", "path_ID", "mission_ID" (as declared)
    // LIKE on TEST_PREFIX catches rows from crashed prior runs.
    await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"
      WHERE "path_ID" IN (SELECT "ID" FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"
      WHERE "mission_ID" IN (SELECT "ID" FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS"
      WHERE LOWER("slug") LIKE '__test__kg-comm-cov-%'))`);
    await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"
      WHERE "mission_ID" IN (SELECT "ID" FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS"
      WHERE LOWER("slug") LIKE '__test__kg-comm-cov-%')`);
    await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS"
      WHERE LOWER("slug") LIKE '__test__kg-comm-cov-%'`);
    await db.run(`DELETE FROM ${KGCOMMUNITY_TABLE}
      WHERE LOWER("VERTEXKEY") LIKE 'tutorial:__test__kg-comm-cov-%'`);
    await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
      WHERE LOWER("slug") LIKE '__test__kg-comm-cov-%'`);
  }, 60_000);

  // ── Case 1: Coverage round-trip ──────────────────────────────────────────
  it('coverage round-trip: pct / orphan / dominant / coverageHigh from real HANA', async () => {
    // Read THROUGH AdminService so after('READ','KgCommunities') fires.
    // cds.User.Privileged bypasses @requires:'Admin' authorization while still
    // routing through the service (and its after-READ decorators).
    // Pattern from test/hybrid/concepts-published-view.test.js.
    const admin = await cds.connect.to('AdminService');
    const rows = await admin.tx(
      { user: new cds.User.Privileged() },
      (tx) => tx.read('KgCommunities').where({ communityId: COMM_ID_1 }),
    );
    expect(rows.length).toBeGreaterThan(0);

    const row = rows[0];

    // Confirm the decorator fired (fields are set, not null).
    // 3 published-covered / 5 total → 60 %.
    expect(row.missionCoveragePct).toBe(60);

    // T4 (draft-only) + T5 (true orphan) = 2 orphans.
    expect(row.orphanTutorialCount).toBe(2);

    // Only the published mission covers tutorials → it is dominant.
    expect(row.dominantMissionSlug).toBe(`${P}mission-pub`);
    expect(row.dominantMissionTitle).toBe('Published Mission');

    // 60 < 70 (default KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD) → false.
    expect(row.coverageHigh).toBe(false);
  }, 60_000);

  // ── Case 2: Packet-safe width ────────────────────────────────────────────
  // 510 tutorial members forces COVERAGE_SLUG_CHUNK=500 loop to iterate twice.
  // Unbounded .in() would blow HANA's bound-param cap; chunked code must not.
  it('packet-safe: 510-member community reads without HANA bound-param overflow', async () => {
    const admin = await cds.connect.to('AdminService');
    const rows = await admin.tx(
      { user: new cds.User.Privileged() },
      (tx) => tx.read('KgCommunities').where({ communityId: COMM_ID_2 }),
    );
    expect(rows.length).toBeGreaterThan(0);

    const row = rows[0];

    // No missions seeded → all 510 orphans, coverage = 0.
    // The key assertion: the value is numeric (no thrown error / undefined).
    expect(typeof row.missionCoveragePct).toBe('number');
    expect(row.missionCoveragePct).toBe(0);
    expect(row.orphanTutorialCount).toBe(BIG_COUNT);
  }, 120_000);

  // ── Case 3: Fail-quiet catch branch ─────────────────────────────────────
  // Inject a throw into the coverage computation by temporarily replacing
  // cds.entities so that the SECOND call with `com.sap.developers.ims`
  // (the one inside the coverage decorator's try/catch) throws, while the
  // FIRST call (inside the topConceptSlugs decorator which has NO try/catch)
  // is allowed to succeed.
  //
  // Both after('READ','KgCommunities') decorators call
  // `cds.entities('com.sap.developers.ims')`:
  //   - topConceptSlugs (line ~2879): first call, no try/catch → must succeed
  //   - coverage nudges (line ~2933): second call, has its own try/catch → inject throw here
  //
  // The counter approach lets call #1 through and throws on call #2. The
  // coverage decorator's catch block catches the throw, warn-logs, and
  // leaves fields unset. The read still returns the row successfully.
  //
  // This is the ONLY test covering the fail-quiet catch branch in
  // srv/admin-service.js around line 3016-3020.
  it('fail-quiet: decorator catch branch leaves fields unset; read still succeeds', async () => {
    const admin = await cds.connect.to('AdminService');

    // Capture the REAL entities function before patching, so the first call
    // (topConceptSlugs decorator, no try/catch) can still succeed.
    const realEntitiesFn = cds.entities;   // grabs the current getter result

    // Counter: first call (topConceptSlugs decorator) succeeds; second
    // call (coverage decorator) throws.
    let callCount = 0;
    Object.defineProperty(cds, 'entities', {
      configurable: true,
      enumerable: false,
      get() {
        return function(ns, ...rest) {
          if (ns === 'com.sap.developers.ims') {
            callCount += 1;
            if (callCount >= 2) {
              throw new Error('injected-failure-for-fail-quiet-test');
            }
          }
          // First call and any non-ims namespace: delegate to the real function.
          // `entities` does not use `this`, so call directly.
          if (typeof realEntitiesFn === 'function') return realEntitiesFn(ns, ...rest);
          // If the getter returned an object (old CAP style), return it as-is.
          if (realEntitiesFn && typeof realEntitiesFn === 'object') return realEntitiesFn;
          // Fallback: re-evaluate through prototype.
          const proto = Object.getPrototypeOf(cds);
          const pd = Object.getOwnPropertyDescriptor(proto, 'entities');
          const fn = pd?.get?.call(cds);
          if (typeof fn === 'function') return fn(ns, ...rest);
          return fn;
        };
      },
    });

    let rows;
    try {
      rows = await admin.tx(
        { user: new cds.User.Privileged() },
        (tx) => tx.read('KgCommunities').where({ communityId: COMM_ID_1 }),
      );
    } finally {
      // Always restore — even on unexpected throws.
      delete cds.entities;
    }

    // The read must succeed (no 500), returning a row.
    expect(rows).toBeDefined();
    expect(rows.length).toBeGreaterThan(0);

    const row = rows[0];

    // Coverage fields MUST be unset (null/undefined). The coverage decorator's
    // try/catch caught the injected throw and did NOT assign them.
    expect(row.missionCoveragePct == null).toBe(true);
    expect(row.orphanTutorialCount == null).toBe(true);
    expect(row.coverageHigh == null).toBe(true);
    expect(row.dominantMissionSlug == null).toBe(true);
    expect(row.dominantMissionTitle == null).toBe(true);

    // communityId (DB-persisted column) must be present.
    expect(row.communityId).toBe(COMM_ID_1);

    // Confirm the injection fired (second call threw).
    expect(callCount).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
