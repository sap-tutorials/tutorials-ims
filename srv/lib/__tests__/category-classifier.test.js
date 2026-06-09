// srv/lib/__tests__/category-classifier.test.js
// TDD tests for the classifier core (embedding-first, LLM fallback).
// Phase 3, Tasks 3.3 + 3.4 of the categories-facet plan.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock declarations (must precede the import under test) ──────────────────

const mockGetSeedEmbeddings = vi.fn();
const mockEmbedAdHoc = vi.fn();
const mockClassifyViaLlm = vi.fn();

vi.mock('../category-seed-embeddings.js', () => ({
  getSeedEmbeddings: () => mockGetSeedEmbeddings(),
  embedAdHoc: (...a) => mockEmbedAdHoc(...a),
}));

vi.mock('../category-classifier-llm.js', () => ({
  classifyViaLlm: (...a) => mockClassifyViaLlm(...a),
}));

// Track all tx.run() calls for assertion.
let txRunCalls = [];

vi.mock('@sap/cds', () => {
  const tx = vi.fn(async (fn) => {
    const txCtx = {
      run: vi.fn(async (stmt) => {
        txRunCalls.push(stmt);
        return undefined;
      }),
    };
    return fn(txCtx);
  });
  const log = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() });
  log.info = vi.fn();
  return {
    default: {
      log,
      tx,
      entities: () => ({
        Missions:           { name: 'Missions' },
        Groups:             { name: 'Groups' },
        Tutorials:          { name: 'Tutorials' },
        Categories:         { name: 'Categories' },
        MissionCategories:  { name: 'MissionCategories' },
        GroupCategories:    { name: 'GroupCategories' },
        TutorialCategories: { name: 'TutorialCategories' },
        TutorialEmbedding:  { name: 'TutorialEmbedding' },
      }),
    },
  };
});

// ── Global CDS SELECT stub ──────────────────────────────────────────────────
// The classifier makes two patterns of SELECT:
//   1. SELECT.from(<ItemEntity>).columns(...).where(...)  — item lookup
//   2. SELECT.from(<Categories>).columns(...)            — taxonomy lookup
//
// We give each test full control by wiring TAXONOMY_ROWS and ITEM_ROWS.

let TAXONOMY_ROWS = [];
let ITEM_ROWS = [];

// Taxonomy rows use a stable 3-entry fixture:
const TAXONOMY = [
  { ID: 'cat-ai',   slug: 'artificial-intelligence', label: 'Artificial Intelligence',              sortOrder: 50 },
  { ID: 'cat-app',  slug: 'app-dev-automation',      label: 'Application Development & Automation', sortOrder: 10 },
  { ID: 'cat-data', slug: 'data-analytics',          label: 'Data & Analytics',                     sortOrder: 20 },
];

beforeEach(() => {
  txRunCalls = [];
  mockGetSeedEmbeddings.mockReset();
  mockEmbedAdHoc.mockReset();
  mockClassifyViaLlm.mockReset();
  TAXONOMY_ROWS = [...TAXONOMY];
  ITEM_ROWS = [{ ID: 'item-1', title: 'AI agent', description: '', primaryTag: 'topic>ai' }];

  // Chainable SELECT mock: SELECT.from(ent).columns(...).where(...)
  // Returns a thenable so tests that omit .where() also work.
  globalThis.SELECT = {
    from: (ent) => {
      const entityName = typeof ent === 'string' ? ent : (ent?.name ?? '');
      const isCategories = entityName === 'Categories';
      const thenableResult = isCategories ? TAXONOMY_ROWS : ITEM_ROWS;
      const obj = {
        columns: (..._cols) => ({
          where: (..._conds) => Promise.resolve(thenableResult),
          then: (resolve) => resolve(thenableResult),
        }),
        then: (resolve) => resolve(thenableResult),
      };
      return obj;
    },
  };

  globalThis.DELETE = {
    from: (junctionName) => ({
      where: (cond) => ({ _type: 'DELETE', junctionName, cond }),
    }),
  };

  globalThis.INSERT = {
    into: (junctionName) => ({
      entries: (rows) => ({ _type: 'INSERT', junctionName, rows }),
    }),
  };
});

// ── Import the module under test after mocks ────────────────────────────────
import { classifyAndPersist, HIGH_THRESHOLD, AMBIGUITY_GAP, MAX_CATEGORIES } from '../category-classifier.js';

// ── Helper ───────────────────────────────────────────────────────────────────
/** Normalise a Float32Array (or plain array) to unit length. */
function norm(arr) {
  const magnitude = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
  return magnitude === 0 ? new Float32Array(arr) : new Float32Array(arr.map(v => v / magnitude));
}

// ── Exported constant smoke-check ────────────────────────────────────────────
describe('exported constants', () => {
  it('HIGH_THRESHOLD = 0.32', () => expect(HIGH_THRESHOLD).toBe(0.32));
  it('AMBIGUITY_GAP  = 0.05', () => expect(AMBIGUITY_GAP).toBe(0.05));
  it('MAX_CATEGORIES = 3',    () => expect(MAX_CATEGORIES).toBe(3));
});

