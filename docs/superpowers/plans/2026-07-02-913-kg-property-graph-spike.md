# KG Property Graph Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove `SHORTEST_PATH` from the HANA Property Graph Engine as a replacement for the PREREQ arm of `pathBetween`, feature-flagged and A/B'd against the current SPARQL UNION workaround, over a one-week spike.

**Architecture:** One new DEFINER procedure `KG_PATH_V2` calls `SHORTEST_PATH` over a view-based `KG_PG_WORKSPACE` (`KG_PG_VERTICES_V` + `KG_PG_EDGES_V` over existing CDS tables). One new JS wrapper `srv/lib/kg-path-v2-client.js` calls the procedure via a DO-block (mirroring `kg-sparql-client.js`'s convention). The `pathBetween` handler in `srv/knowledge-graph-service.js` reads env flag `KG_PATH_V2_ENABLED` and fails open to v1 on any v2 error.

**Tech Stack:** HANA Cloud (property-graph engine, KGE, HDI), SAP CAP (Node.js), Vitest (unit + hybrid workspaces), CF (Cloud Foundry env-var-based flag).

**Design spec:** [`docs/superpowers/specs/2026-07-02-913-kg-property-graph-spike-design.md`](../specs/2026-07-02-913-kg-property-graph-spike-design.md)

**Related issues:** [#913](https://github.com/sap-tutorials/tutorials-ims/issues/913) (this spike), [#916](https://github.com/sap-tutorials/tutorials-ims/issues/916) [#917](https://github.com/sap-tutorials/tutorials-ims/issues/917) [#918](https://github.com/sap-tutorials/tutorials-ims/issues/918) [#919](https://github.com/sap-tutorials/tutorials-ims/issues/919) (post-gate follow-ons).

---

## File Structure

**New files (all under `db/src/`):**

- `db/src/procedures/KG_PATH_V2.hdbprocedure` — DEFINER procedure, validates IRIs, calls `SHORTEST_PATH`.
- `db/src/graph/KG_PG_WORKSPACE.hdbgraphworkspace` — workspace declaration binding vertex and edge views.
- `db/src/views/KG_PG_VERTICES_V.hdbview` — vertex view (concepts + tutorials).
- `db/src/views/KG_PG_EDGES_V.hdbview` — edge view (`requires` + `teaches`).
- `db-qa/src/procedures/KG_PATH_V2.hdbprocedure` — QA-channel stub that only signals `KG_NOT_AVAILABLE_ON_QA`.

**New files under `srv/lib/` and tests:**

- `srv/lib/kg-path-v2-client.js` — JS wrapper.
- `test/unit/kg-path-v2-client.test.js` — pure-JS wrapper unit tests.
- `test/unit/srv/kg-path-v2-handler-flag.test.js` — handler-level flag/fallback tests.
- `test/hybrid/kg-path-v2.test.js` — end-to-end fixture graph test against real HANA.
- `docs/superpowers/reviews/2026-07-DD-kg-property-graph-spike-review.md` — decision-gate artifact (template written now; numbers filled at end of week).

**Modified files:**

- `srv/knowledge-graph-service.js` — `pathBetween` handler gains a flag check + fail-open fallback + metric emission.
- `.deploy/mta.yaml` — add `db/src/graph/` + `db/src/views/` to db module HDI content if not already implicit.

**No changes to:**

- `srv/lib/kg-graph-rebuild.js` (rebuild path unchanged — workspace is view-based).
- `srv/lib/kg-sparql-client.js` (property-graph client is a separate module).
- `srv/lib/metrics.js` (uses existing counter/reservoir primitives from #805).

---

## Task 1: Spike-within-the-spike — probe live HANA for property-graph syntax

**Goal:** Before writing any HDI artifact, confirm four unknowns against the deployed DEV HANA instance. If any of these fail, the plan stalls on service-key rotation or entitlement escalation, not on code.

**Files:**
- Create: `docs/superpowers/reviews/2026-07-DD-kg-property-graph-spike-task1-notes.md` (scratch notes; not code)

**Prerequisites:**
- `hana-cli` installed and authenticated against the DEV HDI container (`hana-cli status` should return without error).
- `cf target` on the DEV space, and `cds bind` state populated for hybrid access.

### Step 1.1: Confirm runtime privilege for the property-graph engine

- [ ] Run `hana-cli status --priv` and grep the output for `GRAPH` or `GRAPH USAGE` privileges.
  - Expected: at least one row mentioning `GRAPH USAGE` on `SYS` or on the HDI schema.
  - If missing: STOP. File a ticket for HANA Cloud service-key privilege grant; the spike cannot proceed. Document the missing privilege in the Task 1 notes file.

### Step 1.2: Confirm exact HANA table names for CDS entities

- [ ] Run `hana-cli inspectTable --schema '**CURRENT_SCHEMA**' --table Concepts` and capture the fully qualified table name from the output.
  - Expected: a table named `com.sap.developers.ims.Concepts` (dots preserved) OR `com_sap_developers_ims_Concepts` (flattened) — either is possible depending on the HANA client's identifier quoting.
  - If the name uses dots, the view DDL in later tasks needs `"com.sap.developers.ims.Concepts"` (double-quoted). If it uses underscores, use `"com_sap_developers_ims_Concepts"`. Record the observed form in Task 1 notes.
- [ ] Repeat for `ConceptEdges`, `Tutorials`, `TutorialConceptLinks`. Confirm all four use the same naming convention.

### Step 1.3: Probe `SHORTEST_PATH` syntax with a hand-written GraphScript block

- [ ] Create a minimal throwaway workspace and vertex/edge tables directly via `hana-cli querySimple`. Use the `hana-cli` sandbox schema (not the HDI schema) so nothing pollutes real state:

```sql
-- Sandbox setup: 3 vertices, 2 edges, forming a path A → B → C.
CREATE COLUMN TABLE "T1_V" ("KEY" NVARCHAR(50) PRIMARY KEY, "NAME" NVARCHAR(100));
CREATE COLUMN TABLE "T1_E" ("SOURCE" NVARCHAR(50), "TARGET" NVARCHAR(50));
INSERT INTO "T1_V" VALUES ('a','Alpha'), ('b','Bravo'), ('c','Charlie');
INSERT INTO "T1_E" VALUES ('a','b'), ('b','c');

CREATE GRAPH WORKSPACE "T1_WS" EDGE TABLE "T1_E" SOURCE COLUMN "SOURCE" TARGET COLUMN "TARGET" VERTEX TABLE "T1_V" KEY COLUMN "KEY";
```

- [ ] Run a `SHORTEST_PATH` call against `T1_WS`. The QRC-2026-Q3 syntax is expected to be (verify — this is the placeholder Task 1 confirms):

```sql
DO BEGIN
  DECLARE result TABLE (source NVARCHAR(50), target NVARCHAR(50), weight DOUBLE);
  CREATE GRAPH WORKSPACE g_ws INSTANCE "T1_WS";
  result = MAP GRAPH SHORTEST_PATH(:g_ws, VERTEX v1 = VERTEX(:g_ws, 'a'), VERTEX v2 = VERTEX(:g_ws, 'c'));
  SELECT * FROM :result;
END;
```

  - Expected: 2 rows (edges a→b and b→c) OR one row per vertex hop, depending on API shape.
  - Capture the exact syntax that works. **This is the load-bearing evidence for the entire plan.**
  - If `SHORTEST_PATH` isn't callable this way, try variants: `PGQL` block (`SELECT ... MATCH SHORTEST ((v1)-[e*]->(v2)) ...`); or a `CREATE PROCEDURE ... LANGUAGE GRAPH` block; document what does work.

### Step 1.4: Probe `OUT param TABLE(...)` binding via `cds.db.run`

- [ ] From a `cds repl` session (`cds bind --exec -- cds repl`), attempt to call an existing procedure that returns a table result. If none exists, create a throwaway `SAY_HELLO` procedure inline:

```js
await cds.db.run(`DO BEGIN
  DECLARE result TABLE (msg NVARCHAR(50));
  result = SELECT 'hello' AS msg FROM DUMMY;
  SELECT * FROM :result;
END`);
```

  - Expected: `[{ MSG: 'hello' }]` (uppercase field names per HANA convention).
  - This confirms the DO-block-with-inline-SELECT pattern (already used by `kg-sparql-client.js`) also works for table-shaped results, not just scalar OUT params. Document the exact return shape in Task 1 notes.

### Step 1.5: Commit Task 1 notes

- [ ] Fill in `docs/superpowers/reviews/2026-07-DD-kg-property-graph-spike-task1-notes.md` with four sections:
  1. Privilege confirmation (Step 1.1 output).
  2. HANA table naming convention (dots or underscores) with a sample `SELECT COUNT(*)` from each of the 4 tables.
  3. Working `SHORTEST_PATH` call syntax (the exact SQL that returned rows).
  4. Table-OUT via DO-block confirmation (the exact block shape).

- [ ] Commit:

```bash
git add docs/superpowers/reviews/2026-07-DD-kg-property-graph-spike-task1-notes.md
git commit -m "docs(#913): Task 1 — HANA property-graph syntax probe notes"
```

**Gate:** if any of Steps 1.1–1.4 fails, DO NOT proceed to Task 2. The spike is blocked on either privilege escalation, a HANA syntax that materially differs from the spec's assumption, or a boundary that requires the global-temp-table fallback. In any case, update the spec's Risks section with what you learned and surface to the maintainer.

---

## Task 2: Create view definitions (`KG_PG_VERTICES_V`, `KG_PG_EDGES_V`)

**Depends on:** Task 1 complete, HANA table names confirmed.

**Files:**
- Create: `db/src/views/KG_PG_VERTICES_V.hdbview`
- Create: `db/src/views/KG_PG_EDGES_V.hdbview`

### Step 2.1: Author `KG_PG_VERTICES_V.hdbview`

- [ ] Create the file with the union of concept + tutorial vertex projections. Use the **exact table-name form confirmed in Task 1 Step 1.2**.

```sql
VIEW "KG_PG_VERTICES_V" AS
  -- Concept vertices — one row per active concept.
  SELECT
    CAST('concept:' || "slug" AS NVARCHAR(100)) AS "VERTEX_KEY",
    'concept'                                   AS "VERTEX_TYPE",
    "slug"                                      AS "SLUG",
    "name"                                      AS "LABEL",
    "status"                                    AS "STATUS"
  FROM "com.sap.developers.ims.Concepts"        -- Task 1: confirm the exact name
  WHERE "status" = 'ACTIVE'
  UNION ALL
  -- Tutorial vertices — synthesized from the link table because
  -- tutorials don't live in a KG-specific table.
  SELECT DISTINCT
    CAST('tutorial:' || t."slug" AS NVARCHAR(100)) AS "VERTEX_KEY",
    'tutorial'                                     AS "VERTEX_TYPE",
    t."slug"                                       AS "SLUG",
    t."title"                                      AS "LABEL",
    NULL                                           AS "STATUS"
  FROM "com.sap.developers.ims.TutorialConceptLinks" tcl
  JOIN "com.sap.developers.ims.Tutorials" t ON t."ID" = tcl."tutorial_ID";
```

**Note:** `.hdbview` files use `VIEW` (not `CREATE VIEW`) and are UNQUOTED-schema by convention — HDI resolves the schema at deploy time. If Task 1 confirmed underscore names, replace the double-quoted dotted names accordingly.

### Step 2.2: Author `KG_PG_EDGES_V.hdbview`

- [ ] Create the file with `requires` (concept→concept) and `teaches` (tutorial→concept) union:

```sql
VIEW "KG_PG_EDGES_V" AS
  -- kg:requires edges: concept → concept
  SELECT
    CAST('concept:' || src."slug" AS NVARCHAR(100)) AS "SOURCE",
    CAST('concept:' || tgt."slug" AS NVARCHAR(100)) AS "TARGET",
    'requires'                                      AS "EDGE_TYPE"
  FROM "com.sap.developers.ims.ConceptEdges" ce
  JOIN "com.sap.developers.ims.Concepts" src ON src."ID" = ce."source_ID"
  JOIN "com.sap.developers.ims.Concepts" tgt ON tgt."ID" = ce."target_ID"
  WHERE ce."predicate" = 'requires' AND ce."status" = 'ACTIVE'
    AND src."status" = 'ACTIVE' AND tgt."status" = 'ACTIVE'
  UNION ALL
  -- kg:teaches edges: tutorial → concept
  SELECT
    CAST('tutorial:' || t."slug" AS NVARCHAR(100)) AS "SOURCE",
    CAST('concept:'  || c."slug" AS NVARCHAR(100)) AS "TARGET",
    'teaches'                                      AS "EDGE_TYPE"
  FROM "com.sap.developers.ims.TutorialConceptLinks" tcl
  JOIN "com.sap.developers.ims.Tutorials" t ON t."ID" = tcl."tutorial_ID"
  JOIN "com.sap.developers.ims.Concepts"  c ON c."ID" = tcl."concept_ID"
  WHERE c."status" = 'ACTIVE';
```

### Step 2.3: Deploy views to DEV HDI via `cds deploy`

- [ ] From the worktree root:

```bash
cds build --production
cf target -s dev
cds deploy --to hana:tutorials-db --auto-undeploy
```

Expected: deploy succeeds; `hana-cli views | grep KG_PG` shows both views. If either fails compile, Task 1's table-name form was wrong — go back to Task 1 Step 1.2, correct, re-run Step 2.1/2.2.

### Step 2.4: Smoke-verify the views return rows

- [ ] Run:

```bash
hana-cli querySimple --query "SELECT VERTEX_TYPE, COUNT(*) AS n FROM \"KG_PG_VERTICES_V\" GROUP BY VERTEX_TYPE"
hana-cli querySimple --query "SELECT EDGE_TYPE, COUNT(*) AS n FROM \"KG_PG_EDGES_V\" GROUP BY EDGE_TYPE"
```

Expected: two rows in the vertex query (`concept: N`, `tutorial: M`), two rows in the edge query (`requires: N`, `teaches: M`). If any is zero, either the underlying tables are empty (unlikely in DEV) or the JOIN condition is wrong; fix before proceeding.

### Step 2.5: Commit

- [ ] `git add db/src/views/ && git commit -m "feat(#913): KG_PG_VERTICES_V + KG_PG_EDGES_V views for property-graph workspace"`

---

## Task 3: Create the property-graph workspace + procedure

**Depends on:** Task 2 deployed successfully, Task 1 Step 1.3 confirmed `SHORTEST_PATH` call syntax.

**Files:**
- Create: `db/src/graph/KG_PG_WORKSPACE.hdbgraphworkspace`
- Create: `db/src/procedures/KG_PATH_V2.hdbprocedure`
- Create: `db-qa/src/procedures/KG_PATH_V2.hdbprocedure` (QA stub)

### Step 3.1: Author the workspace declaration

- [ ] Create `db/src/graph/KG_PG_WORKSPACE.hdbgraphworkspace`:

```json
{
  "vertexTable":       "KG_PG_VERTICES_V",
  "vertexKeyColumn":   "VERTEX_KEY",
  "edgeTable":         "KG_PG_EDGES_V",
  "edgeSourceColumn":  "SOURCE",
  "edgeTargetColumn":  "TARGET",
  "edgeKeyColumn":     null
}
```

**Note:** the exact `.hdbgraphworkspace` JSON schema varies by HDI-plugin version — check the current tutorial-ims HDI setup (`cat .hdiconfig`) and confirm the property-graph plugin is enabled. If the schema differs, adjust the property names to match. This is a compile-time file, so `cds build` will fail loudly if the shape is wrong.

### Step 3.2: Author `KG_PATH_V2.hdbprocedure` — final body

- [ ] Create `db/src/procedures/KG_PATH_V2.hdbprocedure` using the **exact `SHORTEST_PATH` call syntax confirmed in Task 1 Step 1.3**. The scaffold below has the validation logic pinned; the `-- BODY --` block is where the Task 1 syntax slots in:

```sql
PROCEDURE KG_PATH_V2 (
  IN  from_iri  NVARCHAR(500),
  IN  to_iri    NVARCHAR(500),
  IN  max_hops  INTEGER,
  OUT paths     TABLE (
    path_rank   INTEGER,
    hop_count   INTEGER,
    vertex_seq  NVARCHAR(500),
    seq_index   INTEGER
  )
)
LANGUAGE SQLSCRIPT
SQL SECURITY DEFINER
AS
BEGIN
  DECLARE KG_INVALID_TUTORIAL_IRI CONDITION FOR SQL_ERROR_CODE 10006;
  DECLARE KG_MAX_HOPS_OUT_OF_RANGE CONDITION FOR SQL_ERROR_CODE 10008;

  DECLARE from_key NVARCHAR(500);
  DECLARE to_key   NVARCHAR(500);
  DECLARE effective_max_hops INTEGER;

  IF :from_iri IS NULL OR NOT (:from_iri LIKE_REGEXPR
       '^https://developers\.sap\.com/kg/tutorial/[a-z0-9-]{1,80}$') OR
     :to_iri IS NULL OR NOT (:to_iri LIKE_REGEXPR
       '^https://developers\.sap\.com/kg/tutorial/[a-z0-9-]{1,80}$') THEN
    SIGNAL KG_INVALID_TUTORIAL_IRI;
  END IF;

  effective_max_hops := COALESCE(:max_hops, 8);
  IF effective_max_hops < 1 OR effective_max_hops > 20 THEN
    SIGNAL KG_MAX_HOPS_OUT_OF_RANGE;
  END IF;

  from_key := 'tutorial:' ||
    SUBSTR(:from_iri, LENGTH('https://developers.sap.com/kg/tutorial/') + 1);
  to_key   := 'tutorial:' ||
    SUBSTR(:to_iri,   LENGTH('https://developers.sap.com/kg/tutorial/') + 1);

  -- BODY: SHORTEST_PATH call. See Task 1 notes for the exact syntax.
  -- Assemble result rows into :paths with columns (path_rank, hop_count,
  -- vertex_seq, seq_index). If the algorithm returns edges instead of
  -- vertices, expand to vertex_seq by joining against KG_PG_VERTICES_V.
  -- Empty result when no path exists — do NOT SIGNAL.
  paths = SELECT
            1 AS path_rank, 0 AS hop_count,
            :from_key AS vertex_seq, 0 AS seq_index
          FROM DUMMY WHERE 1 = 0;
END;
```

### Step 3.3: Author the QA stub

- [ ] Create `db-qa/src/procedures/KG_PATH_V2.hdbprocedure`:

```sql
PROCEDURE KG_PATH_V2 (
  IN  from_iri  NVARCHAR(500),
  IN  to_iri    NVARCHAR(500),
  IN  max_hops  INTEGER,
  OUT paths     TABLE (
    path_rank   INTEGER,
    hop_count   INTEGER,
    vertex_seq  NVARCHAR(500),
    seq_index   INTEGER
  )
)
LANGUAGE SQLSCRIPT
SQL SECURITY DEFINER
AS
BEGIN
  -- QA channel has no property-graph consumer. Body must NOT reference
  -- KG_PG_WORKSPACE / KG_PG_VERTICES_V / KG_PG_EDGES_V — those are not
  -- deployed to db-qa.
  DECLARE KG_NOT_AVAILABLE_ON_QA CONDITION FOR SQL_ERROR_CODE 10099;
  SIGNAL KG_NOT_AVAILABLE_ON_QA;
END;
```

### Step 3.4: Deploy to DEV and smoke-test

- [ ] `cds build --production && cds deploy --to hana:tutorials-db --auto-undeploy`
- [ ] Probe from `hana-cli`:

```bash
hana-cli querySimple --query "CALL \"KG_PATH_V2\"('https://developers.sap.com/kg/tutorial/<known-slug-a>', 'https://developers.sap.com/kg/tutorial/<known-slug-b>', 8, ?)"
```

Replace `<known-slug-a/b>` with two tutorial slugs known to be connected in the graph. Expected: zero or more rows returned. If a `SIGNAL 10006` fires, the IRI regex mismatched — check tutorial slugs.

### Step 3.5: Commit

- [ ] `git add db/src/graph/ db/src/procedures/ db-qa/src/procedures/ && git commit -m "feat(#913): KG_PATH_V2 procedure + KG_PG_WORKSPACE"`

---

## Task 4: JS wrapper (`srv/lib/kg-path-v2-client.js`) + unit tests

**Depends on:** Task 3 deployed. Task 1 Step 1.4 confirmed the DO-block-with-table shape (`cds.db.run` returns rows correctly).

**Files:**
- Create: `srv/lib/kg-path-v2-client.js`
- Create: `test/unit/kg-path-v2-client.test.js`

### Step 4.1: Write the failing unit tests (TDD red)

- [ ] Create `test/unit/kg-path-v2-client.test.js`:

```js
// test/unit/kg-path-v2-client.test.js
// Pure-JS unit tests for the KG_PATH_V2 wrapper. Uses vi.mock to stub
// cds.db.run — no DB required. Hybrid coverage lives in
// test/hybrid/kg-path-v2.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const runMock = vi.fn();
vi.mock('@sap/cds', () => ({
  default: { db: { run: (...args) => runMock(...args) } },
}));

// Import AFTER vi.mock so the mock is in place.
const { kgPathV2 } = await import('../../srv/lib/kg-path-v2-client.js');

beforeEach(() => { runMock.mockReset(); });

describe('kgPathV2 — input validation', () => {
  it('rejects http:// (must be https)', async () => {
    await expect(kgPathV2({
      fromIri: 'http://developers.sap.com/kg/tutorial/foo',
      toIri:   'https://developers.sap.com/kg/tutorial/bar',
    })).rejects.toMatchObject({ code: 10006 });
    expect(runMock).not.toHaveBeenCalled();
  });

  it('rejects uppercase in slug', async () => {
    await expect(kgPathV2({
      fromIri: 'https://developers.sap.com/kg/tutorial/Foo',
      toIri:   'https://developers.sap.com/kg/tutorial/bar',
    })).rejects.toMatchObject({ code: 10006 });
  });

  it('rejects slug longer than 80 chars', async () => {
    const long = 'a'.repeat(81);
    await expect(kgPathV2({
      fromIri: `https://developers.sap.com/kg/tutorial/${long}`,
      toIri:   'https://developers.sap.com/kg/tutorial/bar',
    })).rejects.toMatchObject({ code: 10006 });
  });

  it('rejects maxHops < 1', async () => {
    await expect(kgPathV2({
      fromIri: 'https://developers.sap.com/kg/tutorial/foo',
      toIri:   'https://developers.sap.com/kg/tutorial/bar',
      maxHops: 0,
    })).rejects.toMatchObject({ code: 10008 });
  });

  it('rejects maxHops > 20', async () => {
    await expect(kgPathV2({
      fromIri: 'https://developers.sap.com/kg/tutorial/foo',
      toIri:   'https://developers.sap.com/kg/tutorial/bar',
      maxHops: 21,
    })).rejects.toMatchObject({ code: 10008 });
  });
});

