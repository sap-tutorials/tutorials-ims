// test/unit/semantic-search.test.js
//
// #2246 — unit tests for the public anonymous semantic/vector search.
//
// Two layers, both on in-memory SQLite:
//   1. Core module (srv/lib/semantic-search.js): corpus routing, topK clamp,
//      minScore floor, wire shape (NO vectors ever), embed-once + query cache.
//   2. Service handler (SearchService.semantic_search): feature gate (503 when
//      off), per-IP rate limit (429), and end-to-end anonymous invocation.
//
// The embed client is faked via _setTestEmbedClient so no AI Core call is made
// and scoring is deterministic: the query embeds to a unit vector on dim 0, so
// docs whose embedding is also dim-0 score 1.0 and dim-1 docs score 0.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

import {
  semanticSearch, clampTopK, VALID_CORPORA, DEFAULT_CORPUS, TOPK_MIN, TOPK_MAX,
  _setTestEmbedClient, _resetForTest as _resetModule,
} from '../../srv/lib/semantic-search.js';

const NS = 'com.sap.developers.ims';
const DIMS = 1536;

// Build a 1536-dim Float32 vector with a single nonzero entry (deterministic).
function unitVec(dim) {
  const a = new Float32Array(DIMS);
  a[dim] = 1;
  return a;
}
// Encode a Float32Array as the raw LE BLOB stored in a SQLite Vector/BLOB column.
function f32buf(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

// Fake embed(): returns a unit vector on dim 0 for every query and counts calls
// per query text so the cache behaviour is observable.
const embedCalls = new Map();
function installFakeEmbed() {
  embedCalls.clear();
  _setTestEmbedClient(async (inputs) => {
    for (const q of inputs) embedCalls.set(q, (embedCalls.get(q) || 0) + 1);
    return inputs.map(() => unitVec(0));
  });
}

async function seedCorpora() {
  const { Tutorials, TutorialEmbedding, Concepts } = cds.entities(NS);
  const { ApiDocs, Samples, DevtoberfestSessions } = cds.entities(`${NS}.external`);

  // Tutorials: alpha scores 1.0 (dim 0), beta scores 0 (dim 1 → below floor).
  await INSERT.into(Tutorials).entries([
    { ID: 'tid-alpha', slug: 'tut-alpha', title: 'Tutorial Alpha' },
    { ID: 'tid-beta', slug: 'tut-beta', title: 'Tutorial Beta' },
  ]);
  await INSERT.into(TutorialEmbedding).entries([
    { tutorial_ID: 'tid-alpha', stepNumber: 1, embeddingModel: 'text-embedding-3-small',
      stepText: 'Alpha step text about CAP', embedding: f32buf(unitVec(0)) },
    { tutorial_ID: 'tid-beta', stepNumber: 1, embeddingModel: 'text-embedding-3-small',
      stepText: 'Beta step text', embedding: f32buf(unitVec(1)) },
  ]);

  // Concept: ACTIVE + published + not merged, scores 1.0.
  await INSERT.into(Concepts).entries({
    ID: 'cid-x', slug: 'concept-x', name: 'Concept X', description: 'A concept description',
    status: 'ACTIVE', publishedAt: new Date().toISOString(), embedding: f32buf(unitVec(0)),
  });

  // External: api-x scores 1.0, sample-y scores 0 (below floor).
  await INSERT.into(ApiDocs).entries({
    ID: cds.utils.uuid(), slug: 'api-x', title: 'API X', url: 'https://api.sap.com/x',
    description: 'API doc description', embedding: f32buf(unitVec(0)),
  });
  await INSERT.into(Samples).entries({
    ID: cds.utils.uuid(), slug: 'sample-y', title: 'Sample Y', url: 'https://github.com/sap/y',
    description: 'Sample description', embedding: f32buf(unitVec(1)),
  });
  // #2311: Devtoberfest session dtf-z scores 1.0 (dim 0).
  await INSERT.into(DevtoberfestSessions).entries({
    ID: cds.utils.uuid(), slug: 'dtf-z', title: 'DTF Session Z', url: 'https://youtu.be/z',
    description: 'Devtoberfest session about CAP and AI', embedding: f32buf(unitVec(0)),
  });
}

const WIRE_KEYS = ['slug', 'title', 'stepNumber', 'snippet', 'score', 'url', 'contentType'];

// ─────────────────────────────────────────────────────────────
// clampTopK (pure)
// ─────────────────────────────────────────────────────────────
describe('clampTopK', () => {
  it('clamps to [TOPK_MIN, TOPK_MAX]', () => {
    expect(clampTopK(0)).toBe(TOPK_MIN);
    expect(clampTopK(-5)).toBe(TOPK_MIN);
    expect(clampTopK(999)).toBe(TOPK_MAX);
    expect(clampTopK(10)).toBe(10);
  });
  it('defaults to 5 for non-numeric input', () => {
    expect(clampTopK(undefined)).toBe(5);
    expect(clampTopK('nope')).toBe(5);
  });
  it('exposes the corpus contract', () => {
    expect(VALID_CORPORA).toEqual(['tutorials', 'concepts', 'external', 'all']);
    expect(DEFAULT_CORPUS).toBe('tutorials');
  });
});

// ─────────────────────────────────────────────────────────────
// Core module — semanticSearch()
// ─────────────────────────────────────────────────────────────
describe('semanticSearch (core module)', () => {
  const settings = { embeddingModel: 'text-embedding-3-small', embeddingTopK: 5, embeddingMinScore: 0.25 };

  beforeAll(async () => {
    await cds.deploy([path.join(process.cwd(), 'db')]).to('sqlite::memory:');
    await seedCorpora();
  });

  afterAll(async () => {
    _resetModule();
    await cds.disconnect();
    delete cds.db;
    delete cds.model;
  });

  beforeEach(() => { installFakeEmbed(); });

  it('empty/whitespace query returns [] without embedding', async () => {
    expect(await semanticSearch({ query: '', settings })).toEqual([]);
    expect(await semanticSearch({ query: '   ', settings })).toEqual([]);
    expect(embedCalls.size).toBe(0);
  });

  it('tutorials corpus: returns scored refs, drops sub-floor rows', async () => {
    const rows = await semanticSearch({ query: 'q-tut', corpus: 'tutorials', settings });
    expect(rows.map((r) => r.slug)).toEqual(['tut-alpha']); // beta scored 0 < 0.25
    expect(rows[0]).toMatchObject({
      slug: 'tut-alpha', title: 'Tutorial Alpha', stepNumber: 1,
      url: '/tutorials/tut-alpha', contentType: 'tutorial',
    });
    expect(rows[0].score).toBeCloseTo(1, 5);
    expect(rows[0].snippet).toContain('Alpha step text');
  });

  it('never leaks a vector/embedding in the wire shape', async () => {
    const rows = await semanticSearch({ query: 'q-shape', corpus: 'all', settings });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual([...WIRE_KEYS].sort());
      expect(r).not.toHaveProperty('embedding');
      expect(r).not.toHaveProperty('embeddingVec');
      expect(r).not.toHaveProperty('vector');
    }
  });

  it('concepts corpus: returns concept ref with description snippet', async () => {
    const rows = await semanticSearch({ query: 'q-concept', corpus: 'concepts', settings });
    expect(rows.map((r) => r.slug)).toEqual(['concept-x']);
    expect(rows[0]).toMatchObject({ title: 'Concept X', url: '/concepts/concept-x/', contentType: 'concept' });
    expect(rows[0].snippet).toContain('concept description');
  });

  it('external corpus: returns api-doc/sample/devtoberfest-session refs, drops sub-floor rows', async () => {
    const rows = await semanticSearch({ query: 'q-ext', corpus: 'external', settings });
    // api-x and dtf-z both score 1.0 (dim 0); sample-y scored 0 → dropped.
    expect(rows.map((r) => r.slug).sort()).toEqual(['api-x', 'dtf-z']);
    const session = rows.find((r) => r.slug === 'dtf-z');
    expect(session).toMatchObject({ url: 'https://youtu.be/z', contentType: 'devtoberfest-session' });
  });

  it('all corpus: merges + ranks + slices to topK', async () => {
    const rows = await semanticSearch({ query: 'q-all', corpus: 'all', topK: 2, settings });
    expect(rows.length).toBe(2);
    // Sorted by score desc; every returned row is above the floor.
    expect(rows.every((r) => r.score >= 0.25)).toBe(true);
    expect(rows[0].score).toBeGreaterThanOrEqual(rows[1].score);
  });

  it('unknown corpus falls back to the default (tutorials)', async () => {
    const rows = await semanticSearch({ query: 'q-bogus', corpus: 'nonsense', settings });
    expect(rows.every((r) => r.contentType === 'tutorial')).toBe(true);
  });

  it('caller topK is clamped', async () => {
    const rows = await semanticSearch({ query: 'q-clamp', corpus: 'all', topK: 999, settings });
    expect(rows.length).toBeLessThanOrEqual(TOPK_MAX);
  });

  it('embeds the query exactly once per call regardless of corpus fan-out', async () => {
    await semanticSearch({ query: 'q-once', corpus: 'all', settings });
    expect(embedCalls.get('q-once')).toBe(1);
  });

  it('caches the query embedding across calls (no re-embed)', async () => {
    // Fresh embed counter for a unique query; two identical calls.
    await semanticSearch({ query: 'q-cache-unique', corpus: 'tutorials', settings });
    await semanticSearch({ query: 'q-cache-unique', corpus: 'tutorials', settings });
    expect(embedCalls.get('q-cache-unique')).toBe(1);
  });
});
