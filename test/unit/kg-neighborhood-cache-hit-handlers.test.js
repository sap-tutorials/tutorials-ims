// test/unit/kg-neighborhood-cache-hit-handlers.test.js
//
// Cache-hit early-return regression test for the /graph/neighborhood and
// /graph/neighborhoodFull handlers. Follow-up to #865: the final code review
// on #861 noted no test asserts the handler's cache-hit short-circuit path.
//
// Strategy
//   Rather than mocking `getCachedNeighborhood` — which would require an
//   ESM interceptor that vi.mock doesn't reliably win against `cds.test`'s
//   `cds.utils._import` (see the pathBetween test-injection note in
//   srv/knowledge-graph-service.js ~line 933) — this test uses the cache
//   module's own public API to prime the LRU with a distinguishable
//   sentinel object. The handler either:
//     (a) short-circuits at `getCachedNeighborhood(slug, gv, bucket)` and
//         returns our sentinel (test passes → cache is wired correctly), or
//     (b) proceeds to `loadOtherResourcesByType` / rank / etc. and returns
//         a real envelope (test fails → cache short-circuit is broken).
//
//   This proves the cache is actually consulted BEFORE the downstream
//   DB work. If a future refactor accidentally moves the cache lookup
//   below any of the SELECTs, this test flips red.
//
// Module-import discipline (Windows ESM hazard)
//   cds.test('serve') resolves srv/knowledge-graph-service.js via
//   `cds.utils._import` (a dynamic file:// URL wrapper). A plain
//   `import '../../srv/lib/kg-neighborhood-cache.js'` from the test
//   file can resolve to a DIFFERENT module instance on Windows (the
//   `file:///` vs `/`-prefixed URL disagreement documented in
//   test/unit/srv/kg-path-v2-handler-flag.test.js). To share state
//   with the handler, we load the cache module via cds.utils._import
//   too — same URL, same instance.
//
// The unit tests in test/unit/kg-neighborhood-cache.test.js already cover
// the cache module in isolation (get/set/bust/TTL/LRU/bucket isolation);
// this suite is specifically about the HANDLER's short-circuit behaviour.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { join } from 'node:path';
import cds from '@sap/cds';

// Feature-flag: KnowledgeGraphService rejects with 503 unless enabled.
// Must be set BEFORE cds.test() boots the service.
process.env.KNOWLEDGE_GRAPH_ENABLED = 'true';

const project = cds.test('serve', '--project', '.', '--in-memory');

// Any RFC-4122 UUID — we just need a stable value for the metadata row.
const TEST_GRAPH_VERSION = '11111111-1111-1111-1111-111111111111';
const GRAPH_METADATA_SINGLETON_ID = '00000000-0000-0000-0000-000000000001';
const SLUG = 'cache-hit-test-tutorial';

// Loaded via cds.utils._import in beforeAll so we share the exact module
// instance the service handler holds a reference to. See the block
// comment at top for why plain ESM import doesn't work here on Windows.
let cache;

beforeAll(async () => {
  const cachePath = join(process.cwd(), 'srv/lib/kg-neighborhood-cache.js');
  cache = await cds.utils._import(cachePath);

  const db = await cds.connect.to('db');
  const { GraphMetadata, Tutorials } = cds.entities('com.sap.developers.ims');

  // Ensure a graphVersion exists — the handler's null-check for a fresh
  // consolidator returns an empty envelope BEFORE the cache lookup and
  // that would defeat the test.
  await db.run(DELETE.from(GraphMetadata).where({ ID: GRAPH_METADATA_SINGLETON_ID }));
  await db.run(INSERT.into(GraphMetadata).entries([{
    ID: GRAPH_METADATA_SINGLETON_ID,
    graphVersion: TEST_GRAPH_VERSION,
    tripleCount: 1,
  }]));

  // Provide a Tutorials row so the handler's title lookup succeeds
  // (harmless when the cache short-circuits, but keeps the compute-path
  // fallback graceful if a future refactor of the handler order breaks
  // this test — the failure mode is then diagnostic, not opaque).
  await db.run(DELETE.from(Tutorials).where({ slug: SLUG }));
  await db.run(INSERT.into(Tutorials).entries([{
    slug: SLUG,
    title: 'Cache Hit Test Tutorial',
  }]));
});

beforeEach(() => {
  cache.bustNeighborhoodCache();
});

