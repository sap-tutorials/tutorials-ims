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
- `test/unit/srv/kg-path-v2-client.test.js` — pure-JS wrapper unit tests (co-located with other srv/lib tests).
- `test/unit/srv/kg-path-v2-handler-flag.test.js` — handler-level flag/fallback tests.
- `test/hybrid/kg-path-v2.test.js` — end-to-end fixture graph test against real HANA.
- `docs/superpowers/reviews/2026-07-DD-kg-property-graph-spike-review.md` — decision-gate artifact (template written now; numbers filled at end of week).

**Modified files:**

- `srv/knowledge-graph-service.js` — `pathBetween` handler (currently a Phase 2 stub at lines 895-900) gains a flag check, v2 call, fail-open v1 fallback wired to `kgQuery({ queryName: 'PATH_BETWEEN' })`, and metric emission.

**Deploy-time verification (not a code edit):**

- `.deploy/mta.yaml` — confirm `tutorials-db-deployer` module (`path: ../gen/db`) picks up new HDI artifacts under `db/src/{views,graph,procedures}/` after `cds build --production`. The db module points at `gen/db` (the build output), so any `.hdb*` file under `db/src/` is packed automatically by `cds build`. Similarly confirm `tutorials-db-qa-deployer` (`path: ../gen/db-qa`) packs the QA stub procedure. **Task 3 Step 3.5 adds a `cds build --production && ls gen/db/src/gen/` verification step** to catch this before deploy.

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

### Step 1.3: `SHORTEST_PATH` syntax probe — redirect to HDI deploy cycle (Path C)

**Update (2026-07-02, from executed Task 1):** The original ad-hoc probe plan (create throwaway `_KGPROBE_*` tables directly) is **not possible** in this HDI container. Runtime users don't have `CREATE TABLE` — HDI's object-owner model reserves DDL for `.hdb*` files at deploy time. Details in [`docs/superpowers/reviews/2026-07-02-kg-property-graph-spike-task1-notes.md`](../reviews/2026-07-02-kg-property-graph-spike-task1-notes.md).

**Redirect (Path C, approved):** use the first HDI deploy attempt in Tasks 2–3 as the probe.

- Task 2 authors the real `.hdbview` files with the confirmed uppercase-underscore table names.
- Task 3 Step 3.1 authors a minimal `.hdbgraphworkspace` declaration.
- The first `cf push tutorials-db-deployer` either:
  - **Compiles the workspace successfully** → entitlement + HDI plugin are wired. Iterate on the procedure body's `SHORTEST_PATH` call in Task 3 Step 3.2 across successive deploys (~30 s each).
  - **Rejects the file suffix or the workspace declaration** → the property-graph HDI plugin is not configured on this container. The spike stalls on service-key/plugin config, not on code. Update this notes file and surface to the maintainer.

Skip to Step 1.4 — the "hand-authored SQL against a throwaway workspace" is deleted as unreachable.

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

**Confirmed table + column names from Task 1** (see [`docs/superpowers/reviews/2026-07-02-kg-property-graph-spike-task1-notes.md`](../reviews/2026-07-02-kg-property-graph-spike-task1-notes.md)):

- Tables: `COM_SAP_DEVELOPERS_IMS_CONCEPTS`, `COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES`, `COM_SAP_DEVELOPERS_IMS_TUTORIALS`, `COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS` — all uppercase, underscore-flattened.
- Columns are uppercase: `SLUG`, `NAME`, `TITLE`, `STATUS`, `ID`, `SOURCE_ID`, `TARGET_ID`, `TUTORIAL_ID`, `CONCEPT_ID`, `PREDICATE`.

- [ ] Create the file with union of concept + tutorial vertex projections:

