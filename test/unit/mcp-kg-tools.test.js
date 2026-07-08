// test/unit/mcp-kg-tools.test.js
//
// Unit tests for KnowledgeGraphService MCP curated tools:
//   kg_prerequisites(tutorial_slug, depth?)
//   kg_what_to_learn_next(tutorial_slug, limit?)
//
// (#912 Task 10)
//
// Mocking strategy
// ─────────────────
// The handlers call `this.send('neighborhood', { slug })` internally.
// We need to let the real `kg_prerequisites` / `kg_what_to_learn_next`
// handler run, but short-circuit the inner `neighborhood` call so it
// returns a canned NeighborhoodResult rather than hitting the HANA-only
// SPARQL execution path.
//
// 1. In `beforeAll`, capture `originalKGSend = KG.send.bind(KG)` BEFORE
//    any spy is applied. This reference always calls the real (un-spied)
//    dispatch chain.
// 2. In each test, apply `vi.spyOn(KG, 'send').mockImplementation(...)`:
//    - 'neighborhood' → return the canned result
//    - anything else  → call `originalKGSend(event, data)` (the real chain)
// 3. When `KG.send('kg_prerequisites', ...)` fires:
//    a. Spy sees event='kg_prerequisites' → falls through to originalKGSend
//    b. originalKGSend dispatches the real handler
//    c. Handler calls `this.send('neighborhood', ...)` → spy intercepts
//    d. Spy returns canned result → handler slices the arm → test passes
// 4. Spy is restored in `afterEach` so tests are isolated.
//
// The feature flag KNOWLEDGE_GRAPH_ENABLED must be 'true' before the
// service boots — the before('*') gate rejects every request with 503 when
// it's absent. Same pattern as
// test/unit/kg-neighborhood-cache-hit-handlers.test.js.

