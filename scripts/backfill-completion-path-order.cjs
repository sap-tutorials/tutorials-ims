/* eslint-disable no-console */
/**
 * One-shot backfill: assign CompletionPaths.pathOrder for rows where it is NULL,
 * ordering paths alphabetically by name within each mission (issue #2990).
 *
 * For each mission that has CompletionPaths with NULL pathOrder:
 *   1. Find the current max(pathOrder) among non-null paths in that mission (base).
 *   2. Sort the NULL-order paths by name ascending (localeCompare, deterministic).
 *   3. Assign gap-numbered pathOrder values starting above base:
 *        first = floor(base/10)*10 + 10
 *        i-th  = floor(base/10)*10 + 10*(i+1)
 *      Examples:
 *        base=0  → 10, 20, 30, …
 *        base=25 → 30, 40, 50, …  (floor(25/10)*10 = 20, then 20+10=30)
 *      This ensures a clean multiple-of-10 start above any existing max.
 *
 * Modes:
 *   --dry-run     (default) — print plan, no writes
 *   --commit               — snapshot JSONL first, then write
 *   --verify-only          — exit 0 if no NULL pathOrder rows remain, exit 2 if work remains
 *
 * Run via:
 *   npx cds bind --exec -- node scripts/backfill-completion-path-order.cjs [--commit]
 *
 * npm script: npm run backfill-completion-path-order
 */

'use strict';