describe('kgPathV2 — row grouping', () => {
  it('groups flat rows by PATH_RANK, orders by SEQ_INDEX', async () => {
    // Two paths, each with 3 hops (4 vertices). Rows arrive out of order
    // to prove the grouper is robust to DB row ordering.
    runMock.mockResolvedValueOnce([
      { PATH_RANK: 2, HOP_COUNT: 1, VERTEX_SEQ: 'tutorial:x', SEQ_INDEX: 0 },
      { PATH_RANK: 1, HOP_COUNT: 3, VERTEX_SEQ: 'concept:c2', SEQ_INDEX: 2 },
      { PATH_RANK: 1, HOP_COUNT: 3, VERTEX_SEQ: 'tutorial:from', SEQ_INDEX: 0 },
      { PATH_RANK: 2, HOP_COUNT: 1, VERTEX_SEQ: 'tutorial:y', SEQ_INDEX: 1 },
      { PATH_RANK: 1, HOP_COUNT: 3, VERTEX_SEQ: 'concept:c1', SEQ_INDEX: 1 },
      { PATH_RANK: 1, HOP_COUNT: 3, VERTEX_SEQ: 'tutorial:to', SEQ_INDEX: 3 },
    ]);
    const out = await kgPathV2({
      fromIri: 'https://developers.sap.com/kg/tutorial/foo',
      toIri:   'https://developers.sap.com/kg/tutorial/bar',
    });
    // path_rank 2 has only 2 vertices — interior filter should drop it
    // (< 2 interior vertices means no valid concept chain; that path is
    // filtered as a defense-in-depth measure).
    // path_rank 1 has interior ['concept:c1','concept:c2'] — kept.
    expect(out).toEqual([
      {
        pathRank: 1,
        hopCount: 3,
        vertices: ['tutorial:from', 'concept:c1', 'concept:c2', 'tutorial:to'],
      },
    ]);
  });

  it('filters paths whose interior vertices are not concepts', async () => {
    // A path with a stray tutorial vertex in the middle — should be dropped
    // by the defense-in-depth filter.
    runMock.mockResolvedValueOnce([
      { PATH_RANK: 1, HOP_COUNT: 2, VERTEX_SEQ: 'tutorial:a', SEQ_INDEX: 0 },
      { PATH_RANK: 1, HOP_COUNT: 2, VERTEX_SEQ: 'tutorial:middle', SEQ_INDEX: 1 },
      { PATH_RANK: 1, HOP_COUNT: 2, VERTEX_SEQ: 'tutorial:b', SEQ_INDEX: 2 },
    ]);
    const out = await kgPathV2({
      fromIri: 'https://developers.sap.com/kg/tutorial/foo',
      toIri:   'https://developers.sap.com/kg/tutorial/bar',
    });
    expect(out).toEqual([]);
  });

  it('returns empty on no rows', async () => {
    runMock.mockResolvedValueOnce([]);
    const out = await kgPathV2({
      fromIri: 'https://developers.sap.com/kg/tutorial/foo',
      toIri:   'https://developers.sap.com/kg/tutorial/bar',
    });
    expect(out).toEqual([]);
  });
});
```

- [ ] Run: `npx vitest run --project unit test/unit/kg-path-v2-client.test.js`
- Expected: **all tests FAIL** with "Cannot find module '../../srv/lib/kg-path-v2-client.js'".

### Step 4.2: Implement `kg-path-v2-client.js` (green)

- [ ] Create `srv/lib/kg-path-v2-client.js` using a DO-block (matching `kg-sparql-client.js`'s pattern from [srv/lib/kg-sparql-client.js:80-107](../../../srv/lib/kg-sparql-client.js#L80-L107)) NOT `CALL "KG_PATH_V2"(?,?,?)` — the driver doesn't bind OUT params via CALL:

```js
// srv/lib/kg-path-v2-client.js
// Typed wrapper for the KG_PATH_V2 DEFINER procedure. Separate module from
// kg-sparql-client.js because this doesn't speak SPARQL — it calls the HANA
// property-graph engine via a stored procedure over the KG_PG_WORKSPACE
// view-based workspace.
//
// Contract:
//   kgPathV2({ fromIri, toIri, maxHops = 8 })
//     → Promise<Array<{ pathRank, hopCount, vertices: string[] }>>
//
// Error codes surfaced to callers via err.code:
//   10006  KG_INVALID_TUTORIAL_IRI   — IRI regex mismatch (pre-check + DB)
//   10008  KG_MAX_HOPS_OUT_OF_RANGE  — maxHops not in [1, 20]

