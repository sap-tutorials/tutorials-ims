// test/hybrid/kg-preview-merges.test.js
// Real-HANA proof that async previewMerges (#1531) no longer 504s: the action
// returns a runId in well under the 30s gateway budget, and the background scan
// finalizes the run to DONE over the real ACTIVE concept set.
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec --profile hybrid -- \
//     npx vitest run --project hybrid test/hybrid/kg-preview-merges.test.js
//
// SAFETY
//   - Triggers a read-only O(n^2) scan over ACTIVE concepts; no concept rows
//     are mutated (previewMerges is a dry-run — no merges occur).
//   - The only write is the ConceptMergePreviewRuns tracking row inserted by
//     the action. afterAll() deletes the specific row(s) by the runId(s)
//     collected during the test run, leaving no residue.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

// Belt-and-suspenders: ensure the KG feature gate passes even if the DEV
// KnowledgeGraphSettings row has enabled=false. resolveKnowledgeGraphSettings()
// falls back to this env var when no DB row overrides it.
process.env.KNOWLEDGE_GRAPH_ENABLED = 'true';

const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('previewMerges async end-to-end against real HANA (#1531)', () => {
  let db;
  const collectedRunIds = [];

  beforeAll(async () => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error(
        'ALLOW_HYBRID_WRITES not set; refusing to run because the action INSERTs ' +
        'ConceptMergePreviewRuns rows. Run with: ALLOW_HYBRID_WRITES=true npx cds bind ' +
        '--exec --profile hybrid -- npx vitest run --project hybrid ' +
        'test/hybrid/kg-preview-merges.test.js'
      );
    }
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'kg-preview-merges.test.js must run against HANA. ' +
        'Run via ALLOW_HYBRID_WRITES=true npx cds bind --exec --profile hybrid after cf login.'
      );
    }
  });

  afterAll(async () => {
    // Delete only the ConceptMergePreviewRuns rows this test created.
    // Using raw SQL to avoid LOB-locator issues with HANA BLOB columns.
    if (!db || collectedRunIds.length === 0) return;
    for (const runId of collectedRunIds) {
      try {
        await db.run(
          `DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTMERGEPREVIEWRUNS" WHERE "ID" = '${runId}'`
        );
      } catch (err) {
        // Best-effort: surface but don't fail teardown.
        // eslint-disable-next-line no-console
        console.warn(`[kg-preview-merges] cleanup failed for runId ${runId}:`, err?.message);
      }
    }
  });

  it(
    'returns a runId fast, background scan finalises to DONE, resultJson is valid',
    async () => {
      // ── (1) Kick off: must return well under the 30s gateway budget ──────
      const t0 = Date.now();
      const res = await project.post('/graph/previewMerges', {}, adminAuth);
      const kickMs = Date.now() - t0;

      expect(res.status).toBe(200);

      // runId is a non-empty UUID string
      expect(res.data.runId).toBeTruthy();
      expect(typeof res.data.runId).toBe('string');

      const runId = res.data.runId;
      collectedRunIds.push(runId);

      // (2) The whole point of #1531: kick-off must be a FRACTION of the 30s
      // gateway timeout, not the full O(n^2) scan duration.
      expect(kickMs).toBeLessThan(5000);

      // ── (3) Poll until the background scan finalises or deadline passes ──
      const { ConceptMergePreviewRuns } = cds.entities('com.sap.developers.ims');
      const deadline = Date.now() + 120_000;
      let row;

      for (;;) {
        // Using CQL-global SELECT (available via CAP test harness) with the db
        // connection from beforeAll. Matches the polling pattern in the brief
        // and is consistent with how kg-merge-action.test.js reads rows.
        [row] = await db.run(
          SELECT.from(ConceptMergePreviewRuns).where({ ID: runId })
        );
        if (row && row.status !== 'RUNNING') break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 1000));
      }

      // ── (4) Final state assertions ────────────────────────────────────────
      expect(row).toBeTruthy();
      expect(row.status).toBe('DONE');

      // (5) The scan must have visited at least one concept
      expect(typeof row.conceptsScanned).toBe('number');
      expect(row.conceptsScanned).toBeGreaterThan(0);

      // candidatePairs is a number (may be 0 if no near-duplicates exist)
      expect(typeof row.candidatePairs).toBe('number');

      // (6) resultJson is valid JSON and respects the 500-entry server cap
      expect(typeof row.resultJson).toBe('string');
      const pairs = JSON.parse(row.resultJson || '[]');
      expect(Array.isArray(pairs)).toBe(true);
      expect(pairs.length).toBeLessThanOrEqual(500);

      // durationMs is a positive number (the scan did run)
      expect(typeof row.durationMs).toBe('number');
      expect(row.durationMs).toBeGreaterThan(0);
    },
    130_000
  );
});
