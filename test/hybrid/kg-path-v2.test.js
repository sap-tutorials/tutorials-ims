// test/hybrid/kg-path-v2.test.js
// End-to-end hybrid test — seeds a small subgraph in the LIVE DEV HDI,
// exercises KG_PATH_V2 via the JS wrapper, then cleans up.
//
// SAFETY
//   - All fixtures use TEST_PREFIX `__TEST__kg-path-v2-`. The afterAll
//     cleans up via LOWER(slug) LIKE. Gated by ALLOW_HYBRID_WRITES via
//     ./_guard.js::isSafeForWrites().
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec --profile hybrid -- \
//     npx vitest run --project hybrid test/hybrid/kg-path-v2.test.js
//
// EXPECTED LIFECYCLE (spike Path C — first-deploy-is-the-probe)
//   Task 3 shipped `db/src/procedures/KG_PATH_V2.hdbprocedure` with a
//   PLACEHOLDER body that returns an empty result set from DUMMY. The
//   `SHORTEST_PATH` call is iterated by the maintainer AFTER Task 7's
//   first deploy proves the KG_PG_WORKSPACE declaration compiles.
//
//   Consequently, the "chained tutorials should find a path" assertion
//   would fail against the placeholder body — that's a false red, not
//   a real regression. To keep the test forward-compatible in place,
//   the assertion that requires a non-empty path result is gated on
//   the env var KG_PATH_V2_BODY_IMPLEMENTED=true (Option A per Task 6
//   context brief). The maintainer flips this env var (in CI + the
//   local `npm run test:hybrid` invocation) once the real SHORTEST_PATH
//   body lands, and the additional assertions activate — no second PR
//   needed.
//
//   Tests that ARE runnable against the placeholder body (and thus not
//   .skipIf-gated) still exercise:
//     1. The DB round-trip works — kgPathV2 doesn't throw against a
//        real HANA + procedure.
//     2. IRI validation propagates from the procedure body — a
//        raw DB call with a malformed IRI SIGNALs SQL_ERROR_CODE 10006.
//     3. Empty result on island tutorial — placeholder always returns
//        empty, so this assertion is a no-op against the placeholder
//        but still verifies wrapper coercion + sort of an empty set.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { kgPathV2 } from '../../srv/lib/kg-path-v2-client.js';

// Forward-compat gate: flip once the real SHORTEST_PATH body lands.
const BODY_IMPLEMENTED = process.env.KG_PATH_V2_BODY_IMPLEMENTED === 'true';

const TEST_PREFIX = `__TEST__kg-path-v2-`;
const RUN_ID = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// 4 concepts chained by kg:requires: c0 → c1 → c2 → c3
const C = Array.from({ length: 4 }, (_, i) => `${TEST_PREFIX}${RUN_ID}-c${i}`);

// 4 tutorials:
//   t-from   teaches c0 (chain endpoint)
//   t-mid    teaches c1 (bridge)
//   t-to     teaches c3 (chain endpoint)
//   t-island teaches nothing that connects to the chain
const T_FROM   = `${TEST_PREFIX}${RUN_ID}-t-from`;
const T_MID    = `${TEST_PREFIX}${RUN_ID}-t-mid`;
const T_TO     = `${TEST_PREFIX}${RUN_ID}-t-to`;
const T_ISLAND = `${TEST_PREFIX}${RUN_ID}-t-island`;

