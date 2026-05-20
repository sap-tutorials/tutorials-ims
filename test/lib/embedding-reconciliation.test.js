import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../srv/lib/embedding-pipeline.js', () => ({
  embedSlugs: vi.fn().mockResolvedValue({ embedded: 2, skipped: 0, failed: 0, lockHeld: false })
}));

describe('embedding reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reconcileAll calls embedSlugs with the union of stale + missing slugs', async () => {
    const { embedSlugs } = await import('../../srv/lib/embedding-pipeline.js');
    const { reconcileAll } = await import('../../srv/jobs/embedding-reconciliation.js');
    const settings = { ragEnabled: true, embeddingModel: 'text-embedding-3-small', embeddingTopK: 4, embeddingMinScore: 0.7 };
    const result = await reconcileAll({
      activeSlugs: ['a', 'b', 'c'],
      slugsWithStaleHashes: ['a'],
      slugsWithoutEmbeddings: ['c'],
      settings
    });
    expect(embedSlugs).toHaveBeenCalledWith(expect.arrayContaining(['a', 'c']), settings);
    expect(result.candidates).toBe(2);
  });

  it('reconcileAll returns zero counts and does not call embedSlugs when candidate set is empty', async () => {
    const { embedSlugs } = await import('../../srv/lib/embedding-pipeline.js');
    const { reconcileAll } = await import('../../srv/jobs/embedding-reconciliation.js');
    const result = await reconcileAll({
      activeSlugs: ['a', 'b'],
      slugsWithStaleHashes: [],
      slugsWithoutEmbeddings: [],
      settings: { ragEnabled: true, embeddingModel: 'm' }
    });
    expect(embedSlugs).not.toHaveBeenCalled();
    expect(result).toEqual({ candidates: 0, embedded: 0, skipped: 0, failed: 0 });
  });

  it('reconcileAll filters out slugs that are not in activeSlugs', async () => {
    const { embedSlugs } = await import('../../srv/lib/embedding-pipeline.js');
    const { reconcileAll } = await import('../../srv/jobs/embedding-reconciliation.js');
    await reconcileAll({
      activeSlugs: ['a'],
      slugsWithStaleHashes: ['a', 'b'],   // 'b' is inactive
      slugsWithoutEmbeddings: ['c'],      // 'c' is inactive
      settings: { ragEnabled: true, embeddingModel: 'm' }
    });
    expect(embedSlugs).toHaveBeenCalledWith(['a'], expect.any(Object));
  });

  it('reconcileAll deduplicates slugs that appear in both stale and missing sets', async () => {
    const { embedSlugs } = await import('../../srv/lib/embedding-pipeline.js');
    const { reconcileAll } = await import('../../srv/jobs/embedding-reconciliation.js');
    const result = await reconcileAll({
      activeSlugs: ['a'],
      slugsWithStaleHashes: ['a'],
      slugsWithoutEmbeddings: ['a'],
      settings: { ragEnabled: true, embeddingModel: 'm' }
    });
    expect(embedSlugs).toHaveBeenCalledWith(['a'], expect.any(Object));
    expect(result.candidates).toBe(1);
  });
});