import cds from '@sap/cds';

const IRI_RX = /^https:\/\/developers\.sap\.com\/kg\/tutorial\/[a-z0-9-]{1,80}$/;

// DO-block converts the OUT TABLE(...) param to a SELECT result-set. Matches
// the pattern in kg-sparql-client.js — @cap-js/hana does not bind OUT params
// via db.run('CALL …'), so DO-with-embedded-SELECT is the workaround.
const DO_KG_PATH_V2 = `DO (
  IN from_iri NVARCHAR(500) => ?,
  IN to_iri   NVARCHAR(500) => ?,
  IN max_hops INTEGER       => ?
) BEGIN
  DECLARE paths TABLE (
    path_rank   INTEGER,
    hop_count   INTEGER,
    vertex_seq  NVARCHAR(500),
    seq_index   INTEGER
  );
  CALL KG_PATH_V2(:from_iri, :to_iri, :max_hops, :paths);
  SELECT * FROM :paths;
END`;

export async function kgPathV2({ fromIri, toIri, maxHops = 8 }) {
  if (!IRI_RX.test(fromIri) || !IRI_RX.test(toIri)) {
    const err = new Error('KG_INVALID_TUTORIAL_IRI');
    err.code = 10006;
    throw err;
  }
  if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 20) {
    const err = new Error('KG_MAX_HOPS_OUT_OF_RANGE');
    err.code = 10008;
    throw err;
  }

  const rows = await cds.db.run(DO_KG_PATH_V2, [fromIri, toIri, maxHops]);
  // Coerce the DO-block result — @cap-js/hana wraps it as {changes: [{},[rows]]}
  // in production, but tests / other drivers return a plain array. Match the
  // shape defensively (mirrors coerceRow() in kg-sparql-client.js).
  const flat = Array.isArray(rows)
    ? (Array.isArray(rows[0]) ? rows[0] : rows)
    : (rows?.changes?.[1] ?? []);

  const byRank = new Map();
  for (const r of flat) {
    let bucket = byRank.get(r.PATH_RANK);
    if (!bucket) {
      bucket = { pathRank: r.PATH_RANK, hopCount: r.HOP_COUNT, vertices: [] };
      byRank.set(r.PATH_RANK, bucket);
    }
    bucket.vertices[r.SEQ_INDEX] = r.VERTEX_SEQ;
  }

  // Defense-in-depth: interior vertices must all be concepts (endpoints
  // are tutorials). Guards against a bad workspace refresh.
  const filtered = [...byRank.values()].filter(p => {
    if (p.vertices.length < 3) return false; // must have at least one interior
    const interior = p.vertices.slice(1, -1);
    return interior.every(v => typeof v === 'string' && v.startsWith('concept:'));
  });

  // Stable ordering — primary by path_rank, tie-break by joined vertex_seq.
  return filtered.sort((a, b) => {
    if (a.pathRank !== b.pathRank) return a.pathRank - b.pathRank;
    return a.vertices.join('|').localeCompare(b.vertices.join('|'));
  });
}
```

- [ ] Run: `npx vitest run --project unit test/unit/kg-path-v2-client.test.js`
- Expected: **all tests PASS**.

### Step 4.3: Commit

- [ ] `git add srv/lib/kg-path-v2-client.js test/unit/kg-path-v2-client.test.js && git commit -m "feat(#913): kg-path-v2-client JS wrapper + unit tests"`

---

## Task 5: Handler edit + metrics + handler-level unit test

**Depends on:** Task 4 complete.

**Files:**
- Modify: `srv/knowledge-graph-service.js` (existing `pathBetween` handler)
- Create: `test/unit/srv/kg-path-v2-handler-flag.test.js`

### Step 5.1: Locate the existing `pathBetween` handler

- [ ] Read `srv/knowledge-graph-service.js` and find the `srv.on('pathBetween', ...)` handler (also grep for `kgQuery.*PATH_BETWEEN`). Note the line numbers — the edit inserts a flag-check branch **before** the existing v1 body, not replacing it.

### Step 5.2: Write the failing handler-level test

- [ ] Create `test/unit/srv/kg-path-v2-handler-flag.test.js`:

```js
// test/unit/srv/kg-path-v2-handler-flag.test.js
// Handler-level flag-behavior tests. Mocks kgPathV2 + the existing v1 SPARQL
// call so we're only exercising the branching logic. In-memory SQLite; fast.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';

