// test/unit/backfill-completion-path-order.test.js
//
// Unit tests for scripts/backfill-completion-path-order.cjs (#2990).
// Exercises the exported backfill/planBackfill functions against in-memory
// SQLite (the npm test path — no HANA or cf login needed).

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Boot CAP with in-memory SQLite once for this file.
cds.test('serve', '--project', '.', '--in-memory');

// Import the exported functions from the CJS script.
// Dynamic import works here because vitest handles CJS/ESM interop.
const { backfill, planBackfill } = await import('../../scripts/backfill-completion-path-order.cjs');

const NS = 'com.sap.developers.ims';
const TEST_PREFIX = '__TEST__2990-backfill-';

describe('backfill-completion-path-order (#2990) — in-memory SQLite', () => {
  let db;
  let Missions, CompletionPaths;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    ({ Missions, CompletionPaths } = cds.entities(NS));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────────

  async function seedMissionWithPaths(titleSuffix, pathNames, pathOrders) {
    const missionId = cds.utils.uuid();
    await INSERT.into(Missions).entries({
      ID: missionId,
      title: `${TEST_PREFIX}${titleSuffix}`,
      status: 'ACTIVE',
    });
    for (let i = 0; i < pathNames.length; i++) {
      await INSERT.into(CompletionPaths).entries({
        ID: cds.utils.uuid(),
        mission_ID: missionId,
        name: pathNames[i],
        pathOrder: pathOrders ? pathOrders[i] : null,
      });
    }
    return missionId;
  }

  async function getPathOrders(missionId) {
    const rows = await SELECT.from(CompletionPaths)
      .columns('name', 'pathOrder')
      .where({ mission_ID: missionId })
      .orderBy('name');
    return Object.fromEntries(rows.map(r => [r.name, r.pathOrder]));
  }

  async function cleanup(missionId) {
    await DELETE.from(CompletionPaths).where({ mission_ID: missionId });
    await DELETE.from(Missions).where({ ID: missionId });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Core test: C/A/B all NULL → A=10, B=20, C=30 (alphabetical)
  // ───────────────────────────────────────────────────────────────────────────
  it('assigns pathOrder alphabetically: A=10, B=20, C=30 for names "C","A","B"', async () => {
    const missionId = await seedMissionWithPaths('core-alpha', ['C', 'A', 'B'], null);
    try {
      const result = await backfill({ cdsInstance: cds, commit: true });
      expect(result.updated).toBeGreaterThanOrEqual(3);

      const orders = await getPathOrders(missionId);
      expect(orders['A']).toBe(10);
      expect(orders['B']).toBe(20);
      expect(orders['C']).toBe(30);
    } finally {
      await cleanup(missionId);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Idempotency: second run finds no NULL rows, updates nothing
  // ───────────────────────────────────────────────────────────────────────────
  it('is idempotent — second run makes no changes', async () => {
    const missionId = await seedMissionWithPaths('idempotency', ['C', 'A', 'B'], null);
    try {
      // First run.
      await backfill({ cdsInstance: cds, commit: true });

      const ordersBefore = await getPathOrders(missionId);
      expect(ordersBefore['A']).toBe(10);

      // Second run in commit mode.
      const result2 = await backfill({ cdsInstance: cds, commit: true });
      // No new writes targeting our rows (there are 0 NULL pathOrder rows left for this mission).
      // The whole-DB updated count may include unrelated missions still NULL from prior tests
      // that haven't been cleaned up yet; what matters is our rows are unchanged.
      const ordersAfter = await getPathOrders(missionId);
      expect(ordersAfter['A']).toBe(10);
      expect(ordersAfter['B']).toBe(20);
      expect(ordersAfter['C']).toBe(30);

      // verify-only should report clean = true (no NULLs remain for our mission).
      const plan = await planBackfill(db, cds.entities(NS));
      const missionPlan = plan.find(m => m.missionId === missionId);
      expect(missionPlan).toBeUndefined(); // our mission has no NULL pathOrder rows
    } finally {
      await cleanup(missionId);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Partial-existing: base=25, new paths extend above it
  // ───────────────────────────────────────────────────────────────────────────
  it('extends past existing max(pathOrder): base=25 → new paths start at 30', async () => {
    const missionId = cds.utils.uuid();
    await INSERT.into(Missions).entries({
      ID: missionId,
      title: `${TEST_PREFIX}partial-existing`,
      status: 'ACTIVE',
    });
    // One path already has pathOrder=25.
    await INSERT.into(CompletionPaths).entries({
      ID: cds.utils.uuid(),
      mission_ID: missionId,
      name: 'AlreadyOrdered',
      pathOrder: 25,
    });
    // Two more with NULL.
    await INSERT.into(CompletionPaths).entries({
      ID: cds.utils.uuid(),
      mission_ID: missionId,
      name: 'Zebra',
      pathOrder: null,
    });
    await INSERT.into(CompletionPaths).entries({
      ID: cds.utils.uuid(),
      mission_ID: missionId,
      name: 'Apple',
      pathOrder: null,
    });

    try {
      await backfill({ cdsInstance: cds, commit: true });

      const orders = await getPathOrders(missionId);
      // Formula: floor(25/10)*10 = 20, so start = 30, 40
      expect(orders['Apple']).toBe(30);
      expect(orders['Zebra']).toBe(40);
      expect(orders['AlreadyOrdered']).toBe(25); // unchanged
    } finally {
      await DELETE.from(CompletionPaths).where({ mission_ID: missionId });
      await DELETE.from(Missions).where({ ID: missionId });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // dry-run: prints plan, makes no changes
  // ───────────────────────────────────────────────────────────────────────────
  it('dry-run mode makes no changes', async () => {
    const missionId = await seedMissionWithPaths('dry-run-test', ['B', 'A'], null);
    try {
      const result = await backfill({ cdsInstance: cds, dryRun: true });
      expect(result.updated).toBe(0);

      const orders = await getPathOrders(missionId);
      expect(orders['A']).toBeNull();
      expect(orders['B']).toBeNull();
    } finally {
      await cleanup(missionId);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // verify-only: returns clean=false when NULLs remain, clean=true when done
  // ───────────────────────────────────────────────────────────────────────────
  it('verify-only returns clean=false when NULLs exist, clean=true after commit', async () => {
    const missionId = await seedMissionWithPaths('verify-test', ['Z', 'A'], null);
    try {
      // Before backfill: work remains.
      const before = await backfill({ cdsInstance: cds, verifyOnly: true });
      expect(before.clean).toBe(false);
      expect(before.planRows).toBeGreaterThanOrEqual(2);

      // Commit.
      await backfill({ cdsInstance: cds, commit: true });

      // After backfill: clean (no NULLs for our mission specifically).
      const plan = await planBackfill(db, cds.entities(NS));
      const missionPlan = plan.find(m => m.missionId === missionId);
      expect(missionPlan).toBeUndefined();
    } finally {
      await cleanup(missionId);
    }
  });
});
