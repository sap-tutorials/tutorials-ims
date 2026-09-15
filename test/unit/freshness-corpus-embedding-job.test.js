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

  it('embeds TechEdSessions rows via the `abstract` column and writes the BLOB (#2312)', async () => {
    const { TechEdSessions } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(TechEdSessions).entries({
      ID: cds.utils.uuid(), sourceId: 'te-1', slug: 'teched-1', title: 'TechEd 1',
      abstract: 'A TechEd session abstract',
    });
    const { runFreshnessCorpusEmbedding } = await import('../../srv/jobs/freshness-corpus-embedding-job.js');
    const res = await runFreshnessCorpusEmbedding('test-log');
    expect(res.techedSessions).toBeGreaterThanOrEqual(1);
    const row = await SELECT.one.from(TechEdSessions).columns('ID', 'embedding').where({ slug: 'teched-1' });
    expect(row.embedding).toBeTruthy();
  });

  it('fault-isolates a failing DevtoberfestSessions arm: job still resolves, apiDocs/samples survive, TechEd arm still runs (#2311/#2312)', async () => {
    const { ApiDocs, TechEdSessions } = cds.entities('com.sap.developers.ims.external');
    // Fresh rows so both surviving arms have work to do.
    await INSERT.into(ApiDocs).entries({ ID: cds.utils.uuid(), slug: 'iso-api', title: 'Iso API', description: 'desc' });
    await INSERT.into(TechEdSessions).entries({
      ID: cds.utils.uuid(), sourceId: 'te-iso', slug: 'teched-iso', title: 'TechEd Iso',
      abstract: 'A TechEd session abstract',
    });
    // Simulate the newer DevtoberfestSessions table being absent on an
    // un-migrated env: SELECT.from(DevtoberfestSessions) will now reject.
    // No other test reads this table, so dropping it here is safe.
    await db.run('DROP TABLE "COM_SAP_DEVELOPERS_IMS_EXTERNAL_DEVTOBERFESTSESSIONS"');

    const { runFreshnessCorpusEmbedding } = await import('../../srv/jobs/freshness-corpus-embedding-job.js');
    // Must resolve (not reject) despite the devtoberfest arm throwing.
    const res = await runFreshnessCorpusEmbedding('test-log');

    // Failing arm contributes 0 without aborting the job.
    expect(res.devtoberfestSessions).toBe(0);
    // Counts computed before the failing arm survive.
    expect(res.apiDocs).toBeGreaterThanOrEqual(1);
    expect(typeof res.samples).toBe('number');
    // The TechEd arm (below the devtoberfest arm) still ran — not aborted.
    expect(res.techedSessions).toBeGreaterThanOrEqual(1);
    const row = await SELECT.one.from(TechEdSessions).columns('ID', 'embedding').where({ slug: 'teched-iso' });
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