const kgPathV2Mock = vi.fn();
const v1Mock = vi.fn();
const warnMock = vi.fn();

vi.mock('../../../srv/lib/kg-path-v2-client.js', () => ({
  kgPathV2: (...args) => kgPathV2Mock(...args),
}));

// Stub the v1 SPARQL client call site. Adjust the mocked module path to
// match wherever pathBetween's v1 impl actually lives (grep for the
// PATH_BETWEEN name inside srv/lib/).
vi.mock('../../../srv/lib/kg-sparql-client.js', async () => {
  const actual = await vi.importActual('../../../srv/lib/kg-sparql-client.js');
  return { ...actual, kgQuery: (...args) => v1Mock(...args) };
});

// cds.log stub — captures warn calls so we can assert the fallback log line.
vi.spyOn(cds, 'log').mockReturnValue({
  warn: (...args) => warnMock(...args),
  info: () => {}, error: () => {}, debug: () => {},
});

// Load the service AFTER mocks are in place.
const { default: knowledgeGraphService } = await import(
  '../../../srv/knowledge-graph-service.js'
);

// Helper: invoke the pathBetween handler with a mock req.
function invoke({ fromSlug, toSlug }) {
  const srv = knowledgeGraphService;
  // Access the registered handler — the exact API depends on how the
  // service is exported. If the service module exports a factory,
  // instantiate it and pull `.handlers` off the resulting service.
  // Alternative: exercise via cds.test('.') with an OData request.
  return srv._runHandler('pathBetween', {
    data: { fromSlug, toSlug },
    warn: () => {},
  });
}

