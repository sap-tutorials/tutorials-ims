// test/unit/freshness-corpus-embedding-job.test.js
// Task 3 (spec 2026-08-22): backfill job for ApiDocs/Samples embeddings.
// Mocks embed(); exercises the SQLite BLOB path (no TO_REAL_VECTOR on SQLite).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import cds from '@sap/cds';
import { embed } from '../../srv/lib/embedding-client.js';

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

  it('passes a resolved embedding model to embed() (regression: undefined model crashed the job)', async () => {
    const { ApiDocs } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(ApiDocs).entries({ ID: cds.utils.uuid(), slug: 'y', title: 'Y', description: 'desc' });
    embed.mockClear();
    const { runFreshnessCorpusEmbedding } = await import('../../srv/jobs/freshness-corpus-embedding-job.js');
    await runFreshnessCorpusEmbedding('test-log');
    expect(embed).toHaveBeenCalled();
    // Every embed() call must supply a non-empty model string as the 2nd arg —
    // omitting it constructs AzureOpenAiEmbeddingClient(undefined) → reads
    // .modelName off undefined → ScheduledJobFailed at 03:17 UTC (2026-08-24).
    for (const call of embed.mock.calls) {
      expect(typeof call[1]).toBe('string');
      expect(call[1].length).toBeGreaterThan(0);
    }
  });
});