describe('neighborhood cache-hit short-circuit', () => {
  it('handler returns the pre-seeded default-bucket value verbatim on GET /graph/neighborhood', async () => {
    // Sentinel envelope — deliberately shaped like a real
    // NeighborhoodResult but with a unique tag we can grep on the wire.
    // If the handler bypassed the cache and computed a fresh response,
    // `_cacheSentinel` would be absent.
    const sentinel = {
      tutorial: { slug: SLUG, title: 'FROM CACHE' },
      graphVersion: TEST_GRAPH_VERSION,
      teaches: [],
      prerequisitesOf: [],
      sharedConcepts: [],
      whatToLearnNext: [],
      otherResources: [],
      typeConfig: [],
      _cacheSentinel: 'neighborhood-cache-hit-marker',
    };
    cache.setCachedNeighborhood(SLUG, TEST_GRAPH_VERSION, sentinel);

    // Sanity — the cache is populated for the (slug, gv, 'default') bucket.
    expect(cache.getCachedNeighborhood(SLUG, TEST_GRAPH_VERSION)).toBe(sentinel);

    const res = await project.get(`/graph/neighborhood(slug='${SLUG}')`);
    expect(res.status).toBe(200);
    // If short-circuit works, the response body IS the sentinel — proving
    // loadOtherResourcesByType / rank / SPARQL round-trip were all skipped.
    expect(res.data._cacheSentinel).toBe('neighborhood-cache-hit-marker');
    expect(res.data.tutorial.title).toBe('FROM CACHE');
  });

  it('handler returns the pre-seeded FULL-bucket value verbatim on GET /graph/neighborhoodFull', async () => {
    // Same idea, different cache bucket. The `full` bucket keys are
    // prefixed distinctly (see _makeKey in kg-neighborhood-cache.js) so
    // this can't collide with the sidebar-bucket sentinel in the prior test.
    const sentinel = {
      tutorial: { slug: SLUG, title: 'FROM FULL CACHE' },
      graphVersion: TEST_GRAPH_VERSION,
      prerequisitesOf: [],
      sharedConcepts: [],
      whatToLearnNext: [],
      otherResourcesByType: [],
      typeConfig: [],
      _cacheSentinel: 'neighborhood-full-cache-hit-marker',
    };
    cache.setCachedNeighborhood(SLUG, TEST_GRAPH_VERSION, sentinel, 'full');

    expect(cache.getCachedNeighborhood(SLUG, TEST_GRAPH_VERSION, 'full')).toBe(sentinel);

    const res = await project.get(`/graph/neighborhoodFull(slug='${SLUG}')`);
    expect(res.status).toBe(200);
    expect(res.data._cacheSentinel).toBe('neighborhood-full-cache-hit-marker');
    expect(res.data.tutorial.title).toBe('FROM FULL CACHE');
  });

  it('the two handlers key into distinct cache buckets (cross-bucket sentinels do not leak)', async () => {
    // Guards against a hypothetical refactor that keys both handlers off
    // the same bucket. Prime BOTH buckets with distinguishable sentinels
    // and verify each handler returns its OWN bucket's payload — not
    // the other's. This proves the bucket parameter on the handler-side
    // cache calls (see srv/knowledge-graph-service.js — `getCachedNeighborhood
    // (slug, graphVersion)` in the sidebar path vs
    // `getCachedNeighborhood(slug, graphVersion, 'full')` in the expanded
    // path) is wired to the correct bucket string.
    //
    // Doing this in ONE test rather than two isolated ones avoids the
    // SQLite cache-miss fall-through (kgQuery is HANA-only) that would
    // reach mapSparqlError on the compute path.
    const sidebarSentinel = {
      tutorial: { slug: SLUG, title: 'SIDEBAR CACHE' },
      graphVersion: TEST_GRAPH_VERSION,
      teaches: [], prerequisitesOf: [], sharedConcepts: [],
      whatToLearnNext: [], otherResources: [], typeConfig: [],
      _cacheSentinel: 'sidebar-marker',
    };
    const fullSentinel = {
      tutorial: { slug: SLUG, title: 'FULL CACHE' },
      graphVersion: TEST_GRAPH_VERSION,
      prerequisitesOf: [], sharedConcepts: [], whatToLearnNext: [],
      otherResourcesByType: [], typeConfig: [],
      _cacheSentinel: 'full-marker',
    };
    cache.setCachedNeighborhood(SLUG, TEST_GRAPH_VERSION, sidebarSentinel /* default */);
    cache.setCachedNeighborhood(SLUG, TEST_GRAPH_VERSION, fullSentinel, 'full');

    const sidebarRes = await project.get(`/graph/neighborhood(slug='${SLUG}')`);
    expect(sidebarRes.status).toBe(200);
    expect(sidebarRes.data._cacheSentinel).toBe('sidebar-marker');

    const fullRes = await project.get(`/graph/neighborhoodFull(slug='${SLUG}')`);
    expect(fullRes.status).toBe(200);
    expect(fullRes.data._cacheSentinel).toBe('full-marker');
  });
});