beforeEach(() => {
  kgPathV2Mock.mockReset();
  v1Mock.mockReset();
  warnMock.mockReset();
});

afterEach(() => {
  delete process.env.KG_PATH_V2_ENABLED;
});

describe('pathBetween handler — flag behavior', () => {
  it('flag off: v1 runs, v2 wrapper never called', async () => {
    delete process.env.KG_PATH_V2_ENABLED;
    v1Mock.mockResolvedValue({ response: JSON.stringify({ results: { bindings: [] } }) });
    await invoke({ fromSlug: 'a', toSlug: 'b' });
    expect(kgPathV2Mock).not.toHaveBeenCalled();
    expect(v1Mock).toHaveBeenCalledOnce();
  });

  it('flag on + v2 returns rows: v2-mapped response, v1 not called', async () => {
    process.env.KG_PATH_V2_ENABLED = 'true';
    kgPathV2Mock.mockResolvedValue([
      { pathRank: 1, hopCount: 2, vertices: ['tutorial:a', 'concept:c1', 'tutorial:b'] },
    ]);
    const out = await invoke({ fromSlug: 'a', toSlug: 'b' });
    expect(kgPathV2Mock).toHaveBeenCalledOnce();
    expect(v1Mock).not.toHaveBeenCalled();
    expect(out).toEqual(['a', 'b']);
  });

  it('flag on + v2 empty: falls through to v1', async () => {
    process.env.KG_PATH_V2_ENABLED = 'true';
    kgPathV2Mock.mockResolvedValue([]);
    v1Mock.mockResolvedValue({ response: JSON.stringify({ results: { bindings: [] } }) });
    await invoke({ fromSlug: 'a', toSlug: 'b' });
    expect(kgPathV2Mock).toHaveBeenCalledOnce();
    expect(v1Mock).toHaveBeenCalledOnce();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('flag on + v2 throws: falls through to v1 AND emits kg_path_v2_failed warn', async () => {
    process.env.KG_PATH_V2_ENABLED = 'true';
    const err = new Error('boom'); err.code = 42;
    kgPathV2Mock.mockRejectedValue(err);
    v1Mock.mockResolvedValue({ response: JSON.stringify({ results: { bindings: [] } }) });
    await invoke({ fromSlug: 'a', toSlug: 'b' });
    expect(v1Mock).toHaveBeenCalledOnce();
    expect(warnMock).toHaveBeenCalledWith(
      'kg_path_v2_failed',
      expect.objectContaining({ code: 42, fromSlug: 'a', toSlug: 'b' }),
    );
  });
});
```

- [ ] Run: `npx vitest run --project unit test/unit/srv/kg-path-v2-handler-flag.test.js`
- Expected: **all four tests FAIL** — either the mock indirection isn't right yet, or (more likely) the handler doesn't do any flag-checking yet.

**Note on test shape:** the `srv._runHandler` helper above is illustrative. If it doesn't exist, use `cds.test('.').post('/graph/pathBetween(fromSlug=\\'a\\',toSlug=\\'b\\')')` — the pattern established in [test/unit/srv/kg-neighborhood-result-shape.test.js](../../../test/unit/srv/kg-neighborhood-result-shape.test.js) shows the shape. Prefer whichever is already used in the neighborhood tests to keep style consistent.

### Step 5.3: Edit the handler + import mapper

- [ ] In `srv/knowledge-graph-service.js`, add near the top imports:

```js
import { kgPathV2 } from './lib/kg-path-v2-client.js';
import { metrics } from './lib/metrics.js'; // if not already imported
```

- [ ] Add helper `mapPgPathsToWireShape` in the same file, near other helpers:

```js
function mapPgPathsToWireShape(paths) {
  const best = paths[0];
  if (!best) return [];
  return best.vertices
    .filter(v => typeof v === 'string' && v.startsWith('tutorial:'))
    .map(v => v.slice('tutorial:'.length));
}
```

- [ ] Modify the existing `pathBetween` handler. Keep the v1 body verbatim in an `existingSparqlPathBetween` inline function (or inline block), then wrap:

```js
srv.on('pathBetween', async (req) => {
  const { fromSlug, toSlug } = req.data;
  const fromIri = `https://developers.sap.com/kg/tutorial/${fromSlug}`;
  const toIri   = `https://developers.sap.com/kg/tutorial/${toSlug}`;
  const t0 = Date.now();

  if (process.env.KG_PATH_V2_ENABLED === 'true') {
    try {
      const paths = await kgPathV2({ fromIri, toIri });
      if (paths.length > 0) {
        const wire = mapPgPathsToWireShape(paths);
        metrics.counter('kg_path_between_calls', { version: 'v2', outcome: 'success', arm: 'prereq' }).inc();
        metrics.reservoir('kg_path_between_latency_ms', { version: 'v2' }).observe(Date.now() - t0);
        return wire;
      }
      metrics.counter('kg_path_v2_fallback', { reason: 'empty' }).inc();
    } catch (err) {
      cds.log('kg').warn('kg_path_v2_failed', {
        code: err.code, message: err.message,
        fromSlug, toSlug,
      });
      metrics.counter('kg_path_v2_fallback', { reason: 'error' }).inc();
    }
  } else {
    metrics.counter('kg_path_v2_fallback', { reason: 'flag_off' }).inc();
  }

  // ── v1 unchanged from here ──
  const v1Result = await /* existing v1 SPARQL call */;
  const arm = classifyV1Arm(v1Result); // returns 'prereq'|'co_completed'|'shared_concept'|'none'
  metrics.counter('kg_path_between_calls', { version: 'v1', outcome: v1Result.length ? 'success' : 'empty', arm }).inc();
  metrics.reservoir('kg_path_between_latency_ms', { version: 'v1' }).observe(Date.now() - t0);
  return v1Result;
});
```

**Note:** `classifyV1Arm` may not exist in the current handler. Two options:
1. If the v1 result carries an arm tag internally (grep the SPARQL body for `BIND(... AS ?pathType)`), extract it and map to metric labels.
2. If not, add a simple `classifyV1Arm(result)` local function that returns `'none'` on empty results and `'prereq'` on non-empty results for the spike. Arm-level attribution on v1 is nice-to-have, not load-bearing.

- [ ] Confirm the `metrics.counter(...)` and `metrics.reservoir(...)` names exist by grepping `srv/lib/metrics.js`. If the module uses different primitive names (e.g. `metrics.inc`, `metrics.observe`), adjust.

### Step 5.4: Run the handler tests (green)

- [ ] `npx vitest run --project unit test/unit/srv/kg-path-v2-handler-flag.test.js`
- Expected: **all four tests PASS**.

### Step 5.5: Commit

- [ ] `git add srv/knowledge-graph-service.js test/unit/srv/kg-path-v2-handler-flag.test.js && git commit -m "feat(#913): pathBetween flag branch + fail-open v2→v1 fallback + metrics"`

---

## Task 6: Hybrid test — end-to-end fixture graph

**Depends on:** Task 5 complete. Requires `ALLOW_HYBRID_WRITES=true` + `cf login` to DEV.

**Files:**
- Create: `test/hybrid/kg-path-v2.test.js`

### Step 6.1: Author the hybrid test

- [ ] Create `test/hybrid/kg-path-v2.test.js`. Follow the fixture-seed/cleanup pattern from [test/hybrid/kg-named-queries.test.js](../../../test/hybrid/kg-named-queries.test.js):

```js
// test/hybrid/kg-path-v2.test.js
// End-to-end hybrid test — seeds a small subgraph in the LIVE DEV HDI,
// exercises KG_PATH_V2 via the JS wrapper, then cleans up.
//
// SAFETY: All fixtures use TEST_PREFIX `__TEST__kg-path-v2-`. The
// afterAll cleans up via LOWER(slug) LIKE. Gated by ALLOW_HYBRID_WRITES.
//
// HOW TO RUN:
//   ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec --profile hybrid -- \
//     npx vitest run --project hybrid test/hybrid/kg-path-v2.test.js

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { kgPathV2 } from '../../srv/lib/kg-path-v2-client.js';

const TEST_PREFIX = `__TEST__kg-path-v2-`;
const RUN_ID = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// 4 concepts chained by kg:requires: c0 → c1 → c2 → c3
const C = Array.from({ length: 4 }, (_, i) => `${TEST_PREFIX}${RUN_ID}-c${i}`);
// 4 tutorials: t0 teaches c0, t3 teaches c3, tIsland teaches nothing
const T_FROM = `${TEST_PREFIX}${RUN_ID}-t-from`;   // teaches c0
const T_TO   = `${TEST_PREFIX}${RUN_ID}-t-to`;     // teaches c3
const T_MID  = `${TEST_PREFIX}${RUN_ID}-t-mid`;    // teaches c1 (bridge)
const T_ISLAND = `${TEST_PREFIX}${RUN_ID}-t-island`; // teaches no chained concept

beforeAll(async () => {
  if (!isSafeForWrites()) throw new Error('write-safety guard rejected');

  const db = await cds.connect.to('db');
  const { Concepts, ConceptEdges, Tutorials, TutorialConceptLinks } = db.entities('com.sap.developers.ims');

  const now = new Date().toISOString();

  // Seed 4 concepts.
  const conceptRows = C.map((slug, i) => ({
    ID: crypto.randomUUID(), slug, name: `Test ${slug}`,
    status: 'ACTIVE', createdAt: now,
  }));
  await INSERT.into(Concepts).entries(conceptRows);

  // Seed the 3 requires edges (c0 → c1 → c2 → c3).
  const edgeRows = [];
  for (let i = 0; i < 3; i++) {
    edgeRows.push({
      ID: crypto.randomUUID(),
      source_ID: conceptRows[i].ID,
      target_ID: conceptRows[i + 1].ID,
      predicate: 'requires',
      status: 'ACTIVE',
      createdAt: now,
    });
  }
  await INSERT.into(ConceptEdges).entries(edgeRows);

  // Seed 4 tutorials.
  const tutRows = [T_FROM, T_TO, T_MID, T_ISLAND].map(slug => ({
    ID: crypto.randomUUID(), slug, title: `Test ${slug}`, createdAt: now,
  }));
  await INSERT.into(Tutorials).entries(tutRows);

  // Seed teaches links.
  const linkRows = [
    { tutorial_ID: tutRows[0].ID, concept_ID: conceptRows[0].ID }, // t-from → c0
    { tutorial_ID: tutRows[1].ID, concept_ID: conceptRows[3].ID }, // t-to → c3
    { tutorial_ID: tutRows[2].ID, concept_ID: conceptRows[1].ID }, // t-mid → c1
  ].map(r => ({ ID: crypto.randomUUID(), ...r, createdAt: now }));
  await INSERT.into(TutorialConceptLinks).entries(linkRows);
}, 120_000);

afterAll(async () => {
  const db = await cds.connect.to('db');
  await db.run(`DELETE FROM "com.sap.developers.ims.TutorialConceptLinks" WHERE LOWER("tutorial_ID") IN (SELECT ID FROM "com.sap.developers.ims.Tutorials" WHERE LOWER("slug") LIKE ?)`, [`${TEST_PREFIX.toLowerCase()}%`]);
  await db.run(`DELETE FROM "com.sap.developers.ims.Tutorials" WHERE LOWER("slug") LIKE ?`, [`${TEST_PREFIX.toLowerCase()}%`]);
  await db.run(`DELETE FROM "com.sap.developers.ims.ConceptEdges" WHERE LOWER("source_ID") IN (SELECT ID FROM "com.sap.developers.ims.Concepts" WHERE LOWER("slug") LIKE ?)`, [`${TEST_PREFIX.toLowerCase()}%`]);
  await db.run(`DELETE FROM "com.sap.developers.ims.Concepts" WHERE LOWER("slug") LIKE ?`, [`${TEST_PREFIX.toLowerCase()}%`]);
}, 60_000);

describe('KG_PATH_V2 end-to-end', () => {
  it('finds a prereq path between two chained tutorials', async () => {
    const paths = await kgPathV2({
      fromIri: `https://developers.sap.com/kg/tutorial/${T_FROM}`,
      toIri:   `https://developers.sap.com/kg/tutorial/${T_TO}`,
    });
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0].hopCount).toBeGreaterThanOrEqual(1);
    expect(paths[0].vertices[0]).toBe(`tutorial:${T_FROM}`);
    expect(paths[0].vertices[paths[0].vertices.length - 1]).toBe(`tutorial:${T_TO}`);
  });

  it('returns empty for the island tutorial', async () => {
    const paths = await kgPathV2({
      fromIri: `https://developers.sap.com/kg/tutorial/${T_ISLAND}`,
      toIri:   `https://developers.sap.com/kg/tutorial/${T_TO}`,
    });
    expect(paths).toEqual([]);
  });

  it('procedure-level IRI validation fires on malformed input', async () => {
    // Bypass JS regex by patching the module — send a technically-valid JS
    // input that the PROCEDURE'S LIKE_REGEXPR rejects.
    // Simplest: pass a slug with an uppercase letter, which fails DB regex
    // BUT would also fail JS regex — so instead we mock cds.db.run to send
    // raw bytes. Alternative: expect the DB error via a direct db.run call.
    const db = await cds.connect.to('db');
    await expect(db.run(
      `DO (IN f NVARCHAR(500) => ?, IN t NVARCHAR(500) => ?, IN m INTEGER => ?) BEGIN
        DECLARE paths TABLE (path_rank INTEGER, hop_count INTEGER, vertex_seq NVARCHAR(500), seq_index INTEGER);
        CALL KG_PATH_V2(:f, :t, :m, :paths);
        SELECT * FROM :paths;
      END`,
      ['not-an-iri', `https://developers.sap.com/kg/tutorial/${T_TO}`, 8]
    )).rejects.toThrow(/10006|KG_INVALID/i);
  });
});
```

### Step 6.2: Run the hybrid test

- [ ] Ensure `cf login` targets DEV and `.cdsrc-private.json` is populated. Ensure `ALLOW_HYBRID_WRITES=true`.
- [ ] Run:

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec --profile hybrid -- \
  npx vitest run --project hybrid test/hybrid/kg-path-v2.test.js
```