```sql
VIEW "KG_PG_VERTICES_V" AS
  -- Concept vertices — one row per active concept.
  SELECT
    CAST('concept:' || SLUG AS NVARCHAR(100)) AS "VERTEX_KEY",
    'concept'                                 AS "VERTEX_TYPE",
    SLUG                                      AS "SLUG",
    NAME                                      AS "LABEL",
    STATUS                                    AS "STATUS"
  FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
  WHERE STATUS = 'ACTIVE'
  UNION ALL
  -- Tutorial vertices — synthesized from the link table because tutorials
  -- don't live in a KG-specific table.
  SELECT DISTINCT
    CAST('tutorial:' || t.SLUG AS NVARCHAR(100)) AS "VERTEX_KEY",
    'tutorial'                                   AS "VERTEX_TYPE",
    t.SLUG                                       AS "SLUG",
    t.TITLE                                      AS "LABEL",
    NULL                                         AS "STATUS"
  FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS" tcl
  JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t ON t.ID = tcl.TUTORIAL_ID;
```

**Note:** `.hdbview` files use `VIEW` (not `CREATE VIEW`) and HDI resolves the schema at deploy time.

### Step 2.2: Author `KG_PG_EDGES_V.hdbview`

- [ ] Create the file with `requires` (concept→concept) and `teaches` (tutorial→concept) union:

```sql
VIEW "KG_PG_EDGES_V" AS
  -- kg:requires edges: concept → concept
  SELECT
    CAST('concept:' || src.SLUG AS NVARCHAR(100)) AS "SOURCE",
    CAST('concept:' || tgt.SLUG AS NVARCHAR(100)) AS "TARGET",
    'requires'                                    AS "EDGE_TYPE"
  FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES" ce
  JOIN "COM_SAP_DEVELOPERS_IMS_CONCEPTS" src ON src.ID = ce.SOURCE_ID
  JOIN "COM_SAP_DEVELOPERS_IMS_CONCEPTS" tgt ON tgt.ID = ce.TARGET_ID
  WHERE ce.PREDICATE = 'requires' AND ce.STATUS = 'ACTIVE'
    AND src.STATUS = 'ACTIVE' AND tgt.STATUS = 'ACTIVE'
  UNION ALL
  -- kg:teaches edges: tutorial → concept
  SELECT
    CAST('tutorial:' || t.SLUG AS NVARCHAR(100)) AS "SOURCE",
    CAST('concept:'  || c.SLUG AS NVARCHAR(100)) AS "TARGET",
    'teaches'                                    AS "EDGE_TYPE"
  FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS" tcl
  JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t ON t.ID = tcl.TUTORIAL_ID
  JOIN "COM_SAP_DEVELOPERS_IMS_CONCEPTS"  c ON c.ID = tcl.CONCEPT_ID
  WHERE c.STATUS = 'ACTIVE';
```

### Step 2.3: Deploy views to DEV HDI

- [ ] **Do NOT use `cds deploy --auto-undeploy` from the worktree** — the DEV HDI is shared with other in-flight work; auto-undeploy will nuke artifacts not present in this worktree's build (see the [`feedback-cf-push-db-deployer-fast-path`](../../../memory/feedback-cf-push-db-deployer-fast-path.md) memory + the "Always deploy from main" memory).

- [ ] Use the **`cf push db-deployer` fast-path** for schema-only iteration (documented in `docs/developers/operations/mta-deployment.md` § "Fast schema-only path"):

```bash
cd d:/projects/tutorials-poc
git checkout main && git pull && git checkout worktree-kg-property-graph-spec -- db/src/views/
cds build --production
cf target -s dev
cf push tutorials-db-deployer -f .deploy/manifest-db-deployer.yml --no-start
cf run-task tutorials-db-deployer --command "npx @sap/hdi-deploy" --wait
```

  - If the manifest doesn't exist, the tutorials-db-deployer app in DEV can be re-`cf restart`ed after new `.hdbview` files land in its droplet — deploying via a fresh `mbt build && cf deploy` from a clean `main` checkout is the fully safe alternative but is ~5 min slower.
  - Expected: deploy succeeds; `hana-cli views | grep KG_PG` shows both views.
  - If either fails compile, Task 1's table-name form was wrong — go back to Task 1 Step 1.2, correct, re-run Step 2.1/2.2.

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

