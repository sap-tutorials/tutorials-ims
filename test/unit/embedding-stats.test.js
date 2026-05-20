import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { computeEmbeddingStats } from '../../srv/lib/embedding-stats.js';

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

// ---- helpers ----------------------------------------------------------------

async function insertManifest(version, status = 'ACTIVE') {
  const { ContentManifest } = cds.entities('com.sap.developers.ims');
  await INSERT.into(ContentManifest).entries({
    version,
    status,
    trigger: 'test',
    fileCount: 0,
    totalSizeBytes: 0
  });
}

async function insertContentFile(slug, version) {
  const { ContentFiles } = cds.entities('com.sap.developers.ims');
  await INSERT.into(ContentFiles).entries({
    slug,
    version,
    contentHash: 'file-hash',
    sizeBytes: 100,
    compressedBytes: 50
  });
}

async function insertTutorial(id, slug) {
  const { Tutorials } = cds.entities('com.sap.developers.ims');
  await INSERT.into(Tutorials).entries({
    ID: id,
    title: `Tutorial ${slug}`,
    slug,
    status: 'ACTIVE'
  });
}

async function insertStep(id, tutorialId, stepOrder, contentHash = 'hash-a') {
  const { Steps } = cds.entities('com.sap.developers.ims');
  await INSERT.into(Steps).entries({
    ID: id,
    tutorial_ID: tutorialId,
    title: `Step ${stepOrder}`,
    stepOrder,
    contentHash,
    status: 'ACTIVE'
  });
}

async function insertEmbedding(tutorialId, stepNumber, contentHash = 'hash-a') {
  const { TutorialEmbedding } = cds.entities('com.sap.developers.ims');
  await INSERT.into(TutorialEmbedding).entries({
    tutorial_ID: tutorialId,
    stepNumber,
    contentHash,
    embeddingModel: 'text-embedding-3-small',
    // embedding column omitted — not required for stats
    charCount: 100
  });
}

async function insertPipelineLog(overrides = {}) {
  const { PipelineLog } = cds.entities('com.sap.developers.ims');
  const base = {
    ID: overrides.ID ?? cds.utils.uuid(),
    pipelineType: 'SCHEDULED_JOB',
    status: 'SUCCESS',
    startedAt: new Date().toISOString(),
    initiator: 'reconciliation-cron',
    metadata: JSON.stringify({ job: 'embedding-reconciliation' })
  };
  await INSERT.into(PipelineLog).entries({ ...base, ...overrides });
}

// ---- tests ------------------------------------------------------------------

