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
import { handleSharedConcepts, handleNeighborhood, handleSearchConcepts, handleCommunity } from '../../srv/lib/mcp-kg-tools.js';

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

    it('fails open on neighborhood error — returns [] without echoing e.message (#1111)', async () => {
      const SECRET = 'ORA-00942: table SENSITIVE_INTERNAL does not exist';
      spyNeighborhood(() => { throw new Error(SECRET); });

      // Must resolve to [] (fail-open), NOT reject — a rejection would carry
      // the error message to the anonymous MCP caller.
      const results = await KG.send('kg_prerequisites', { tutorial_slug: 'test-tutorial' });

      expect(results).toEqual([]);
      // Belt-and-braces: nothing the caller can observe leaks the raw message.
      expect(JSON.stringify(results)).not.toContain(SECRET);
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

    it('fails open on neighborhood error — returns [] without echoing e.message (#1111)', async () => {
      const SECRET = 'ORA-00942: table SENSITIVE_INTERNAL does not exist';
      spyNeighborhood(() => { throw new Error(SECRET); });

      const results = await KG.send('kg_what_to_learn_next', { tutorial_slug: 'test-tutorial' });

      expect(results).toEqual([]);
      expect(JSON.stringify(results)).not.toContain(SECRET);
    });
  });
});

// ─── kg_shared_concepts — direct-import unit tests (#1106) ───────────────────
// These test the handler function directly (not via CDS service dispatch)
// to keep them fast and isolated from HANA/SPARQL infrastructure.
describe('kg_shared_concepts', () => {
  it('returns concept overlap of two tutorials, deduped by conceptSlug', async () => {
    // Fake service: neighborhood(slug_a) teaches concepts [c1,c2]; slug_b teaches [c2,c3].
    const srv = {
      send: vi.fn(async (_evt, { slug }) => ({
        teaches: slug === 'a'
          ? [{ slug: 'c1', title: 'C1', score: 0.9 }, { slug: 'c2', title: 'C2', score: 0.8 }]
          : [{ slug: 'c2', title: 'C2', score: 0.7 }, { slug: 'c3', title: 'C3', score: 0.6 }],
      })),
    };
    const req = { data: { slug_a: 'A', slug_b: 'B' }, srv };
    const out = await handleSharedConcepts.call(srv, req);
    expect(out).toEqual([{ conceptSlug: 'c2', name: 'C2' }]);
  });

  it('fail-open: returns [] when neighborhood throws, no error echo', async () => {
    const srv = { send: vi.fn(async () => { throw new Error('boom'); }) };
    const req = { data: { slug_a: 'A', slug_b: 'B' }, srv };
    const out = await handleSharedConcepts.call(srv, req);
    expect(out).toEqual([]);
  });

  it('returns [] when either slug missing', async () => {
    const srv = { send: vi.fn() };
    expect(await handleSharedConcepts.call(srv, { data: { slug_a: 'A' }, srv })).toEqual([]);
    expect(srv.send).not.toHaveBeenCalled();
  });
});

// ─── kg_neighborhood — direct-import unit tests (#1106) ──────────────────────
// handleNeighborhood calls this.send('neighborhood', {slug}) — NOT 'neighborhoodFull'.
// The mock must reflect the real neighborhood action's return shape:
//   tutorial-arm items: {slug, title, weight, reason}  (title from enrichLiveTutorials)
//   teaches items:      {slug, name, description, published}  (concepts, no title)
// This test verifies that the handler sources teaches from neighborhood correctly.
describe('kg_neighborhood', () => {
  // Reflect REAL neighborhood action return shape (not neighborhoodFull):
  // - tutorial arms carry {slug, title, weight, reason} (title populated by enrichLiveTutorials)
  // - teaches arm carries concept items {slug, name, description, published}
  const neighborhoodResult = {
    prerequisitesOf: [{ slug: 'p1', title: 'P1', weight: 0.9, reason: 'teaches a prerequisite concept', isolated: false }],
    whatToLearnNext: [{ slug: 'n1', title: 'N1', weight: 0.8, reason: 'next step' }],
    sharedConcepts:  [{ slug: 's1', title: 'S1', weight: 0.7, reason: 'shares concepts', isolated: true }],
    teaches:         [{ slug: 'c1', name: 'Concept One', description: '', published: true }],
  };

  it('projects all four arms including teaches, with isolated defaulted to false', async () => {
    const srv = { send: vi.fn(async () => neighborhoodResult) };
    const out = await handleNeighborhood.call(srv, { data: { slug: 'Foo', depth: 5 } });
    expect(srv.send).toHaveBeenCalledWith('neighborhood', { slug: 'foo' });
    // tutorial arms: title from item.title, score from item.weight
    expect(out.prerequisites[0]).toEqual({ slug: 'p1', title: 'P1', score: 0.9, isolated: false });
    expect(out.sharedConcepts[0].isolated).toBe(true);
    expect(out.whatToLearnNext[0].isolated).toBe(false); // defaulted
    // teaches arm: title falls back to item.name (concept item has no title), score from weight (undefined → 0)
    expect(out.teaches[0]).toEqual({ slug: 'c1', title: 'Concept One', score: 0, isolated: false });
  });

  it('clamps depth to [1,50] and slices each arm', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ slug: `p${i}`, title: `P${i}`, weight: 1 }));
    const srv = { send: vi.fn(async () => ({ ...neighborhoodResult, prerequisitesOf: many })) };
    const out = await handleNeighborhood.call(srv, { data: { slug: 'foo', depth: 999 } });
    expect(out.prerequisites).toHaveLength(50);
  });

  it('fail-open: empty arms when neighborhood throws', async () => {
    const srv = { send: vi.fn(async () => { throw new Error('x'); }) };
    const out = await handleNeighborhood.call(srv, { data: { slug: 'foo' } });
    expect(out).toEqual({ prerequisites: [], whatToLearnNext: [], sharedConcepts: [], teaches: [] });
  });
});

