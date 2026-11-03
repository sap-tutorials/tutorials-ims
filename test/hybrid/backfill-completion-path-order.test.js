// test/hybrid/backfill-completion-path-order.test.js
// Hybrid HANA contract regression for #2990 — exercises the backfill script's
// per-row UPDATE statements directly against HANA via cds bind --exec.
// Mirrors test/hybrid/repair-mission-completion-path-data.test.js (PR #436).

import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isSafeForWrites } from './_guard.js';
import { backfill, planBackfill, resolveImsEntities } from '../../scripts/backfill-completion-path-order.cjs';

const TEST_PREFIX = '__TEST__2990-backfill-';

describe('backfill-completion-path-order (#2990) — HANA', () => {
  let db;
  let ims;

  beforeAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
      throw new Error('Hybrid writes require ALLOW_HYBRID_WRITES=true');
    }
    if (!isSafeForWrites()) {
      throw new Error('Refusing to run hybrid writes against production');
    }
    db = await cds.connect.to('db');
    ims = await resolveImsEntities(cds);
  });

  afterAll(async () => {
    // Clean up any test missions and their paths.
    const { Missions, CompletionPaths } = ims;
    const testMissions = await db.run(
      SELECT.from(Missions).columns('ID').where(`title like '${TEST_PREFIX}%'`)
    );
    for (const m of testMissions) {
      await db.run(DELETE.from(CompletionPaths).where({ mission_ID: m.ID }));
    }
    await db.run(DELETE.from(Missions).where(`title like '${TEST_PREFIX}%'`));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Core test: C/A/B all NULL → A=10, B=20, C=30 (alphabetical)
  // ─────────────────────────────────────────────────────────────────────────
  it('assigns pathOrder A=10, B=20, C=30 for paths named "C","A","B" all NULL', async () => {
    const { Missions, CompletionPaths } = ims;
    const missionId = cds.utils.uuid();

    await db.run(INSERT.into(Missions).entries({
      ID: missionId,
      title: `${TEST_PREFIX}core-alpha`,
      status: 'ACTIVE',
    }));

    const pathC = cds.utils.uuid();
    const pathA = cds.utils.uuid();
    const pathB = cds.utils.uuid();

    await db.run(INSERT.into(CompletionPaths).entries(
      { ID: pathC, mission_ID: missionId, name: 'C', pathOrder: null },
      { ID: pathA, mission_ID: missionId, name: 'A', pathOrder: null },
      { ID: pathB, mission_ID: missionId, name: 'B', pathOrder: null },
    ));

    // Run backfill in commit mode.
    const result = await backfill({ cdsInstance: cds, commit: true });
    expect(result.updated).toBeGreaterThanOrEqual(3);

    // Assert alphabetical assignment.
    const rows = await db.run(
      SELECT.from(CompletionPaths)
        .columns('ID', 'name', 'pathOrder')
        .where({ mission_ID: missionId })
    );
    const byName = Object.fromEntries(rows.map(r => [r.name, r.pathOrder]));
    expect(byName['A']).toBe(10);
    expect(byName['B']).toBe(20);
    expect(byName['C']).toBe(30);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Idempotency: second run finds no NULL rows for this mission
  // ─────────────────────────────────────────────────────────────────────────
  it('is idempotent — second run finds no NULL pathOrder rows for the mission', async () => {
    const { Missions, CompletionPaths } = ims;
    const missionId = cds.utils.uuid();

    await db.run(INSERT.into(Missions).entries({
      ID: missionId,
      title: `${TEST_PREFIX}idempotency`,
      status: 'ACTIVE',
    }));
    await db.run(INSERT.into(CompletionPaths).entries(
      { ID: cds.utils.uuid(), mission_ID: missionId, name: 'C', pathOrder: null },
      { ID: cds.utils.uuid(), mission_ID: missionId, name: 'A', pathOrder: null },
      { ID: cds.utils.uuid(), mission_ID: missionId, name: 'B', pathOrder: null },
    ));

    // First run.
    await backfill({ cdsInstance: cds, commit: true });

    // Second run should find no NULL rows for this mission.
    const plan = await planBackfill(db, ims);
    const missionPlan = plan.find(m => m.missionId === missionId);
    expect(missionPlan).toBeUndefined();

    // verify-only: this mission contributes 0 rows to the NULL count.
    const rows = await db.run(
      SELECT.from(CompletionPaths)
        .columns('pathOrder')
        .where({ mission_ID: missionId })
        .where('pathOrder IS NULL')
    );
    expect(rows.length).toBe(0);
  });
});