describe('computeEmbeddingStats', () => {
  beforeEach(async () => {
    await cds.deploy(schemaPath).to('sqlite::memory:');
  });

  it('(a) no active manifest → returns nulls/zeros', async () => {
    const result = await computeEmbeddingStats();
    expect(result).toEqual({
      activeManifest: null,
      slugs: 0,
      slugsWithEmbeddings: 0,
      totalSteps: 0,
      embeddedSteps: 0,
      missing: 0,
      stale: 0,
      lastRun: null
    });
  });

  it('(a2) non-ACTIVE manifest is ignored', async () => {
    await insertManifest(1, 'SUPERSEDED');
    const result = await computeEmbeddingStats();
    expect(result.activeManifest).toBeNull();
  });

  it('(b) manifest with all steps embedded → missing=0, stale=0', async () => {
    await insertManifest(1);
    await insertContentFile('tutorial-alpha', 1);
    await insertTutorial('tid-001', 'tutorial-alpha');
    await insertStep('step-001', 'tid-001', 1, 'hash-x');
    await insertStep('step-002', 'tid-001', 2, 'hash-y');
    await insertEmbedding('tid-001', 1, 'hash-x');
    await insertEmbedding('tid-001', 2, 'hash-y');

    const result = await computeEmbeddingStats();
    expect(result.activeManifest).toBe(1);
    expect(result.slugs).toBe(1);
    expect(result.totalSteps).toBe(2);
    expect(result.embeddedSteps).toBe(2);
    expect(result.missing).toBe(0);
    expect(result.stale).toBe(0);
    expect(result.slugsWithEmbeddings).toBe(1);
  });

  it('(c) manifest with mix of missing + stale → correct counts', async () => {
    await insertManifest(1);
    // Two tutorials in the manifest
    await insertContentFile('tut-a', 1);
    await insertContentFile('tut-b', 1);
    await insertTutorial('tid-a', 'tut-a');
    await insertTutorial('tid-b', 'tut-b');

    // tut-a: 2 steps — one embedded (fresh), one missing
    await insertStep('s-a1', 'tid-a', 1, 'hash-a1');
    await insertStep('s-a2', 'tid-a', 2, 'hash-a2');
    await insertEmbedding('tid-a', 1, 'hash-a1'); // fresh

    // tut-b: 2 steps — one stale, one embedded (fresh)
    await insertStep('s-b1', 'tid-b', 1, 'hash-b1');
    await insertStep('s-b2', 'tid-b', 2, 'hash-b2');
    await insertEmbedding('tid-b', 1, 'hash-OLD');  // stale (hash mismatch)
    await insertEmbedding('tid-b', 2, 'hash-b2');   // fresh

    const result = await computeEmbeddingStats();
    expect(result.slugs).toBe(2);
    expect(result.totalSteps).toBe(4);
    expect(result.missing).toBe(1);   // s-a2 has no embedding
    expect(result.stale).toBe(1);     // s-b1 hash mismatch
    // slugsWithEmbeddings: both tut-a (step 1 matched) and tut-b (steps 1+2 matched)
    expect(result.slugsWithEmbeddings).toBe(2);
  });

  it('(d) lastRun picks the most recent SCHEDULED_JOB with embedding-reconciliation metadata', async () => {
    await insertManifest(1);

    const older = new Date('2026-01-01T10:00:00Z').toISOString();
    const newer = new Date('2026-06-01T10:00:00Z').toISOString();

    await insertPipelineLog({
      ID: 'pid-old',
      startedAt: older,
      status: 'FAILED',
      initiator: 'reconciliation-cron',
      metadata: JSON.stringify({ job: 'embedding-reconciliation' })
    });
    await insertPipelineLog({
      ID: 'pid-new',
      startedAt: newer,
      status: 'SUCCESS',
      initiator: 'reconciliation-cron',
      metadata: JSON.stringify({ job: 'embedding-reconciliation' })
    });
    // A different SCHEDULED_JOB that should NOT be returned
    await insertPipelineLog({
      ID: 'pid-other',
      startedAt: newer,
      status: 'SUCCESS',
      initiator: 'some-other-cron',
      metadata: JSON.stringify({ job: 'cleanup' })
    });

    const result = await computeEmbeddingStats();
    expect(result.lastRun).not.toBeNull();
    expect(result.lastRun.status).toBe('SUCCESS');
    expect(result.lastRun.initiator).toBe('reconciliation-cron');
    // Must be the newer row
    expect(new Date(result.lastRun.startedAt).getFullYear()).toBe(2026);
    expect(new Date(result.lastRun.startedAt).getMonth()).toBe(5); // June = 5 (0-indexed)
  });

  it('(d2) no matching PipelineLog → lastRun is null', async () => {
    await insertManifest(1);
    // Insert a log with a different job type
    await insertPipelineLog({
      ID: 'pid-other',
      pipelineType: 'CONTENT_PUBLISH',
      metadata: JSON.stringify({ trigger: 'deploy' })
    });

    const result = await computeEmbeddingStats();
    expect(result.lastRun).toBeNull();
  });

  it('(e) activeManifest returns version number, not ID', async () => {
    await insertManifest(42);
    const result = await computeEmbeddingStats();
    expect(result.activeManifest).toBe(42);
  });

  it('(g) embeddedSteps does not count orphan embeddings whose step was deleted', async () => {
    await insertManifest(1);
    await insertContentFile('tut-orphan', 1);
    await insertTutorial('tid-orphan', 'tut-orphan');

    // 2 current steps
    await insertStep('so-1', 'tid-orphan', 1, 'hash-1');
    await insertStep('so-2', 'tid-orphan', 2, 'hash-2');
    // 3 embedding rows: 2 matching current steps + 1 orphan (step 3 no longer exists)
    await insertEmbedding('tid-orphan', 1, 'hash-1');
    await insertEmbedding('tid-orphan', 2, 'hash-2');
    await insertEmbedding('tid-orphan', 3, 'hash-3'); // orphan

    const result = await computeEmbeddingStats();
    expect(result.totalSteps).toBe(2);
    expect(result.embeddedSteps).toBe(2); // NOT 3
    expect(result.missing).toBe(0);
    expect(result.stale).toBe(0);
  });

  it('(f) tutorials not in manifest slugs are excluded from step counts', async () => {
    await insertManifest(1);
    await insertContentFile('in-manifest', 1);
    await insertTutorial('tid-in', 'in-manifest');
    await insertTutorial('tid-out', 'not-in-manifest');

    await insertStep('s-in', 'tid-in', 1, 'hash-in');
    await insertStep('s-out', 'tid-out', 1, 'hash-out');
    // Only embed the out-of-manifest tutorial
    await insertEmbedding('tid-out', 1, 'hash-out');

    const result = await computeEmbeddingStats();
    expect(result.totalSteps).toBe(1);   // only the in-manifest step
    expect(result.missing).toBe(1);      // the in-manifest step has no embedding
    expect(result.slugsWithEmbeddings).toBe(0);
  });
});