import { expect, describe, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { _resetCacheForTests } from '../../srv/lib/runtime-config/kg-settings.js';

// Must be set BEFORE the service module is loaded.
process.env.KNOWLEDGE_GRAPH_ENABLED = 'true';

// ─── Canned data ─────────────────────────────────────────────────────────────

const CANNED_PREREQS = [
  { slug: 'prereq-alpha', title: 'Prereq Alpha', weight: 0.9, reason: 'teaches a prerequisite concept' },
  { slug: 'prereq-beta',  title: 'Prereq Beta',  weight: 0.8, reason: 'teaches a prerequisite concept' },
];
const CANNED_NEXT = [
  { slug: 'next-alpha', title: 'Next Alpha', weight: 0.7, reason: 'next step — builds on what this tutorial teaches' },
  { slug: 'next-beta',  title: 'Next Beta',  weight: 0.6, reason: 'next step — builds on what this tutorial teaches' },
  { slug: 'next-gamma', title: 'Next Gamma', weight: 0.5, reason: 'next step — builds on what this tutorial teaches' },
];

/**
 * Build a canned NeighborhoodResult with caller-specified arm sizes.
 * Used by clamp/slice tests to verify depth/limit handling.
 */
function buildCannedNeighborhood(prereqCount, nextCount) {
  return {
    tutorial:        { slug: 'test-tutorial', title: 'Test Tutorial' },
    graphVersion:    'gv-1',
    teaches:         [],
    prerequisitesOf: Array.from({ length: prereqCount }, (_, i) => ({
      slug:   `prereq-${i}`,
      title:  `Prereq ${i}`,
      weight: 0.9 - i * 0.01,
      reason: 'teaches a prerequisite concept',
    })),
    sharedConcepts:  [],
    whatToLearnNext: Array.from({ length: nextCount }, (_, i) => ({
      slug:   `next-${i}`,
      title:  `Next ${i}`,
      weight: 0.7 - i * 0.01,
      reason: 'next step — builds on what this tutorial teaches',
    })),
    otherResources:  [],
    typeConfig:      [],
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('MCP curated tools: KnowledgeGraphService', () => {
  let KG;
  let originalKGSend; // Captured BEFORE any spy — always calls the real dispatch.

  beforeAll(async () => {
    // Clear the 5-second settings cache so the env-var change above is
    // picked up by the first resolveKnowledgeGraphSettings() call.
    _resetCacheForTests();

    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');

    KG = await cds.serve('KnowledgeGraphService').from('./srv/knowledge-graph-service');

    // Capture the real send BEFORE any test applies a spy. This ref never
    // gets replaced by vi.spyOn so it always reaches the real handler.
    originalKGSend = KG.send.bind(KG);
  });

  afterAll(async () => {
    await cds.disconnect();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Helper: create a routing spy ────────────────────────────────────────
  // Routes 'neighborhood' to the caller-supplied factory; all other events
  // pass through to the real handler via originalKGSend.
  function spyNeighborhood(neighborhoodFactory) {
    return vi.spyOn(KG, 'send').mockImplementation(async (event, data) => {
      if (event === 'neighborhood') {
        return neighborhoodFactory(event, data);
      }
      return originalKGSend(event, data);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // kg_prerequisites
  // ─────────────────────────────────────────────────────────────

  describe('kg_prerequisites', () => {
    it('returns array of TutorialRef (slug, title, weight, reason) entries', async () => {
      spyNeighborhood(() => buildCannedNeighborhood(2, 2));

      const results = await KG.send('kg_prerequisites', { tutorial_slug: 'test-tutorial' });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r).toHaveProperty('slug');
        expect(r).toHaveProperty('title');
        expect(r).toHaveProperty('weight');
        expect(r).toHaveProperty('reason');
      }
    });

    it('slices prerequisitesOf arm and returns it as the result', async () => {
      spyNeighborhood(() => ({
        ...buildCannedNeighborhood(0, 0),
        prerequisitesOf: CANNED_PREREQS,
      }));

      const results = await KG.send('kg_prerequisites', { tutorial_slug: 'test-tutorial', depth: 10 });

      expect(results).toHaveLength(CANNED_PREREQS.length);
      expect(results[0].slug).toBe('prereq-alpha');
      expect(results[1].slug).toBe('prereq-beta');
    });

    it('respects depth — slices to depth when arm is larger', async () => {
      spyNeighborhood(() => buildCannedNeighborhood(20, 0));

      const results = await KG.send('kg_prerequisites', { tutorial_slug: 'test-tutorial', depth: 3 });

      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('clamps depth at 50 even when caller passes 999', async () => {
      spyNeighborhood(() => buildCannedNeighborhood(60, 0));

      const results = await KG.send('kg_prerequisites', { tutorial_slug: 'test-tutorial', depth: 999 });

      expect(results.length).toBeLessThanOrEqual(50);
    });

    it('returns empty array for empty slug (does not throw, neighborhood not called)', async () => {
      // No spy needed — handler short-circuits before calling neighborhood.
      const results = await KG.send('kg_prerequisites', { tutorial_slug: '' });

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(0);
    });

    it('lowercases tutorial_slug before forwarding to neighborhood', async () => {
      let capturedSlug;
      vi.spyOn(KG, 'send').mockImplementation(async (event, data) => {
        if (event === 'neighborhood') {
          capturedSlug = data?.slug;
          return buildCannedNeighborhood(1, 0);
        }
        return originalKGSend(event, data);
      });

      await KG.send('kg_prerequisites', { tutorial_slug: 'TEST-TUTORIAL' });

      expect(capturedSlug).toBe('test-tutorial');
    });

    it('returns empty array when neighborhood returns empty prerequisitesOf', async () => {
      spyNeighborhood(() => ({
        tutorial: { slug: 'x', title: 'x' },
        graphVersion: 'gv-1',
        prerequisitesOf: [],
        whatToLearnNext: [],
      }));

      const results = await KG.send('kg_prerequisites', { tutorial_slug: 'unknown-slug' });

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(0);
    });

    it('does not read req.user (anonymous call must not throw)', async () => {
      spyNeighborhood(() => buildCannedNeighborhood(1, 0));

      const results = await KG.send('kg_prerequisites', { tutorial_slug: 'test-tutorial' });

      expect(Array.isArray(results)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // kg_what_to_learn_next
  // ─────────────────────────────────────────────────────────────

  describe('kg_what_to_learn_next', () => {
    it('returns array of TutorialRef (slug, title, weight, reason) entries', async () => {
      spyNeighborhood(() => buildCannedNeighborhood(0, 3));

      const results = await KG.send('kg_what_to_learn_next', { tutorial_slug: 'test-tutorial' });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r).toHaveProperty('slug');
        expect(r).toHaveProperty('title');
        expect(r).toHaveProperty('weight');
        expect(r).toHaveProperty('reason');
      }
    });

    it('slices whatToLearnNext arm and returns it as the result', async () => {
      spyNeighborhood(() => ({
        ...buildCannedNeighborhood(0, 0),
        whatToLearnNext: CANNED_NEXT,
      }));

      const results = await KG.send('kg_what_to_learn_next', { tutorial_slug: 'test-tutorial', limit: 10 });

      expect(results).toHaveLength(CANNED_NEXT.length);
      expect(results[0].slug).toBe('next-alpha');
    });

    it('respects limit — slices to limit when arm is larger', async () => {
      spyNeighborhood(() => buildCannedNeighborhood(0, 20));

      const results = await KG.send('kg_what_to_learn_next', { tutorial_slug: 'test-tutorial', limit: 5 });

      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('clamps limit at 50 even when caller passes 999', async () => {
      spyNeighborhood(() => buildCannedNeighborhood(0, 60));

      const results = await KG.send('kg_what_to_learn_next', { tutorial_slug: 'test-tutorial', limit: 999 });

      expect(results.length).toBeLessThanOrEqual(50);
    });

    it('returns empty array for empty slug (does not throw, neighborhood not called)', async () => {
      const results = await KG.send('kg_what_to_learn_next', { tutorial_slug: '' });

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(0);
    });

    it('returns empty array when neighborhood returns empty whatToLearnNext', async () => {
      spyNeighborhood(() => ({
        tutorial: { slug: 'x', title: 'x' },
        graphVersion: 'gv-1',
        prerequisitesOf: [],
        whatToLearnNext: [],
      }));

      const results = await KG.send('kg_what_to_learn_next', { tutorial_slug: 'unknown-slug' });

      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(0);
    });

    it('does not read req.user (anonymous call must not throw)', async () => {
      spyNeighborhood(() => buildCannedNeighborhood(0, 2));

      const results = await KG.send('kg_what_to_learn_next', { tutorial_slug: 'test-tutorial' });

      expect(Array.isArray(results)).toBe(true);
    });
  });
});