// ── Core classify tests ───────────────────────────────────────────────────────
describe('classifyAndPersist', () => {

  // ── Test 1: Embedding clear win ────────────────────────────────────────────
  it('1. embedding clear win — uses embedding path, no LLM', async () => {
    // Seed vectors: cat-ai=[1,0,0], cat-app=[0,1,0], cat-data=[0,0,1]
    const seedMap = new Map([
      ['cat-ai',   new Float32Array([1, 0, 0])],
      ['cat-app',  new Float32Array([0, 1, 0])],
      ['cat-data', new Float32Array([0, 0, 1])],
    ]);
    mockGetSeedEmbeddings.mockResolvedValue(seedMap);

    // Item vector aligns perfectly with cat-ai.
    // cosines: cat-ai=1.0, cat-app=0, cat-data=0  → gap = 1.0 >> AMBIGUITY_GAP
    mockEmbedAdHoc.mockResolvedValue(new Float32Array([1, 0, 0]));

    const result = await classifyAndPersist('mission', 'item-1');

    expect(result.path).toBe('embedding');
    expect(result.assigned.length).toBeGreaterThan(0);
    expect(result.assigned[0].slug).toBe('artificial-intelligence');
    expect(mockClassifyViaLlm).not.toHaveBeenCalled();
    expect(result.kept).toBe(1);

    // Transaction should have run (DELETE + INSERT).
    expect(txRunCalls.length).toBe(2);
  });

  // ── Test 2: Ambiguous scores → LLM ────────────────────────────────────────
  it('2. ambiguous embedding scores → falls through to LLM', async () => {
    // cat-ai and cat-app are nearly identical in direction → ambiguous
    // Use vectors where cosine(item, cat-ai) ≈ cosine(item, cat-app), gap < 0.05
    const seedMap = new Map([
      ['cat-ai',   new Float32Array([1, 0, 0])],
      ['cat-app',  new Float32Array([0.999, 0.045, 0])],  // almost the same direction
      ['cat-data', new Float32Array([0, 0, 1])],
    ]);
    mockGetSeedEmbeddings.mockResolvedValue(seedMap);

    // Item vector exactly matching cat-ai direction.
    // cosine(item, cat-ai)  = 1.0
    // cosine(item, cat-app) = 0.999/sqrt(0.999^2+0.045^2) ≈ 0.9990 → gap ≈ 0.001 < AMBIGUITY_GAP
    mockEmbedAdHoc.mockResolvedValue(new Float32Array([1, 0, 0]));

    mockClassifyViaLlm.mockResolvedValue({
      assigned: [{ slug: 'app-dev-automation', confidence: 0.85 }],
      modelName: 'test-model',
      promptTokens: 100,
      completionTokens: 20,
    });

    const result = await classifyAndPersist('mission', 'item-1');

    expect(result.path).toBe('llm');
    expect(result.assigned.length).toBeGreaterThan(0);
    expect(result.assigned[0].slug).toBe('app-dev-automation');
    expect(mockClassifyViaLlm).toHaveBeenCalledOnce();
    expect(result.kept).toBe(1);
  });

  // ── Test 3: Below threshold → LLM ─────────────────────────────────────────
  it('3. all cosines below HIGH_THRESHOLD → LLM called', async () => {
    // Item vector orthogonal to all seeds — all cosines = 0
    const seedMap = new Map([
      ['cat-ai',   new Float32Array([1, 0, 0])],
      ['cat-app',  new Float32Array([0, 1, 0])],
      ['cat-data', new Float32Array([0, 0, 1])],
    ]);
    mockGetSeedEmbeddings.mockResolvedValue(seedMap);

    // A "fourth dimension" unit vector — orthogonal to all seeds.
    // cosines all = 0, which is well below HIGH_THRESHOLD = 0.32.
    const itemVec = new Float32Array(4);
    itemVec[3] = 1;
    mockEmbedAdHoc.mockResolvedValue(itemVec);

    mockClassifyViaLlm.mockResolvedValue({
      assigned: [{ slug: 'data-analytics', confidence: 0.6 }],
      modelName: 'test-model',
      promptTokens: 80,
      completionTokens: 15,
    });

    const result = await classifyAndPersist('mission', 'item-1');

    expect(result.path).toBe('llm');
    expect(result.assigned[0].slug).toBe('data-analytics');
    expect(mockClassifyViaLlm).toHaveBeenCalledOnce();
    expect(result.kept).toBe(1);
  });

  // ── Test 4: LLM also fails → skip ─────────────────────────────────────────
  it('4. LLM also fails → path=skip, no INSERT', async () => {
    // All cosines below threshold.
    const seedMap = new Map([
      ['cat-ai',   new Float32Array([1, 0, 0])],
      ['cat-app',  new Float32Array([0, 1, 0])],
      ['cat-data', new Float32Array([0, 0, 1])],
    ]);
    mockGetSeedEmbeddings.mockResolvedValue(seedMap);

    const itemVec = new Float32Array(4);
    itemVec[3] = 1;
    mockEmbedAdHoc.mockResolvedValue(itemVec);

    mockClassifyViaLlm.mockRejectedValue(new Error('LLM down'));

    const result = await classifyAndPersist('mission', 'item-1');

    expect(result.path).toBe('skip');
    expect(result.assigned).toEqual([]);
    expect(result.kept).toBe(0);

    // No persist transaction should have been opened.
    expect(txRunCalls.length).toBe(0);
  });

  // ── Extra: item not found → skip ──────────────────────────────────────────
  it('5. item not found in DB → path=skip', async () => {
    ITEM_ROWS = [];  // SELECT returns no row
    const seedMap = new Map([['cat-ai', new Float32Array([1, 0, 0])]]);
    mockGetSeedEmbeddings.mockResolvedValue(seedMap);

    const result = await classifyAndPersist('mission', 'nonexistent-id');

    expect(result.path).toBe('skip');
    expect(result.assigned).toEqual([]);
    expect(mockClassifyViaLlm).not.toHaveBeenCalled();
  });
});
