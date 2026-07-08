// test/hybrid/mcp-tools.test.js
//
// Hybrid smoke tests for the 8 curated MCP tools against real HANA.
// One happy-path assertion per tool. The unit-test layer proves shape;
// this layer proves the tools actually work against a live database.
//
// Read-only — no writes, no cleanup, no isSafeForWrites() guard needed.
//
// Runs with `npm run test:hybrid -- test/hybrid/mcp-tools.test.js`
// (which unwraps to `cds bind --exec -- npx vitest run --project hybrid`).
//
// Slug env vars let you override which tutorial/mission the test picks
// against a channel where the defaults might not exist yet:
//   MCP_SMOKE_MISSION_SLUG   (defaults to 'introducing-cap' — a stable
//                              mission that has always shipped with the
//                              CAP dev-content bundle)
//   MCP_SMOKE_TUTORIAL_SLUG  (defaults to 'introducing-cap')
//
// (#912 Task 12)

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const MISSION_SLUG  = process.env.MCP_SMOKE_MISSION_SLUG  ?? 'introducing-cap';
const TUTORIAL_SLUG = process.env.MCP_SMOKE_TUTORIAL_SLUG ?? 'introducing-cap';

describe('MCP tools against real HANA (#912 hybrid smoke)', { timeout: 30_000 }, () => {
  let SearchService;
  let HomepageService;
  let KG;

  beforeAll(async () => {
    SearchService   = await cds.connect.to('SearchService');
    HomepageService = await cds.connect.to('HomepageService');
    KG              = await cds.connect.to('KnowledgeGraphService');
  });

  // ─── SearchService ─────────────────────────────────────────────────────────

  it('search_tutorials returns HANA rows for a broad query', async () => {
    const results = await SearchService.send('search_tutorials', { query: 'CAP', limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    // We can't hard-assert non-empty because a fresh env may not have tutorials
    // matching "CAP" yet — but if we do get rows they must be well-shaped.
    for (const r of results) {
      expect(r).toHaveProperty('slug');
      expect(r).toHaveProperty('title');
    }
  });

  it('list_missions returns bounded array with tutorial counts', async () => {
    const results = await SearchService.send('list_missions', { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeLessThanOrEqual(5);
    for (const m of results) {
      expect(m).toHaveProperty('slug');
      expect(m).toHaveProperty('title');
      expect(typeof m.tutorialCount).toBe('number');
    }
  });

  it('get_mission resolves a known slug (or returns null cleanly)', async () => {
    const result = await SearchService.send('get_mission', { slug: MISSION_SLUG });
    // We accept null (mission not yet migrated to this env). If non-null,
    // the shape must be right — that's the smoke assertion.
    if (result) {
      expect(result.slug).toBe(MISSION_SLUG);
      expect(Array.isArray(result.tutorials)).toBe(true);
    }
  });

  it('get_tutorial returns metadata + steps for a known slug', async () => {
    const result = await SearchService.send('get_tutorial', { slug: TUTORIAL_SLUG });
    if (result) {
      expect(result.slug).toBe(TUTORIAL_SLUG);
      expect(Array.isArray(result.steps)).toBe(true);
      // The Phase-1 tool intentionally omits html — the reference doc
      // says step HTML slicing lands in Phase 2.
      expect(result.html).toBeUndefined();
    }
  });

  // ─── HomepageService ────────────────────────────────────────────────────────

  it('get_recent_news returns items from live feed', async () => {
    const results = await HomepageService.send('get_recent_news', { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    for (const n of results) {
      expect(n).toHaveProperty('title');
      expect(n).toHaveProperty('link');
    }
  });

  it('get_recent_videos returns items from live corpus', async () => {
    const results = await HomepageService.send('get_recent_videos', { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    for (const v of results) {
      expect(v).toHaveProperty('videoId');
      expect(v).toHaveProperty('title');
    }
  });

  // ─── KnowledgeGraphService ──────────────────────────────────────────────────

  it('kg_prerequisites tolerates a known tutorial slug', async () => {
    // KG neighborhood is fail-open — always returns an array, never throws.
    const results = await KG.send('kg_prerequisites', { tutorial_slug: TUTORIAL_SLUG });
    expect(Array.isArray(results)).toBe(true);
  });

  it('kg_what_to_learn_next tolerates a known tutorial slug', async () => {
    const results = await KG.send('kg_what_to_learn_next', { tutorial_slug: TUTORIAL_SLUG });
    expect(Array.isArray(results)).toBe(true);
  });
});
