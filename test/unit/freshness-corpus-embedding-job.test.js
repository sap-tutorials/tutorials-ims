// test/unit/freshness-corpus-embedding-job.test.js
// Task 3 (spec 2026-08-22): backfill job for ApiDocs/Samples embeddings.
// Mocks embed(); exercises the SQLite BLOB path (no TO_REAL_VECTOR on SQLite).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import cds from '@sap/cds';

vi.mock('../../srv/lib/embedding-client.js', () => ({
  embed: vi.fn(async (inputs) => inputs.map(() => new Float32Array(1536).fill(0.01))),
}));

// Bootstrap: same pattern as test/unit/freshness-model.test.js
cds.test('serve', '--project', '.', '--in-memory');

describe('runFreshnessCorpusEmbedding', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('embeds ApiDocs/Samples rows lacking an embedding and writes the BLOB', async () => {
    const { ApiDocs } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(ApiDocs).entries({ ID: cds.utils.uuid(), slug: 'x', title: 'X', description: 'desc' });
    const { runFreshnessCorpusEmbedding } = await import('../../srv/jobs/freshness-corpus-embedding-job.js');
    const res = await runFreshnessCorpusEmbedding('test-log');
    expect(res.apiDocs).toBeGreaterThanOrEqual(1);
    const row = await SELECT.one.from(ApiDocs).columns('ID', 'embedding').where({ slug: 'x' });
    expect(row.embedding).toBeTruthy();
  });
});