describe('KG_PATH_V2 end-to-end (issue #913, spike Path C)', () => {
  let db;

  beforeAll(async () => {
    if (!isSafeForWrites()) {
      throw new Error(
        'kg-path-v2.test.js: write-safety guard rejected — refusing to seed. ' +
        'Ensure ALLOW_HYBRID_WRITES=true and CF target is a non-prod space.'
      );
    }
    process.env.ALLOW_HYBRID_WRITES = 'true';

    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'kg-path-v2.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }

    const { Concepts, ConceptEdges, Tutorials, TutorialConceptLinks } =
      cds.entities('com.sap.developers.ims');

    // ---- Seed 4 concepts (all ACTIVE — required by KG_PG_EDGES_V) ----
    await INSERT.into(Concepts).entries([
      { slug: C[0], name: `Test ${C[0]}`, status: 'ACTIVE' },
      { slug: C[1], name: `Test ${C[1]}`, status: 'ACTIVE' },
      { slug: C[2], name: `Test ${C[2]}`, status: 'ACTIVE' },
      { slug: C[3], name: `Test ${C[3]}`, status: 'ACTIVE' },
    ]);

    // ---- Seed 4 tutorials ----
    await INSERT.into(Tutorials).entries([
      { slug: T_FROM,   title: `Test ${T_FROM}` },
      { slug: T_MID,    title: `Test ${T_MID}` },
      { slug: T_TO,     title: `Test ${T_TO}` },
      { slug: T_ISLAND, title: `Test ${T_ISLAND}` },
    ]);

    // ---- Look up IDs for FK linkage ----
    const conRows = await SELECT.from(Concepts)
      .columns('ID', 'slug')
      .where({ slug: { in: C } });
    const conId = Object.fromEntries(conRows.map((r) => [r.slug, r.ID]));

    const tutRows = await SELECT.from(Tutorials)
      .columns('ID', 'slug')
      .where({ slug: { in: [T_FROM, T_MID, T_TO, T_ISLAND] } });
    const tutId = Object.fromEntries(tutRows.map((r) => [r.slug, r.ID]));

    // ---- Seed the 3 requires edges (c0 ← c1 ← c2 ← c3) ----
    //
    // KG_PG_EDGES_V projects `requires` edges as concept→concept with
    // SOURCE = 'concept:' || src.SLUG and TARGET = 'concept:' || tgt.SLUG.
    // A shortest path from tutorial:t-from to tutorial:t-to therefore
    // walks along `requires` edges from the concept that t-from teaches
    // (c0) to the concept t-to teaches (c3). We seed the edges as
    // c1→c0, c2→c1, c3→c2 (source :requires target) so the graph engine
    // has an undirected traversal candidate; SHORTEST_PATH's direction
    // handling is up to the procedure body, and the test asserts only on
    // endpoint keys + minimum hop count, not on internal orientation.
    await INSERT.into(ConceptEdges).entries([
      { source_ID: conId[C[1]], target_ID: conId[C[0]], predicate: 'requires', status: 'ACTIVE', confidence: 0.9 },
      { source_ID: conId[C[2]], target_ID: conId[C[1]], predicate: 'requires', status: 'ACTIVE', confidence: 0.9 },
      { source_ID: conId[C[3]], target_ID: conId[C[2]], predicate: 'requires', status: 'ACTIVE', confidence: 0.9 },
    ]);

    // ---- Seed teaches links ----
    // t-from → c0, t-mid → c1, t-to → c3
    // t-island intentionally teaches NO chained concept — it has no
    // outgoing edges in KG_PG_EDGES_V, so any path from t-island to t-to
    // must return zero rows (graph engine can't leave the island vertex).
    await INSERT.into(TutorialConceptLinks).entries([
      { tutorial_ID: tutId[T_FROM], concept_ID: conId[C[0]], predicate: 'teaches', confidence: 0.9 },
      { tutorial_ID: tutId[T_MID],  concept_ID: conId[C[1]], predicate: 'teaches', confidence: 0.9 },
      { tutorial_ID: tutId[T_TO],   concept_ID: conId[C[3]], predicate: 'teaches', confidence: 0.9 },
    ]);
  }, 120_000);

  afterAll(async () => {
    if (!db) return;

    // Cleanup order matters — FK dependencies:
    //   TutorialConceptLinks references Tutorials and Concepts
    //   ConceptEdges references Concepts (source/target)
    //   → delete links first, then edges, then Tutorials + Concepts.
    // Uppercase HANA table + column names, LOWER() the slug for
    // case-insensitive match (mirrors kg-named-queries.test.js).
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS"
       WHERE TUTORIAL_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
                              WHERE LOWER("SLUG") LIKE '__test__kg-path-v2-%')
          OR CONCEPT_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
                             WHERE LOWER("SLUG") LIKE '__test__kg-path-v2-%')
    `);
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES"
       WHERE SOURCE_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
                            WHERE LOWER("SLUG") LIKE '__test__kg-path-v2-%')
          OR TARGET_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
                            WHERE LOWER("SLUG") LIKE '__test__kg-path-v2-%')
    `);
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
       WHERE LOWER("SLUG") LIKE '__test__kg-path-v2-%'
    `);
    await db.run(`
      DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
       WHERE LOWER("SLUG") LIKE '__test__kg-path-v2-%'
    `);
  }, 60_000);

  // ── Tests runnable against the PLACEHOLDER procedure body ────────
  // These pass whether or not the SHORTEST_PATH body has been iterated,
  // because they only exercise the round-trip / signature / validation.

  it('DB round-trip: kgPathV2 does not throw against a real HANA workspace', async () => {
    const paths = await kgPathV2({
      fromIri: `https://developers.sap.com/kg/tutorial/${T_FROM}`,
      toIri:   `https://developers.sap.com/kg/tutorial/${T_TO}`,
    });
    // Placeholder body returns []; real body returns >0. Both are acceptable
    // for a smoke test — the point is the CALL statement completes without
    // erroring on wrong signatures, missing workspace, or driver quirks.
    expect(Array.isArray(paths)).toBe(true);
  });

  it('returns empty for the island tutorial (no outgoing edges)', async () => {
    // The island tutorial has no teaches links, so KG_PG_EDGES_V emits no
    // outgoing edge from `tutorial:${T_ISLAND}`. Whether the procedure body
    // is the placeholder (always empty) or the real SHORTEST_PATH (empty
    // because the vertex is disconnected), the result is the same: [].
    const paths = await kgPathV2({
      fromIri: `https://developers.sap.com/kg/tutorial/${T_ISLAND}`,
      toIri:   `https://developers.sap.com/kg/tutorial/${T_TO}`,
    });
    expect(paths).toEqual([]);
  });

  it('procedure-level IRI validation fires on malformed input', async () => {
    // Bypass the JS-side regex in kgPathV2 (which would otherwise reject
    // the bad IRI before hitting the DB) by calling the procedure directly
    // through a DO-block. This proves the procedure body's LIKE_REGEXPR
    // guard is wired up correctly — a defense-in-depth check the JS
    // wrapper's unit tests can't cover.
    await expect(
      db.run(
        `DO (IN f NVARCHAR(500) => ?, IN t NVARCHAR(500) => ?, IN m INTEGER => ?) BEGIN
           DECLARE paths TABLE (path_rank INTEGER, hop_count INTEGER, vertex_seq NVARCHAR(500), seq_index INTEGER);
           CALL KG_PATH_V2(:f, :t, :m, :paths);
           SELECT * FROM :paths;
         END`,
        ['not-an-iri', `https://developers.sap.com/kg/tutorial/${T_TO}`, 8]
      )
    ).rejects.toThrow(/10006|KG_INVALID/i);
  });

  // ── Tests gated on the real SHORTEST_PATH body ────────────────────
  // Activate by setting KG_PATH_V2_BODY_IMPLEMENTED=true in the env
  // once the maintainer iterates the procedure body past its placeholder
  // (spec Path C, after Task 7 first-deploy proves the workspace).

  it.skipIf(!BODY_IMPLEMENTED)(
    'finds a prereq path between two chained tutorials',
    async () => {
      const paths = await kgPathV2({
        fromIri: `https://developers.sap.com/kg/tutorial/${T_FROM}`,
        toIri:   `https://developers.sap.com/kg/tutorial/${T_TO}`,
      });
      expect(paths.length).toBeGreaterThan(0);

      // The chain has 3 concepts between the two tutorial endpoints
      // (c0, c1, c2, c3 plus the two tutorial endpoints), so a valid
      // shortest path traverses at least 1 edge. Exact hop count depends
      // on the SHORTEST_PATH variant chosen (undirected vs directed) —
      // pin only the lower bound and the endpoint keys.
      const p = paths[0];
      expect(p.hopCount).toBeGreaterThanOrEqual(1);
      expect(p.vertices[0]).toBe(`tutorial:${T_FROM}`);
      expect(p.vertices[p.vertices.length - 1]).toBe(`tutorial:${T_TO}`);

      // Wrapper's interior-vertex guard: everything between the two
      // tutorial endpoints must be `concept:*`. This is enforced in
      // kg-path-v2-client.js; if the workspace ever regresses and
      // returns a tutorial as an interior vertex, the wrapper filters
      // that path out — and paths.length === 0 becomes the signal.
      const interior = p.vertices.slice(1, -1);
      for (const v of interior) {
        expect(v.startsWith('concept:')).toBe(true);
      }
    }
  );
});
