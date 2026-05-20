import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../srv/lib/embedding-pipeline.js', () => ({
  embedSlugs: vi.fn().mockResolvedValue({ embedded: 1, skipped: 0, failed: 0, lockHeld: false })
}));

describe('content-store post-publish hook', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invokes embedSlugs with changed slugs when ragEnabled is true', async () => {
    const { embedSlugs } = await import('../../srv/lib/embedding-pipeline.js');
    const { triggerPostPublishEmbeddings } = await import('../../srv/lib/content-store.js');
    await triggerPostPublishEmbeddings({
      changedSlugs: ['cap-hello-world', 'btp-trial-setup'],
      settings: { ragEnabled: true, embeddingModel: 'text-embedding-3-small', embeddingTopK: 4, embeddingMinScore: 0.7 }
    });
    expect(embedSlugs).toHaveBeenCalledTimes(1);
    expect(embedSlugs.mock.calls[0][0]).toEqual(['cap-hello-world', 'btp-trial-setup']);
  });

  it('skips embedding when ragEnabled is false', async () => {
    const { embedSlugs } = await import('../../srv/lib/embedding-pipeline.js');
    const { triggerPostPublishEmbeddings } = await import('../../srv/lib/content-store.js');
    await triggerPostPublishEmbeddings({
      changedSlugs: ['cap-hello-world'],
      settings: { ragEnabled: false }
    });
    expect(embedSlugs).not.toHaveBeenCalled();
  });

  it('swallows embedding errors so publish stays successful', async () => {
    const { embedSlugs } = await import('../../srv/lib/embedding-pipeline.js');
    embedSlugs.mockRejectedValueOnce(new Error('AI Core down'));
    const { triggerPostPublishEmbeddings } = await import('../../srv/lib/content-store.js');
    await expect(triggerPostPublishEmbeddings({
      changedSlugs: ['x'],
      settings: { ragEnabled: true }
    })).resolves.toBeUndefined();
  });
});