- Expected: all three tests PASS. If Task 3 shipped a placeholder `SHORTEST_PATH` body (still returning empty on Task 1 gate delay), test 1 fails — that's the signal Task 1 needs finishing.

### Step 6.3: Commit

- [ ] `git add test/hybrid/kg-path-v2.test.js && git commit -m "test(#913): hybrid fixture graph test for KG_PATH_V2"`

---

## Task 7: Deploy + rollback drill on DEV

**Depends on:** Tasks 2, 3, 4, 5, 6 all merged.

### Step 7.1: Deploy the MTA

- [ ] From primary tree (not the worktree) on `main`:

```bash
cd d:/projects/tutorials-poc
git checkout main && git pull
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

- Expected: deploy succeeds. `hana-cli inspectTable --table KG_PG_VERTICES_V` returns metadata; procedure `KG_PATH_V2` exists.

### Step 7.2: Execute the rollback drill (from the spec)

- [ ] `cf target -s dev && cf set-env tutorials-srv KG_PATH_V2_ENABLED true && cf restart tutorials-srv`
- [ ] Drive 5 deliberate `pathBetween` calls with a known-connected slug pair. Use `curl -sS`:

```bash
BASE=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com
# Note: /graph/pathBetween is public per srv/knowledge-graph-service.cds § "@requires: 'any'"
for i in 1 2 3 4 5; do
  curl -sS "$BASE/graph/pathBetween(fromSlug='<a>',toSlug='<b>')" > /dev/null
  echo "call $i"
