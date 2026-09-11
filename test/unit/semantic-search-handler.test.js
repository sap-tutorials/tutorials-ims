// test/unit/semantic-search-handler.test.js
//
// #2246 — service-layer tests for SearchService.semantic_search: the feature
// gate (503 when ChatSettings.semanticSearchEnabled is off), the per-IP rate
// limiter (429), and end-to-end anonymous invocation returning scored refs.
//
// Serves SearchService against in-memory SQLite and drives it via
// SearchService.send(). The embed client is faked so no AI Core call is made.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

import { _setTestEmbedClient } from '../../srv/lib/semantic-search.js';
import { _resetForTest as _resetSvc } from '../../srv/search-service.js';
import { _resetCacheForTests as _resetSearchSettings } from '../../srv/lib/runtime-config/search-settings.js';

const NS = 'com.sap.developers.ims';
const DIMS = 1536;

function unitVec(dim) { const a = new Float32Array(DIMS); a[dim] = 1; return a; }
function f32buf(v) { return Buffer.from(v.buffer, v.byteOffset, v.byteLength); }

let SearchService;

async function setSemanticEnabled(enabled) {
  const { ChatSettings } = cds.entities(NS);
  await DELETE.from(ChatSettings);
  await INSERT.into(ChatSettings).entries({
    ID: cds.utils.uuid(), semanticSearchEnabled: enabled,
    embeddingModel: 'text-embedding-3-small', embeddingTopK: 5, embeddingMinScore: 0.25,
  });
  _resetSvc(); // bust the 30s ChatSettings cache + limiter cache
}

beforeAll(async () => {
  await cds.deploy([
    path.join(process.cwd(), 'db'),
    path.join(process.cwd(), 'srv'),
  ]).to('sqlite::memory:');

  SearchService = await cds.serve('SearchService').from('./srv/search-service');

  _setTestEmbedClient(async (inputs) => inputs.map(() => unitVec(0)));

  const { Tutorials, TutorialEmbedding } = cds.entities(NS);
  await INSERT.into(Tutorials).entries({ ID: 'h-tid', slug: 'handler-tut', title: 'Handler Tut' });
  await INSERT.into(TutorialEmbedding).entries({
    tutorial_ID: 'h-tid', stepNumber: 1, embeddingModel: 'text-embedding-3-small',
    stepText: 'Handler step text', embedding: f32buf(unitVec(0)),
  });
});

afterAll(async () => {
  _resetSvc();
  await cds.disconnect();
  delete cds.db;
  delete cds.model;
});

describe('SearchService.semantic_search', () => {
  it('returns 503 when semanticSearchEnabled is off', async () => {
    await setSemanticEnabled(false);
    await expect(SearchService.send('semantic_search', { query: 'anything' }))
      .rejects.toMatchObject({ code: 503 });
  });

  it('returns scored refs (no vectors) when enabled', async () => {
    await setSemanticEnabled(true);
    _resetSearchSettings();
    const rows = await SearchService.send('semantic_search', { query: 'cap', corpus: 'tutorials' });
    expect(rows.map((r) => r.slug)).toEqual(['handler-tut']);
    expect(rows[0]).toMatchObject({ contentType: 'tutorial', url: '/tutorials/handler-tut' });
    expect(rows[0]).not.toHaveProperty('embedding');
    expect(rows[0]).not.toHaveProperty('embeddingVec');
  });

  it('rate-limits with 429 once the per-IP budget is exhausted', async () => {
    // Seed a max=1 budget, reset caches so the handler builds a fresh limiter.
    const { SearchSettings } = cds.entities(NS);
    await DELETE.from(SearchSettings);
    await INSERT.into(SearchSettings).entries({
      ID: cds.utils.uuid(), rateLimitMax: 1, rateLimitWindowMs: 60000,
    });
    await setSemanticEnabled(true);
    _resetSearchSettings();

    // First call consumes the single slot; second is rejected 429.
    await SearchService.send('semantic_search', { query: 'first', corpus: 'tutorials' });
    await expect(SearchService.send('semantic_search', { query: 'second', corpus: 'tutorials' }))
      .rejects.toMatchObject({ code: 429 });
  });
});