const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_DIR = path.resolve(__dirname, '..', '.migration-data');
const SNAPSHOT_PATH = path.join(
  SNAPSHOT_DIR,
  `completion-path-order-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
);
let snapshotInited = false;
function appendSnapshot(record) {
  if (!snapshotInited) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    snapshotInited = true;
  }
  fs.appendFileSync(SNAPSHOT_PATH, JSON.stringify(record) + '\n');
}

/**
 * Resolve namespaced CDS entities robustly in both cds bind --exec and
 * unit-test (in-memory SQLite) contexts. Passing a bare string to SELECT.from
 * fails against HANA because it resolves to the unqualified table name.
 *
 * @param {typeof import('@sap/cds')} cdsInstance
 * @returns {Promise<Record<string, any>>}
 */
async function resolveImsEntities(cdsInstance) {
  if (typeof cdsInstance.entities === 'function' && cdsInstance.model) {
    return cdsInstance.entities('com.sap.developers.ims');
  }
  const linked = cdsInstance.linked(await cdsInstance.load('*'));
  return linked.entities('com.sap.developers.ims');
}

/**
 * Compute the set of per-mission pathOrder backfill assignments without writing.
 *
 * Returns an array of { missionId, paths: [{ id, name, newPathOrder }] }
 * for every mission that has at least one CompletionPath with NULL pathOrder.
 *
 * @param {object} db - CDS database service
 * @param {object} ims - resolved IMS entities
 * @returns {Promise<Array<{ missionId: string, paths: Array<{ id: string, name: string, newPathOrder: number }> }>>}
 */
async function planBackfill(db, ims) {
  const { CompletionPaths } = ims;

  // Find all missions that have at least one NULL pathOrder path.
  const nullPaths = await db.run(
    SELECT.from(CompletionPaths)
      .columns('ID', 'mission_ID', 'name', 'pathOrder')
      .where({ pathOrder: null })
      .orderBy('mission_ID', 'name')
  );

  if (nullPaths.length === 0) return [];

  // Group by mission.
  const byMission = new Map();
  for (const p of nullPaths) {
    const mid = p.mission_ID;
    if (!byMission.has(mid)) byMission.set(mid, []);
    byMission.get(mid).push(p);
  }

  const plan = [];

  for (const [missionId, paths] of byMission) {
    // Find max existing pathOrder for this mission (among non-null rows).
    const existingRows = await db.run(
      SELECT.from(CompletionPaths)
        .columns('pathOrder')
        .where({ mission_ID: missionId })
        .where('pathOrder IS NOT NULL')
    );
    const base = existingRows.length > 0
      ? Math.max(...existingRows.map(r => r.pathOrder))
      : 0;

    // Sort NULL-order paths alphabetically by name (localeCompare, deterministic).
    const sorted = [...paths].sort((a, b) =>
      (a.name || '').localeCompare(b.name || '')
    );

    // Assign gap-numbered pathOrder values starting above base.
    // Formula: floor(base/10)*10 + 10*(i+1)
    //   base=0  → 10, 20, 30
    //   base=25 → 30, 40, 50  (floor(25/10)*10 = 20, so start = 30)
    const startBase = Math.floor(base / 10) * 10;
    const assignments = sorted.map((p, i) => ({
      id: p.ID,
      name: p.name,
      newPathOrder: startBase + 10 * (i + 1),
    }));

    plan.push({ missionId, paths: assignments });
  }

  return plan;
}

/**
 * Execute the backfill: snapshot, then UPDATE each CompletionPath individually.
 *
 * @param {object} db - CDS database service
 * @param {object} ims - resolved IMS entities
 * @param {Array} plan - output of planBackfill()
 * @param {boolean} doSnapshot - whether to write snapshot JSONL
 * @returns {Promise<{ updated: number, failed: number }>}
 */
async function applyBackfill(db, ims, plan, doSnapshot) {
  const { CompletionPaths } = ims;
  let updated = 0;
  let failed = 0;

  for (const { missionId, paths } of plan) {
    for (const { id, name, newPathOrder } of paths) {
      try {
        if (doSnapshot) {
          appendSnapshot({
            kind: 'completion-path-order-before',
            table: 'CompletionPaths',
            id,
            mission_ID: missionId,
            name,
            newPathOrder,
          });
        }

        await db.run(
          UPDATE(CompletionPaths)
            .set({ pathOrder: newPathOrder })
            .where({ ID: id })
            .where({ pathOrder: null })
        );

        updated++;
        console.log(`  ✓ Path ${id.slice(0, 8)} "${name ?? '<no-name>'}"`
          + `  mission=${missionId.slice(0, 8)}  pathOrder → ${newPathOrder}`);
      } catch (err) {
        failed++;
        console.error(`  ✗ Path ${id.slice(0, 8)} failed: ${err.message}`);
      }
    }
  }

  return { updated, failed };
}

/**
 * Core backfill logic — callable from tests as well as from main().
 *
 * @param {object} options
 * @param {typeof import('@sap/cds')} options.cdsInstance - cds module to use
 * @param {boolean} [options.commit=false]      - actually write; snapshot first
 * @param {boolean} [options.verifyOnly=false]  - report + exit 0/2, no writes
 * @param {boolean} [options.dryRun=false]      - print plan, no writes (default when all false)
 * @param {boolean} [options.hanaOnly=false]    - if true, abort when db is not HANA
 * @returns {Promise<{ planRows: number, updated: number, failed: number, clean: boolean }>}
 */
async function backfill({ cdsInstance = cds, commit = false, verifyOnly = false, dryRun = false, hanaOnly = false } = {}) {
  const db = await cdsInstance.connect.to('db');

  if (hanaOnly) {
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error('FATAL: --hana-only flag set but DB is not HANA. Use `cds bind --exec`.');
    }
  }

  const ims = await resolveImsEntities(cdsInstance);
  const plan = await planBackfill(db, ims);

  const totalPlanRows = plan.reduce((s, m) => s + m.paths.length, 0);

  if (verifyOnly) {
    console.log(`CompletionPaths with NULL pathOrder: ${totalPlanRows}`);
    const clean = totalPlanRows === 0;
    console.log(clean ? 'CLEAN — no backfill needed.' : 'WORK REMAINS — re-run with --commit.');
    return { planRows: totalPlanRows, updated: 0, failed: 0, clean };
  }

  // Print plan regardless of mode.
  console.log(`\n--- CompletionPaths with NULL pathOrder: ${totalPlanRows} (across ${plan.length} missions) ---`);
  for (const { missionId, paths } of plan) {
    console.log(`\n  Mission ${missionId.slice(0, 8)} (${paths.length} paths to assign):`);
    for (const { id, name, newPathOrder } of paths) {
      console.log(`    ${id.slice(0, 8)}  "${name ?? '<no-name>'}"`
        + `  → pathOrder = ${newPathOrder}`);
    }
  }

  if (!commit) {
    console.log('\nDry-run complete. Re-run with --commit to apply.');
    return { planRows: totalPlanRows, updated: 0, failed: 0, clean: totalPlanRows === 0 };
  }

  console.log(`\nSnapshot will be written to: ${SNAPSHOT_PATH}\n`);

  const { updated, failed } = await applyBackfill(db, ims, plan, true);

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({ planRows: totalPlanRows, updated, failed }, null, 2));

  if (failed > 0) {
    throw new Error(`Backfill completed with ${failed} failures — check output above.`);
  }

  return { planRows: totalPlanRows, updated, failed, clean: totalPlanRows === 0 };
}

// ── CLI entry point ──────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const VERIFY_ONLY = argv.includes('--verify-only');
const DRY_RUN = argv.includes('--dry-run');

if (COMMIT && VERIFY_ONLY) {
  console.error('--commit and --verify-only are mutually exclusive');
  process.exit(1);
}
if (COMMIT && DRY_RUN) {
  console.error('--commit and --dry-run are mutually exclusive');
  process.exit(1);
}

if (require.main === module) {
  backfill({ commit: COMMIT, verifyOnly: VERIFY_ONLY, dryRun: DRY_RUN, hanaOnly: false })
    .then(({ clean }) => {
      if (VERIFY_ONLY) process.exit(clean ? 0 : 2);
      // dry-run and commit both exit 0 on success
    })
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { backfill, planBackfill, resolveImsEntities };