done
```

- [ ] Wait 5 minutes. Open `/admin-ui/#metrics`. Confirm:
  - `kg_path_between_calls{version=v2, outcome=success}` incremented by 5 (assuming path exists)
  - `kg_path_between_latency_ms{version=v2}` reservoir populated
  - No `kg_path_v2_failed` warnings in `cf logs tutorials-srv --recent`

- [ ] Flip flag off: `cf set-env tutorials-srv KG_PATH_V2_ENABLED false && cf restart tutorials-srv`
- [ ] Repeat 5 calls. Wait 5 minutes.
- [ ] Confirm `version=v1` counters incrementing and `version=v2` stopped.

### Step 7.3: Document the drill outcome

- [ ] Append a "Rollback drill — <date>" section to `docs/superpowers/reviews/2026-07-DD-kg-property-graph-spike-task1-notes.md` with the observed counter values and any anomalies.

- [ ] Commit if any notes changed.

### Step 7.4: Flip flag ON for the observation window

- [ ] Once drill succeeds cleanly: `cf set-env tutorials-srv KG_PATH_V2_ENABLED true && cf restart tutorials-srv`. Leave on for the remainder of the spike week.

---

## Task 8: Decision-gate artifact template

**Depends on:** Task 7 flag flipped on. Fill in at end of week; skeleton committed now.

