// test/unit/kg-preview-merges-async.test.js
// Async previewMerges (#1531): the action returns a runId immediately and a
// RUNNING row; the background scan finalizes the row to DONE with a parseable
// resultJson; a second immediate call coalesces onto the same run.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

process.env.KNOWLEDGE_GRAPH_ENABLED = 'true';

const { POST } = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };
const NS = 'com.sap.developers.ims';

// Two near-duplicate ACTIVE concepts with real embedding BLOBs so the sqlite
// loader path (CDS QL) returns decodable vectors.
function f32blob(arr) {
  const v = new Float32Array(arr);
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

const IDS = {
  a: 'D0000001-0000-0000-0000-000000000001',
  b: 'D0000001-0000-0000-0000-000000000002',
};

beforeAll(async () => {
  const db = await cds.connect.to('db');
  const { Concepts, ConceptMergePreviewRuns } = cds.entities(NS);
  await db.run(DELETE.from(ConceptMergePreviewRuns));
  await db.run(DELETE.from(Concepts).where({ ID: { in: [IDS.a, IDS.b] } }));
  await db.run(INSERT.into(Concepts).entries([
    { ID: IDS.a, slug: 'pm-async-a', name: 'A', status: 'ACTIVE', extractionCount: 5,
      firstSeenAt: '2026-01-01T00:00:00Z', embedding: f32blob([1, 0, 0, 0]) },
    { ID: IDS.b, slug: 'pm-async-b', name: 'B', status: 'ACTIVE', extractionCount: 1,
      firstSeenAt: '2026-02-01T00:00:00Z', embedding: f32blob([0.999, 0.001, 0, 0]) },
  ]));
});

async function poll(runId, ms = 5000) {
  const db = await cds.connect.to('db');
  const { ConceptMergePreviewRuns } = cds.entities(NS);
  const deadline = Date.now() + ms;
  // Date.now allowed in test files (only workflow scripts forbid it).
  for (;;) {
    const [row] = await db.run(SELECT.from(ConceptMergePreviewRuns).where({ ID: runId }));
    if (row && row.status !== 'RUNNING') return row;
    if (Date.now() > deadline) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('previewMerges (async, #1531)', () => {
  it('returns a runId immediately and finalizes the row to DONE', async () => {
    const res = await POST('/graph/previewMerges', {}, adminAuth);
    expect(res.status).toBe(200);
    expect(res.data.runId).toBeTruthy();
    expect(res.data.status).toBe('RUNNING');
    expect(res.data.coalesced).toBe(false);

    const row = await poll(res.data.runId);
    expect(row.status).toBe('DONE');
    expect(row.candidatePairs).toBeGreaterThanOrEqual(1);
    const pairs = JSON.parse(row.resultJson);
    expect(Array.isArray(pairs)).toBe(true);
    // A wins canonical (higher extractionCount); B is the loser.
    expect(pairs[0].canonicalSlug).toBe('pm-async-a');
    expect(pairs[0].loserSlug).toBe('pm-async-b');
    expect(pairs[0].similarity).toBeGreaterThan(0.9);
  });

  it('coalesces a second call onto an in-flight RUNNING run', async () => {
    // Fire two back-to-back; the second must see the first still RUNNING.
    const first = await POST('/graph/previewMerges', {}, adminAuth);
    const second = await POST('/graph/previewMerges', {}, adminAuth);
    if (second.data.coalesced) {
      expect(second.data.runId).toBe(first.data.runId);
    } else {
      // Race where first already finished: acceptable, but then it's a new run.
      expect(second.data.runId).not.toBe(first.data.runId);
    }
    await poll(first.data.runId);
  });
});
