// srv/__tests__/lib/semantic-search-visibility.test.js
//
// TDD for Task 1: Fix public semantic_search ROLE_GATED leak (#3168, #3099).
// Tests that the public anonymous semantic tutorial corpus excludes ROLE_GATED
// tutorials even when they are ACTIVE and present in ContentCurrent.

import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { _setTestEmbedClient, _resetForTest, semanticSearch } from '../../lib/semantic-search.js';

const NS = 'com.sap.developers.ims';

cds.test('serve', '--project', '.', '--in-memory');

/**
 * Seed a tutorial with an embedding and ContentCurrent entry.
 * @param {string} slug - Tutorial slug
 * @param {object} opts - { visibility: 'LISTED' | 'ROLE_GATED', model: 'text-embedding-3-small' }
 */
async function seedTutorialWithEmbedding(slug, { visibility = 'LISTED', model = 'text-embedding-3-small' } = {}) {
  const NS_ENT = cds.entities(NS);
  const { ContentManifest, ContentFiles, Tutorials, TutorialEmbedding, ContentCurrent, Steps } = NS_ENT;

  const tutorialId = cds.utils.uuid();
  const stepId = cds.utils.uuid();
  const html = `<html><body>Content for ${slug}</body></html>`;

  // Ensure we have an ACTIVE manifest.
  const existing = await SELECT.one.from(ContentManifest).where({ status: 'ACTIVE' });
  if (!existing) {
    await INSERT.into(ContentManifest).entries({
      version: 1, status: 'ACTIVE', activatedAt: new Date().toISOString(),
    });
  }

  // Insert ContentFiles entry.
  await INSERT.into(ContentFiles).entries({
    slug, version: 1,
    content: gzipSync(Buffer.from(html)),
    sourceContent: gzipSync(Buffer.from(`---\ntitle: ${slug}\n---\n`)),
    contentHash: `hash-${slug}`, sourceHash: `src-${slug}`,
    mimeType: 'text/html', sizeBytes: html.length,
  });

  // Insert Tutorial with specified visibility.
  await INSERT.into(Tutorials).entries({
    ID: tutorialId, slug, title: slug, status: 'ACTIVE', visibility,
  });

  // Insert a Step for the tutorial (needed for embedding FK).
  await INSERT.into(Steps).entries({
    ID: stepId, tutorial_ID: tutorialId, stepNumber: 1, duration: 5, title: `Step 1 of ${slug}`,
  });

  // Create a dummy embedding vector (1536 floats, all 0.1 for simplicity).
  const dummyVec = new Float32Array(1536);
  dummyVec.fill(0.1);
  const vecBuffer = Buffer.alloc(dummyVec.length * 4);
  for (let i = 0; i < dummyVec.length; i++) {
    vecBuffer.writeFloatLE(dummyVec[i], i * 4);
  }

  // Insert TutorialEmbedding.
  await INSERT.into(TutorialEmbedding).entries({
    tutorial_ID: tutorialId, stepNumber: 1,
    contentHash: `hash-${slug}`,
    embeddingModel: model,
    embedding: vecBuffer,
    stepText: `${slug} step 1 content`,
    charCount: `${slug} step 1 content`.length,
  });

  // Insert ContentCurrent entry to mark this slug as servable.
  await INSERT.into(ContentCurrent).entries({
    slug, version: 1, mimeType: 'text/html',
    content: gzipSync(Buffer.from(html)),
  });
}

describe('semantic search visibility enforcement', () => {
  beforeAll(async () => {
    await cds.connect.to('db');
  });

  beforeEach(async () => {
    // Clear per-test to avoid slug collisions.
    const { ContentManifest, ContentFiles, Tutorials, TutorialEmbedding, ContentCurrent, Steps } = cds.entities(NS);
    await DELETE.from(TutorialEmbedding);
    await DELETE.from(ContentCurrent);
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(Steps);
    await DELETE.from(Tutorials);

    // Reset semantic-search module state.
    await _resetForTest();
  });

  it('public semantic search excludes ROLE_GATED tutorials', async () => {
    const model = 'text-embedding-3-small';

    // Seed two tutorials: one LISTED, one ROLE_GATED, both ACTIVE and in ContentCurrent.
    await seedTutorialWithEmbedding('listed-tutorial', { visibility: 'LISTED', model });
    await seedTutorialWithEmbedding('pre-release-secret', { visibility: 'ROLE_GATED', model });

    // Inject a fake embed fn that returns a reasonable query vector
    // (same dummy vector as the embedded tutorials).
    const queryVec = new Float32Array(1536);
    queryVec.fill(0.1);
    _setTestEmbedClient(async () => [queryVec]);

    // Call the public semantic search with corpus='tutorials' (the default).
    const results = await semanticSearch({
      query: 'test query',
      corpus: 'tutorials',
      settings: { embeddingModel: model },
    });

    const slugs = results.map(r => r.slug);

    // Pin as a true-positive probe: LISTED must be present (vacuous-pass guard),
    // and ROLE_GATED must be absent.
    expect(slugs).toContain('listed-tutorial');
    expect(slugs).not.toContain('pre-release-secret');
  });
});