**Files:**
- Create: `docs/superpowers/reviews/2026-07-DD-kg-property-graph-spike-review.md` (rename `DD` to actual date at fill-in time)

### Step 8.1: Author the review template

- [ ] Create the file with these five sections (matches spec § Decision gate):

```markdown
# KG Property Graph Spike — end-of-week review

**Date:** YYYY-MM-DD
**Spec:** [../specs/2026-07-02-913-kg-property-graph-spike-design.md](../specs/2026-07-02-913-kg-property-graph-spike-design.md)
**Related PRs:** TBD

## 1. What we shipped

- [ ] Merged PR(s):
- [ ] Deployed procedure `KG_PATH_V2` (verify: `hana-cli inspectTable --table KG_PATH_V2` returns metadata)
- [ ] Deployed workspace `KG_PG_WORKSPACE`
- [ ] Deployed views `KG_PG_VERTICES_V`, `KG_PG_EDGES_V`

## 2. Was v2 measurably better on `pathBetween`?

Screenshot of `/admin-ui/#metrics` from `<date-start>` to `<date-end>` showing:
- p50 / p95 / p99 latency for `version=v1` and `version=v2`
- Success / empty / error counts by version
- Fallback breakdown by reason (error / empty / flag_off)

Concrete numbers (fill in from `/admin/metrics/live`):

| Metric | v1 | v2 |
| --- | --- | --- |
| p50 latency (ms) | | |
| p95 latency (ms) | | |
| p99 latency (ms) | | |
| Success rate (%) | | |
| Empty-path rate (%) | | |

Interpretation: (1-2 paragraphs on what the numbers say)

## 3. Did anything break?

- Total `kg_path_v2_failed` fallbacks: N over observation window (`cf logs tutorials-srv --recent | grep kg_path_v2_failed | wc -l`)
- Cited log lines (max 5, the most representative):
- User-visible incidents: none / listed

## 4. Developer-experience read

- Property-graph learning curve during the spike (candid, 3-5 sentences)
- Would the team be comfortable authoring another algorithm procedure (PageRank, community, WCC) without hand-holding? Y/N + why

## 5. Follow-on decisions

- **#916 PageRank:** yes / no / needs-more-thought — 1 paragraph
- **#917 Community detection:** yes / no / needs-more-thought — 1 paragraph
- **#918 WCC:** yes / no / needs-more-thought — 1 paragraph
- **#919 9-predicate workspace widening:** yes / no / needs-more-thought — 1 paragraph
```

### Step 8.2: Commit the skeleton

- [ ] `git add docs/superpowers/reviews/ && git commit -m "docs(#913): review-artifact skeleton (fill at end-of-week gate)"`

### Step 8.3: End-of-week fill-in

- [ ] Fill sections 2, 3, 4, 5 with real numbers, cite live log lines, get team input on section 5.
- [ ] Commit and open the review PR against `main`, requesting team feedback per follow-on issue.

---

## Post-plan: What isn't in this plan

- **No smoke test.** Per spec § Test coverage — the `pathBetween` endpoint isn't in the existing smoke suite; adding it would require production fixtures.
- **No performance micro-benchmarks in test.** Per spec — noisy and misleading. Live metrics during the observation window are the evidence.
- **No admin-UI changes.** The metrics tile already exists (#805); we ride on it.
- **No documentation changes to CLAUDE.md or `docs/developers/`.** The property-graph engine remains internal until the gate decides to graduate a follow-on.
- **No PR to widen `KG_PG_EDGES_V`.** That's #919, filed and blocked on this spike's gate.

