import { describe, it, expect, vi } from 'vitest';

vi.mock('../../srv/lib/embedding-pipeline.js', () => ({
  embedSlugs: vi.fn().mockResolvedValue({ embedded: 2, skipped: 0, failed: 0, lockHeld: false })
}));

describe('embedding reconciliation', () => {
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
});
