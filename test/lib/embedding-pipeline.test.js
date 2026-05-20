import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

vi.mock('../../srv/lib/embedding-client.js', () => ({
  embed: vi.fn(async (inputs) => inputs.map(() => new Float32Array(1536).fill(0.1)))
}));
vi.mock('../../srv/lib/step-text-extractor.js', () => ({
  extractStepText: vi.fn()
}));
vi.mock('../../srv/jobs/job-lock.js', () => ({
  acquireLock: vi.fn(async () => true),
  releaseLock: vi.fn(async () => undefined)
}));

const cds = (await import('@sap/cds')).default;

describe('embedding-pipeline', () => {
  let pipeline, extractor, jobLock, embeddingClient;

  beforeEach(async () => {
    await cds.deploy(schemaPath).to('sqlite::memory:');
    extractor = await import('../../srv/lib/step-text-extractor.js');
    jobLock = await import('../../srv/jobs/job-lock.js');
    embeddingClient = await import('../../srv/lib/embedding-client.js');
    pipeline = await import('../../srv/lib/embedding-pipeline.js');
    vi.clearAllMocks();
    jobLock.acquireLock.mockResolvedValue(true);
  });

  it('skips entirely when ragEnabled is false', async () => {
    const result = await pipeline.embedSlugs(['slug-a'], { ragEnabled: false });
    expect(result).toEqual({ embedded: 0, skipped: 0, failed: 0, lockHeld: false });
    expect(embeddingClient.embed).not.toHaveBeenCalled();
  });

  it('exits early when distributed lock is held', async () => {
    jobLock.acquireLock.mockResolvedValueOnce(false);
    const result = await pipeline.embedSlugs(['slug-a'], { ragEnabled: true, embeddingModel: 'm' });
    expect(result.lockHeld).toBe(true);
    expect(embeddingClient.embed).not.toHaveBeenCalled();
  });

  it('embeds and upserts new chunks for a fresh slug', async () => {
    const { Tutorials, Steps, ContentFiles, ContentManifest } = cds.entities('com.sap.developers.ims');
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'slug-a', title: 'A', status: 'ACTIVE' });
    await INSERT.into(Steps).entries({ ID: cds.utils.uuid(), tutorial_ID: tid, stepOrder: 1, title: 's1', status: 'ACTIVE' });
    const { gzipSync } = await import('node:zlib');
    await INSERT.into(ContentManifest).entries({ version: 1, status: 'ACTIVE' });
    await INSERT.into(ContentFiles).entries({
      slug: 'slug-a', version: 1,
      content: gzipSync(Buffer.from('<section data-step="1">hello world</section>')),
      contentHash: 'x', sizeBytes: 1, compressedBytes: 1, mimeType: 'text/html'
    });
    extractor.extractStepText.mockReturnValue([{ stepNumber: 1, text: 'hello world', charCount: 11 }]);

    const result = await pipeline.embedSlugs(['slug-a'], { ragEnabled: true, embeddingModel: 'text-embedding-3-small' });

    expect(result.embedded).toBe(1);
    expect(result.failed).toBe(0);
    const { TutorialEmbedding } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(TutorialEmbedding);
    expect(rows).toHaveLength(1);
    expect(rows[0].stepNumber).toBe(1);
    expect(rows[0].embeddingModel).toBe('text-embedding-3-small');
  });

  it('skips chunks whose hash + model already match', async () => {
    const { createHash } = await import('node:crypto');
    const { Tutorials, Steps, ContentFiles, ContentManifest, TutorialEmbedding } = cds.entities('com.sap.developers.ims');
    const tid = cds.utils.uuid();
    const chunkText = 'hello world';
    const expectedHash = createHash('sha256').update(chunkText).digest('hex');
    const model = 'text-embedding-3-small';

    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'slug-a', title: 'A', status: 'ACTIVE' });
    await INSERT.into(Steps).entries({ ID: cds.utils.uuid(), tutorial_ID: tid, stepOrder: 1, title: 's1', status: 'ACTIVE' });
    const { gzipSync } = await import('node:zlib');
    await INSERT.into(ContentManifest).entries({ version: 1, status: 'ACTIVE' });
    await INSERT.into(ContentFiles).entries({
      slug: 'slug-a', version: 1,
      content: gzipSync(Buffer.from('<section data-step="1">hello world</section>')),
      contentHash: 'x', sizeBytes: 1, compressedBytes: 1, mimeType: 'text/html'
    });
    await INSERT.into(TutorialEmbedding).entries({
      tutorial_ID: tid, stepNumber: 1,
      contentHash: expectedHash, embeddingModel: model,
      embedding: Buffer.alloc(1536 * 4),
      stepText: chunkText, charCount: chunkText.length
    });
    extractor.extractStepText.mockReturnValue([{ stepNumber: 1, text: chunkText, charCount: chunkText.length }]);

    const result = await pipeline.embedSlugs(['slug-a'], { ragEnabled: true, embeddingModel: model });

    expect(embeddingClient.embed).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.embedded).toBe(0);
  });

  it('records failed slugs without throwing', async () => {
    const { Tutorials, ContentFiles, ContentManifest } = cds.entities('com.sap.developers.ims');
    const tid = cds.utils.uuid();
    const { gzipSync } = await import('node:zlib');
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'bad', title: 'B', status: 'ACTIVE' });
    await INSERT.into(ContentManifest).entries({ version: 1, status: 'ACTIVE' });
    await INSERT.into(ContentFiles).entries({
      slug: 'bad', version: 1,
      content: gzipSync(Buffer.from('<section data-step="1">x</section>')),
      contentHash: 'x', sizeBytes: 1, compressedBytes: 1, mimeType: 'text/html'
    });
    extractor.extractStepText.mockImplementationOnce(() => { throw new Error('boom'); });
    const result = await pipeline.embedSlugs(['bad'], { ragEnabled: true, embeddingModel: 'm' });
    expect(result.failed).toBe(1);
  });
});
