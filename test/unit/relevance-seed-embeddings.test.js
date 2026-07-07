import { describe, it, expect, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';

// Bootstrap: full project serve with in-memory SQLite + seed CSVs.
// Matches the pattern used by admin-homepage-crud.test.js and others.
// homepageBooted is project-specific glue absent here — await is handled
// by vitest's beforeEach waiting on getSeedEmbeddings() instead.
cds.test('serve', '--project', '.', '--in-memory');

let embedMock;
vi.mock('../../srv/lib/embedding-client.js', () => ({
  embed: (...args) => embedMock(...args),
}));

const {
  getSeedEmbeddings,
  invalidateSeed,
  _resetCacheForTests,
} = await import('../../srv/lib/relevance-seed-embeddings.js');

describe('relevance-seed-embeddings', () => {
  beforeEach(async () => {
    _resetCacheForTests();
    embedMock = vi.fn(async inputs => inputs.map((_, i) => new Float32Array([i, 0, 0])));
  });

  it('lazily loads active seeds grouped by label', async () => {
    // Depends on the seeded rows from the CSV seed (Task 6):
    //   6 × relevant, 6 × not-relevant → both arrays ≥ 3
    const { relevant, notRelevant } = await getSeedEmbeddings();
    expect(relevant.length).toBeGreaterThanOrEqual(3);
    expect(notRelevant.length).toBeGreaterThanOrEqual(3);
    expect(embedMock).toHaveBeenCalledTimes(1); // one batched embed call
  });

  it('races share the in-flight promise (single embed call)', async () => {
    // Step 4 relaxation: check embed-call count, not object identity.
    // groupByLabel() rebuilds a fresh {relevant, notRelevant} each call so
    // the two resolved values are structurally equal but not reference-equal.
    await Promise.all([getSeedEmbeddings(), getSeedEmbeddings()]);
    expect(embedMock).toHaveBeenCalledTimes(1);
  });

  it('invalidateSeed marks one entry stale; next call recomputes only it', async () => {
    await getSeedEmbeddings();
    expect(embedMock).toHaveBeenCalledTimes(1);
    invalidateSeed('10340001-0000-0000-0000-000000000001');
    await getSeedEmbeddings();
    expect(embedMock).toHaveBeenCalledTimes(2);
    // Second call embeds only the stale entry.
    expect(embedMock.mock.calls[1][0]).toHaveLength(1);
  });

  it('empty result set → both label arrays empty; no throw', async () => {
    const db = await cds.connect.to('db');
    await db.run(DELETE.from('com.sap.developers.ims.external.RelevanceSeedExemplars'));
    _resetCacheForTests();
    const { relevant, notRelevant } = await getSeedEmbeddings();
    expect(relevant).toEqual([]);
    expect(notRelevant).toEqual([]);
  });
});