- [ ] Deploy via the same `cf push db-deployer` fast-path from Step 2.3 (do NOT `cds deploy --auto-undeploy` from the worktree).

- [ ] Probe via a DO-block that binds the OUT param (direct `CALL` will error because `@cap-js/hana` doesn't bind OUT table params through `db.run`; the DO-block-with-inline-SELECT is the canonical workaround established in [`srv/lib/kg-sparql-client.js:73-107`](../../../srv/lib/kg-sparql-client.js#L73-L107)):

```bash
hana-cli querySimple --query "DO (IN f NVARCHAR(500) => 'https://developers.sap.com/kg/tutorial/<known-slug-a>', IN t NVARCHAR(500) => 'https://developers.sap.com/kg/tutorial/<known-slug-b>', IN m INTEGER => 8) BEGIN
  DECLARE paths TABLE (path_rank INTEGER, hop_count INTEGER, vertex_seq NVARCHAR(500), seq_index INTEGER);
  CALL KG_PATH_V2(:f, :t, :m, :paths);
  SELECT * FROM :paths;
END"
```

  Replace `<known-slug-a/b>` with two tutorial slugs known to be connected in the graph. Expected: zero or more rows. If a `SIGNAL 10006` fires, the IRI regex mismatched — check tutorial slugs.

### Step 3.5: Verify `cds build` packs the new artifacts, then commit

- [ ] Confirm all new artifacts land in the build output:

```bash
cds build --production
ls gen/db/src/gen/ | grep -E 'KG_PATH_V2|KG_PG'
ls gen/db-qa/src/gen/ | grep KG_PATH_V2
```

  Expected: 4 lines from `gen/db/src/gen/` (`KG_PATH_V2.hdbprocedure`, `KG_PG_WORKSPACE.hdbgraphworkspace`, `KG_PG_VERTICES_V.hdbview`, `KG_PG_EDGES_V.hdbview`) and 1 line from `gen/db-qa/src/gen/` (`KG_PATH_V2.hdbprocedure`).

  If any are missing, either the mta.yaml `before-all` copy list (lines 22-23) needs an update, or `.hdiconfig` doesn't map the new file suffix. **Do NOT proceed to deploy until all four DEV + one QA artifact are present.**

- [ ] `git add db/src/graph/ db/src/procedures/ db/src/views/ db-qa/src/procedures/ && git commit -m "feat(#913): KG_PATH_V2 procedure + KG_PG_WORKSPACE + views + QA stub"`

---

## Task 4: JS wrapper (`srv/lib/kg-path-v2-client.js`) + unit tests

**Depends on:** Task 3 deployed. Task 1 Step 1.4 confirmed the DO-block-with-table shape (`cds.db.run` returns rows correctly).

**Files:**

- Create: `srv/lib/kg-path-v2-client.js`
- Create: `test/unit/srv/kg-path-v2-client.test.js`

### Step 4.1: Write the failing unit tests (TDD red)

- [ ] Create `test/unit/srv/kg-path-v2-client.test.js` (co-located with other srv/lib tests):

```js
// test/unit/srv/kg-path-v2-client.test.js
// Pure-JS unit tests for the KG_PATH_V2 wrapper. Uses vi.mock to stub
// cds.db.run — no DB required. Hybrid coverage lives in
// test/hybrid/kg-path-v2.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const runMock = vi.fn();
vi.mock('@sap/cds', () => ({
  default: { db: { run: (...args) => runMock(...args) } },
}));

// Import AFTER vi.mock so the mock is in place.
const { kgPathV2 } = await import('../../../srv/lib/kg-path-v2-client.js');

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
    // path_rank 2 has only 2 vertices total — no interior at all — so the
    // < 3 total-vertices filter drops it. path_rank 1 has 4 vertices; its
    // interior is ['concept:c1','concept:c2'] — kept.
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

- [ ] Run: `npx vitest run --project unit test/unit/srv/kg-path-v2-client.test.js`
- Expected: **all tests FAIL** with "Cannot find module '../../../srv/lib/kg-path-v2-client.js'".

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

- [ ] Run: `npx vitest run --project unit test/unit/srv/kg-path-v2-client.test.js`
- Expected: **all tests PASS**.

### Step 4.3: Commit

- [ ] `git add srv/lib/kg-path-v2-client.js test/unit/srv/kg-path-v2-client.test.js && git commit -m "feat(#913): kg-path-v2-client JS wrapper + unit tests"`

---

## Task 5: Handler edit + metrics + handler-level unit test

**Depends on:** Task 4 complete.

**Files:**

- Modify: `srv/knowledge-graph-service.js` (existing `pathBetween` handler at lines 895-900 — currently a Phase 2 stub returning `[]`)
- Create: `test/unit/srv/kg-path-v2-handler-flag.test.js`

### Step 5.1: Read the current handler + metrics API

- [ ] Read [`srv/knowledge-graph-service.js:895-900`](../../../srv/knowledge-graph-service.js#L895-L900). Current handler body is:

```js
  // ─── pathBetween — Phase 2 stub ────────────────────────────────────────
  this.on('pathBetween', async (req) => {
    const { fromSlug, toSlug } = req.data;
    log.warn(`kg-service: pathBetween(${fromSlug} → ${toSlug}) — Phase 2 stub, returning []`);
    return [];
  });
```

  **Implication:** there is NO complex v1 body to preserve. The Phase 2 stub returns `[]` today; the RDF-based `PATH_BETWEEN` SPARQL body exists in `db/src/procedures/KG_QUERY.hdbprocedure` but is not currently invoked by this handler. The spike's "v1 fallback" therefore has TWO options:
    - **Option A (recommended):** wire v1 to the existing `kgQuery({ queryName: 'PATH_BETWEEN', params: { fromSlug, toSlug } })` from [`srv/lib/kg-sparql-client.js`](../../../srv/lib/kg-sparql-client.js) — this activates the SPARQL PATH_BETWEEN dispatch that was written for issue #445 but never wired to the handler. Small extra scope; produces a real A/B.
    - **Option B:** keep v1 as `[]` and let v2 be measured against "nothing." The A/B becomes v2-only.

  Pick **A**. The plan proceeds on that basis.

- [ ] Read [`srv/lib/metrics.js`](../../../srv/lib/metrics.js). The public API is **module-level named exports**, not an object:

```js
export function counter(name) { /* increments; no dimensions */ }
export function gauge(name, value) { /* sets */ }
export function observe(name, value) { /* Vitter reservoir push */ }
```

  **Implication:** dimensions in the spec (e.g. `{ version: 'v1', outcome: 'success' }`) must be **encoded into the metric name** — the API doesn't accept dimension objects. Use `_`-separated name suffixes: `kg_path_between_calls_v2_success_prereq`, `kg_path_between_latency_ms_v2`, etc. Follow the convention used elsewhere in the project — grep `srv/` for existing `counter('kg_...')` calls if any to check.

### Step 5.2: Write the failing handler-level test using `cds.test`

The codebase's convention for service-handler unit tests is to `cds.load` the CSN and either assert against it OR spin up `cds.test` and POST to the handler. Below uses the CSN-load pattern from [`test/unit/srv/kg-neighborhood-result-shape.test.js`](../../../test/unit/srv/kg-neighborhood-result-shape.test.js) plus a `cds.test('.')` bootstrap for HTTP-level interaction.

- [ ] Create `test/unit/srv/kg-path-v2-handler-flag.test.js`:

```js
// test/unit/srv/kg-path-v2-handler-flag.test.js
// Handler-level flag-behavior tests. Uses cds.test('.') to spin up an
// in-memory SQLite instance and exercise the pathBetween handler via
// OData. vi.mock replaces the JS wrappers so we're only testing branching.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';

// Mock the property-graph wrapper.
const kgPathV2Mock = vi.fn();
vi.mock('../../../srv/lib/kg-path-v2-client.js', () => ({
  kgPathV2: (...args) => kgPathV2Mock(...args),
}));

// Mock kgQuery so the v1 fallback path is observable without hitting HANA.
const kgQueryMock = vi.fn();
vi.mock('../../../srv/lib/kg-sparql-client.js', async () => {
  const actual = await vi.importActual('../../../srv/lib/kg-sparql-client.js');
  return { ...actual, kgQuery: (...args) => kgQueryMock(...args) };
});

// Capture cds.log warns for the fail-open assertion.
const warnCalls = [];
const originalLog = cds.log;
cds.log = (topic) => {
  const real = originalLog(topic);
  return {
    ...real,
    warn: (...args) => { warnCalls.push({ topic, args }); },
  };
};

// cds.test spins up the service. Point at the project root; the KG service
// registers automatically via `cds.service.impl` in srv/knowledge-graph-service.js.
const { GET } = cds.test('.');

beforeEach(() => {
  kgPathV2Mock.mockReset();
  kgQueryMock.mockReset();
  warnCalls.length = 0;
});

afterEach(() => {
  delete process.env.KG_PATH_V2_ENABLED;
});

const CALL = `/graph/pathBetween(fromSlug='a',toSlug='b')`;

describe('pathBetween handler — flag off', () => {
  it('v2 wrapper is never called; v1 (kgQuery) runs', async () => {
    delete process.env.KG_PATH_V2_ENABLED;
    // v1 SPARQL result — an empty PATH_BETWEEN JSON body.
    kgQueryMock.mockResolvedValue({
      response: JSON.stringify({ results: { bindings: [] } }),
    });
    const { data } = await GET(CALL);
    expect(kgPathV2Mock).not.toHaveBeenCalled();
    expect(kgQueryMock).toHaveBeenCalledOnce();
    expect(data.value).toEqual([]);
  });
});

describe('pathBetween handler — flag on', () => {
  beforeEach(() => { process.env.KG_PATH_V2_ENABLED = 'true'; });

  it('v2 returns rows → response is v2-mapped, v1 not called', async () => {
    kgPathV2Mock.mockResolvedValue([
      { pathRank: 1, hopCount: 2, vertices: ['tutorial:a', 'concept:c1', 'tutorial:b'] },
    ]);
    const { data } = await GET(CALL);
    expect(kgPathV2Mock).toHaveBeenCalledOnce();
    expect(kgQueryMock).not.toHaveBeenCalled();
    expect(data.value).toEqual(['a', 'b']);
  });

  it('v2 returns [] → falls through to v1 (kgQuery called)', async () => {
    kgPathV2Mock.mockResolvedValue([]);
    kgQueryMock.mockResolvedValue({
      response: JSON.stringify({ results: { bindings: [] } }),
    });
    await GET(CALL);
    expect(kgPathV2Mock).toHaveBeenCalledOnce();
    expect(kgQueryMock).toHaveBeenCalledOnce();
    expect(warnCalls).toHaveLength(0);
  });

  it('v2 throws → falls through to v1 AND logs kg_path_v2_failed', async () => {
    const err = new Error('boom'); err.code = 42;
    kgPathV2Mock.mockRejectedValue(err);
    kgQueryMock.mockResolvedValue({
      response: JSON.stringify({ results: { bindings: [] } }),
    });
    await GET(CALL);
    expect(kgQueryMock).toHaveBeenCalledOnce();
    expect(warnCalls.some(w =>
      w.args[0] === 'kg_path_v2_failed' &&
      w.args[1]?.code === 42 &&
      w.args[1]?.fromSlug === 'a'
    )).toBe(true);
  });
});
```

- [ ] Run: `npx vitest run --project unit test/unit/srv/kg-path-v2-handler-flag.test.js`
- Expected: **all four tests FAIL** — the handler still returns the Phase 2 stub `[]` and doesn't call either wrapper.

### Step 5.3: Edit the handler + import mapper

- [ ] Confirm `kgQuery` is already imported near the top of `srv/knowledge-graph-service.js` (grep for `kgQuery` — if only `kgAdminRunSparql` is imported, add `kgQuery` to the same import).

- [ ] Add these imports near the top of `srv/knowledge-graph-service.js`:

```js
import { kgPathV2 } from './lib/kg-path-v2-client.js';
import * as metrics from './lib/metrics.js';
```

- [ ] Add helper `mapPgPathsToWireShape` near other in-file helpers (search for `function mapPgPathsToWireShape` — should not exist yet):

```js
function mapPgPathsToWireShape(paths) {
  const best = paths[0];
  if (!best) return [];
  return best.vertices
    .filter(v => typeof v === 'string' && v.startsWith('tutorial:'))
    .map(v => v.slice('tutorial:'.length));
}

// Extract the bridging tutorial slugs from a SPARQL PATH_BETWEEN response.
// Mirrors the wire shape of the property-graph mapper above.
function mapV1SparqlToWireShape(response) {
  let parsed;
  try { parsed = JSON.parse(response); } catch { return []; }
  const bindings = parsed?.results?.bindings ?? [];
  // The PATH_BETWEEN SPARQL binds ?b (bridging tutorial IRI) per db/src/procedures/KG_QUERY.hdbprocedure:205.
  return bindings
    .map(b => b?.b?.value ?? '')
    .filter(v => v.startsWith('https://developers.sap.com/kg/tutorial/'))
    .map(v => v.slice('https://developers.sap.com/kg/tutorial/'.length));
}
```

- [ ] Replace the current 5-line Phase 2 stub at `srv/knowledge-graph-service.js:895-900` with:

```js
  // ─── pathBetween — property-graph v2 with fail-open v1 fallback (#913) ─
  this.on('pathBetween', async (req) => {
    const { fromSlug, toSlug } = req.data;
    const fromIri = `https://developers.sap.com/kg/tutorial/${fromSlug}`;
    const toIri   = `https://developers.sap.com/kg/tutorial/${toSlug}`;
    const t0 = Date.now();

    if (process.env.KG_PATH_V2_ENABLED === 'true') {
      try {
        const paths = await kgPathV2({ fromIri, toIri });
        if (paths.length > 0) {
          const wire = mapPgPathsToWireShape(paths);
          metrics.counter('kg_path_between_calls_v2_success_prereq');
          metrics.observe('kg_path_between_latency_ms_v2', Date.now() - t0);
          return wire;
        }
        metrics.counter('kg_path_v2_fallback_empty');
      } catch (err) {
        cds.log('kg').warn('kg_path_v2_failed', {
          code: err.code, message: err.message, fromSlug, toSlug,
        });
        metrics.counter('kg_path_v2_fallback_error');
      }
    } else {
      metrics.counter('kg_path_v2_fallback_flag_off');
    }

    // ── v1 SPARQL fallback: activates the PATH_BETWEEN dispatch in KG_QUERY.
    // ── Previously stubbed to []; now wired to the real named-query call.
    try {
      const { response } = await kgQuery({
        db: cds.db,
        queryName: 'PATH_BETWEEN',
        params: { fromSlug, toSlug },
      });
      const wire = mapV1SparqlToWireShape(response);
      metrics.counter(wire.length ? 'kg_path_between_calls_v1_success' : 'kg_path_between_calls_v1_empty');
      metrics.observe('kg_path_between_latency_ms_v1', Date.now() - t0);
      return wire;
    } catch (err) {
      log.warn(`kg-service: pathBetween v1 failed: ${err.message}`);
      metrics.counter('kg_path_between_calls_v1_error');
      return [];
    }
  });
```

**Arm attribution note (reviewer MAJOR 4):** the metric names above collapse the three v1 arms (PREREQ / CO_COMPLETED / SHARED_CONCEPT) into a single `v1_success` counter. Per-arm attribution on v1 would require parsing the SPARQL result's `?pathType` binding — which the current `PATH_BETWEEN` SPARQL does emit (see [KG_QUERY.hdbprocedure:214-231](../../../db/src/procedures/KG_QUERY.hdbprocedure#L214-L231)). If the review artifact needs arm-level v1 numbers, extend `mapV1SparqlToWireShape` to return `{wire, arm}` and stamp the arm into the counter name. For the spike's minimum viable A/B this is deferred.

### Step 5.4: Run the handler tests (green)

- [ ] `npx vitest run --project unit test/unit/srv/kg-path-v2-handler-flag.test.js`
- Expected: **all four tests PASS**.

### Step 5.5: Commit

- [ ] `git add srv/knowledge-graph-service.js test/unit/srv/kg-path-v2-handler-flag.test.js test/unit/srv/kg-path-v2-client.test.js && git commit -m "feat(#913): pathBetween flag branch + fail-open v2→v1 fallback + metrics"`

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

- Expected: deploy succeeds.
- Verify the property-graph artifacts landed:

```bash
hana-cli views | grep KG_PG          # expect: KG_PG_VERTICES_V, KG_PG_EDGES_V
hana-cli procedures | grep KG_PATH_V2  # expect: KG_PATH_V2
```

  (`hana-cli inspectTable` is for tables, not views/procedures — use `views` and `procedures` list commands.)

- [ ] **Verify QA stub is deployed too** (QA channel should NOT crash on procedure resolution even though the property-graph engine isn't wired there):

```bash
# Against the QA HDI container (switch service key via `hana-cli useKey <qa-key>` or the appropriate `--profile qa` on hana-cli).
hana-cli procedures --profile qa | grep KG_PATH_V2  # expect: KG_PATH_V2 present
hana-cli querySimple --profile qa --query "DO BEGIN
  DECLARE paths TABLE (path_rank INTEGER, hop_count INTEGER, vertex_seq NVARCHAR(500), seq_index INTEGER);
  CALL KG_PATH_V2('https://developers.sap.com/kg/tutorial/foo','https://developers.sap.com/kg/tutorial/bar', 8, :paths);
  SELECT * FROM :paths;
END"
```

  Expected: fails with SQLError code `10099` (`KG_NOT_AVAILABLE_ON_QA`). Any other outcome means the QA stub didn't deploy or referenced a missing object.

### Step 7.2: Execute the rollback drill (from the spec)

- [ ] `cf target -s dev && cf set-env tutorials-srv KG_PATH_V2_ENABLED true && cf restart tutorials-srv`
- [ ] Drive 5 deliberate `pathBetween` calls with a known-connected slug pair. Use `curl -sS`:

```bash
BASE=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com
# Note: /graph/pathBetween is public per srv/knowledge-graph-service.cds § "@requires: 'any'"
for i in 1 2 3 4 5; do
  curl -sS "$BASE/graph/pathBetween(fromSlug='SLUG_A',toSlug='SLUG_B')" > /dev/null
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

- [ ] Append a "Rollback drill — YYYY-MM-DD" section to `docs/superpowers/reviews/2026-07-DD-kg-property-graph-spike-task1-notes.md` with the observed counter values and any anomalies.

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
- [ ] Deployed procedure `KG_PATH_V2` (verify: `hana-cli procedures | grep KG_PATH_V2`)
- [ ] Deployed workspace `KG_PG_WORKSPACE` (verify via HANA `SYS.GRAPH_WORKSPACES` view or the HDI-plugin-specific catalog)
- [ ] Deployed views `KG_PG_VERTICES_V`, `KG_PG_EDGES_V` (verify: `hana-cli views | grep KG_PG`)

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