// ─── kg_search_concepts — direct-import unit tests (#1106) ───────────────────
describe('kg_search_concepts', () => {
  it('delegates to searchKG with clamped maxes and maps query->term', async () => {
    const srv = { send: vi.fn(async (_e, a) => ({
      concepts: [{ slug: 'c', name: 'C', score: 1 }], tutorials: [{ slug: 't', title: 'T', score: 1 }],
      _echo: a,
    })) };
    const out = await handleSearchConcepts.call(srv, { data: { query: 'draft', maxConcepts: 999, maxTutorials: 3 } });
    expect(srv.send).toHaveBeenCalledWith('searchKG', { term: 'draft', maxConcepts: 25, maxTutorials: 3 });
    expect(out.concepts[0].slug).toBe('c');
  });

  it('fail-open: {concepts:[],tutorials:[]} on throw', async () => {
    const srv = { send: vi.fn(async () => { throw new Error('x'); }) };
    expect(await handleSearchConcepts.call(srv, { data: { query: 'q' } }))
      .toEqual({ concepts: [], tutorials: [] });
  });

  it('returns empty when query blank', async () => {
    const srv = { send: vi.fn() };
    expect(await handleSearchConcepts.call(srv, { data: { query: '  ' } }))
      .toEqual({ concepts: [], tutorials: [] });
    expect(srv.send).not.toHaveBeenCalled();
  });
});

// ─── kg_community — direct-import unit tests (#1106 Task 4) ──────────────────
// Tests handleCommunity directly (not via CDS dispatch) to stay fast/isolated.
// Real columns: KgCommunity.{slug, vertexType, communityFingerprint},
//               KgCommunityLabel.{communityFingerprint, label},
//               Missions.{slug, sourceKgCommunityFingerprint}.
// The tool's `id` argument is the community FINGERPRINT (stable SHA-256),
// NOT the volatile Louvain communityId.
describe('kg_community', () => {
  // Fake db whose run() dispatches by inspecting the compiled query's entity name.
  function fakeDb(map) {
    return {
      run: vi.fn(async (q) => {
        const ref = q?.SELECT?.from?.ref?.[0];
        const name = (typeof ref === 'object' ? ref?.id : ref) ?? '';
        const key = String(name).split('.').pop();
        const rows = map[key] ?? [];
        return q?.SELECT?.one ? (rows[0] ?? null) : rows;
      }),
    };
  }

  it('returns label, members by slug, size and promotion status by fingerprint', async () => {
    const db = fakeDb({
      KgCommunity:      [
        { slug: 'a', vertexType: 'tutorial', communityFingerprint: 'fp1' },
        { slug: 'b', vertexType: 'tutorial', communityFingerprint: 'fp1' },
      ],
      KgCommunityLabel: [{ label: 'Draft Handling', communityFingerprint: 'fp1' }],
      Missions:         [{ slug: 'draft-mission' }],
    });
    const out = await handleCommunity.call({}, { data: { id: 'fp1' }, _db: db });
    expect(out.label).toBe('Draft Handling');
    expect(out.size).toBe(2);
    expect(out.memberTutorials.map((m) => m.slug)).toEqual(['a', 'b']);
    // slug-as-title: title equals slug (no title column in schema)
    expect(out.memberTutorials[0].title).toBe('a');
    expect(out.promotedToMissionSlug).toBe('draft-mission');
    expect(out.communityId).toBe('fp1');
  });

  it('returns empty shell for unknown fingerprint (no throw)', async () => {
    const db = fakeDb({});
    const out = await handleCommunity.call({}, { data: { id: 'nope' }, _db: db });
    expect(out.memberTutorials).toEqual([]);
    expect(out.size).toBe(0);
    expect(out.promotedToMissionSlug).toBeNull();
    expect(out.label).toBeNull();
    expect(out.communityId).toBe('nope');
  });

  it('returns empty shell for blank id without calling db', async () => {
    const db = fakeDb({});
    const out = await handleCommunity.call({}, { data: { id: '' }, _db: db });
    expect(out.memberTutorials).toEqual([]);
    expect(out.size).toBe(0);
    expect(db.run).not.toHaveBeenCalled();
  });

  it('fail-open: returns shell without echoing error message on db throw', async () => {
    const SECRET = 'SENSITIVE-internal-table-name';
    const db = { run: vi.fn(async () => { throw new Error(SECRET); }) };
    const out = await handleCommunity.call({}, { data: { id: 'fp-err' }, _db: db });
    expect(out.memberTutorials).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});
