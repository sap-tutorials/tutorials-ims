import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { pruneOrphanEmbeddings } from '../../srv/jobs/cleanup.js';

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

async function insertEmbedding(tutorialId, stepNumber, contentHash = 'hash-a') {
  const { TutorialEmbedding } = cds.entities('com.sap.developers.ims');
  await INSERT.into(TutorialEmbedding).entries({
    tutorial_ID: tutorialId,
    stepNumber,
    contentHash,
    embeddingModel: 'text-embedding-3-small',
    charCount: 100
  });
}

async function countEmbeddings(tutorialId) {
  const { TutorialEmbedding } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(TutorialEmbedding).where({ tutorial_ID: tutorialId });
  return rows.length;
}

// ---- tests ------------------------------------------------------------------

describe('pruneOrphanEmbeddings', () => {
  beforeEach(async () => {
    await cds.deploy(schemaPath).to('sqlite::memory:');
  });

  it('(1) active orphan: removes embeddings for tutorials not in active manifest', async () => {
    // Active manifest contains only tutorial A's slug
    await insertManifest(1);
    await insertContentFile('tutorial-alpha', 1);

    await insertTutorial('tid-a', 'tutorial-alpha');
    await insertTutorial('tid-b', 'tutorial-beta'); // not in manifest

    // Tutorial A: 1 embedding
    await insertEmbedding('tid-a', 1, 'hash-a1');
    // Tutorial B: 2 embeddings (orphans)
    await insertEmbedding('tid-b', 1, 'hash-b1');
    await insertEmbedding('tid-b', 2, 'hash-b2');

    const deleted = await pruneOrphanEmbeddings();

    expect(deleted).toBe(2);
    expect(await countEmbeddings('tid-b')).toBe(0);
    expect(await countEmbeddings('tid-a')).toBe(1); // untouched
  });

  it('(2) no orphans: both tutorials in active manifest → return 0, nothing deleted', async () => {
    await insertManifest(1);
    await insertContentFile('tutorial-alpha', 1);
    await insertContentFile('tutorial-beta', 1);

    await insertTutorial('tid-a', 'tutorial-alpha');
    await insertTutorial('tid-b', 'tutorial-beta');

    await insertEmbedding('tid-a', 1, 'hash-a1');
    await insertEmbedding('tid-b', 1, 'hash-b1');

    const deleted = await pruneOrphanEmbeddings();

    expect(deleted).toBe(0);
    expect(await countEmbeddings('tid-a')).toBe(1);
    expect(await countEmbeddings('tid-b')).toBe(1);
  });

  it('(3) no active manifest: returns 0, no embeddings touched', async () => {
    // Only a SUPERSEDED manifest — no ACTIVE one
    await insertManifest(1, 'SUPERSEDED');

    await insertTutorial('tid-a', 'tutorial-alpha');
    await insertEmbedding('tid-a', 1, 'hash-a1');

    const deleted = await pruneOrphanEmbeddings();

    expect(deleted).toBe(0);
    expect(await countEmbeddings('tid-a')).toBe(1); // untouched
  });

  it('(4) empty active manifest: all tutorials are orphans → all embeddings deleted', async () => {
    // Active manifest exists but has zero ContentFiles
    await insertManifest(1);

    await insertTutorial('tid-a', 'tutorial-alpha');
    await insertTutorial('tid-b', 'tutorial-beta');

    await insertEmbedding('tid-a', 1, 'hash-a1');
    await insertEmbedding('tid-b', 1, 'hash-b1');
    await insertEmbedding('tid-b', 2, 'hash-b2');

    const deleted = await pruneOrphanEmbeddings();

    expect(deleted).toBe(3);
    expect(await countEmbeddings('tid-a')).toBe(0);
    expect(await countEmbeddings('tid-b')).toBe(0);
  });
});
