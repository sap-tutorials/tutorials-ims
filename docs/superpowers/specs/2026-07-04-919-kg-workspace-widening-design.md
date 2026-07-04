# KG: widen KG_PG_WORKSPACE to 9-predicate parity — Design

**Issue:** [#919](https://github.com/sap-tutorials/tutorials-ims/issues/919)
**Parent spike:** [#913](https://github.com/sap-tutorials/tutorials-ims/issues/913), design in [`2026-07-02-913-kg-property-graph-spike-design.md`](2026-07-02-913-kg-property-graph-spike-design.md).
**Unblocks:** [#916](https://github.com/sap-tutorials/tutorials-ims/issues/916) PageRank, [#917](https://github.com/sap-tutorials/tutorials-ims/issues/917) community detection, [#918](https://github.com/sap-tutorials/tutorials-ims/issues/918) WCC — all three algorithms need the widened graph.
**Scope:** DEV-only per #913 non-goals.
**Date:** 2026-07-04

## Problem

The spike deliberately narrowed `KG_PG_WORKSPACE` to two edge types (`requires`,
`teaches`) so it could ship in a week. Every downstream algorithm follow-on
(#916 / #917 / #918) needs the seven additional predicates the RDF graph
already carries:

`relatedTo`, `extends`, `partOf`, `taggedWith`, `aboutProduct`, `inCategory`,
`coCompletedWith`.

Until the property-graph workspace reaches parity with the RDF projection, the
algorithm follow-ons can only see partial cohort / curation signal and their
outputs will systematically undervalue tutorials whose signal lives in the
missing edge types (tag-heavy content especially).

## Proposal

Extend `KG_PG_EDGES_V` with seven more UNION-ALL arms and `KG_PG_VERTICES_V`
with five new vertex types (`mission`, `group`, `tag`, `product`, `category`).
Views only — no new physical tables, no changes to `graphRebuild()`. The
`KG_PG_WORKSPACE.hdbgraphworkspace` declaration itself does not change —
the plugin infers types from the view columns.

## Design decisions (locked during brainstorm)

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| Q1 | Views vs materialized | **Views only** | Zero rebuild-job changes, no double-write hazard; measure perf on DEV before considering materialization. |
| Q2 | `coCompletedWith` direction | **Keep both directions** | RDF-parity; algorithms consume via `direction := 'ANY'` anyway. |
| Q3 | `EDGE_KEY` sizing | **Widen to `NVARCHAR(600)`** | `taggedWith` worst case is 513 chars; 600 gives modest headroom. Debug-readable vs hashing. |
| Q4 | Tag vertex identity | **Use `Tags.name` as slug**, `WHERE name IS NOT NULL` | RDF-parity. Accepts same (small) dup-name risk as RDF. |
| Q5 | `aboutProduct` vertex source | **Synthesize `product` from tags with `name LIKE 'software-product>%'`** | RDF-parity. No `Products` entity exists; extraction is the identity. |
| Q6 | `partOf` shape | **Two UNION-ALL arms, both labeled `partOf`** | RDF-parity. Tutorial→mission and mission→group both carry the same predicate. |

## Architecture

```
Before (post-#913, 2 predicates):        After #919 (9 predicates):
─────────────────                        ─────────────
KG_PG_VERTICES_V:                        KG_PG_VERTICES_V:
  concept                                  concept
  tutorial                                 tutorial
                                           mission
                                           group
                                           tag
                                           product
                                           category

KG_PG_EDGES_V:                           KG_PG_EDGES_V:
  requires   (concept → concept)           requires        (concept → concept)
  teaches    (tutorial → concept)          teaches         (tutorial → concept)
                                           relatedTo       (concept → concept)
                                           extends         (tutorial → tutorial)
                                           partOf          (tutorial → mission)
                                           partOf          (mission → group)
                                           taggedWith      (tutorial → tag)
                                           aboutProduct    (tutorial → product)
                                           inCategory      (mission → category)
                                           coCompletedWith (tutorial → tutorial, both dirs)

KG_PG_WORKSPACE.hdbgraphworkspace:       unchanged — plugin infers types
  (declares only KEY COLUMNs +           from view columns.
   SOURCE/TARGET column names)
```

## Components

### Modified files (2)

**`db/src/views/KG_PG_VERTICES_V.hdbview`** — add 5 UNION-ALL arms for the new
vertex types. Preserve `VERTEX_KEY NVARCHAR(280)` sizing; the widest new key
is `product:<slug>` where the extracted suffix is ≤ 255 chars, so `product:` +
255 = 263, comfortably under 280.

**`db/src/views/KG_PG_EDGES_V.hdbview`** — add 7 UNION-ALL arms. Widen
`EDGE_KEY` from `NVARCHAR(400)` to `NVARCHAR(600)` to cover
`w|<tutorial-slug ≤255>|<tag-name ≤255>` = 513. Update the sizing comment at
the top of the file to spell out the new worst case.

### Not touched

- `db/src/graph/KG_PG_WORKSPACE.hdbgraphworkspace` — the workspace declaration
  is agnostic to edge-type / vertex-type contents; the plugin reads
  `VERTEX_TYPE` / `EDGE_TYPE` at runtime.
- `db/knowledge-graph.cds` — schema is unchanged.
- `srv/lib/kg-graph-rebuild.js` — rebuild path unchanged (views auto-widen).
- `srv/lib/kg-projection.js` — RDF projection unchanged.
- `KG_QUERY.hdbprocedure`, `KG_PATH_V2.hdbprocedure`, `KG_SHORTEST_PATH_GRAPH.hdbprocedure`,
  `KG_ADMIN_RUNSPARQL.hdbprocedure`, `KG_GRAPH_CLEAR.hdbprocedure`,
  `KG_GRAPH_INSERT.hdbprocedure` — all consumers read the widened views for free.

### New files (1)

**`test/hybrid/kg-workspace-widening.test.js`** — seed a minimal fixture
carrying one row of each of the 9 predicates; assert `SELECT DISTINCT EDGE_TYPE
FROM KG_PG_EDGES_V WHERE ...` includes all 9. Also assert new vertex types
appear in `KG_PG_VERTICES_V`.

### QA-channel duality

Views deploy to both prod and QA HDI containers via the same `db/src/views/`
path (QA uses `db-qa/`, but views are typically shared with the prod DB
schema — verify at plan-execution time whether `db-qa/src/views/` shadows
these). If QA has its own view copies, they get the same widening.

## Data flow — the 7 new arms

Each below shows the exact JOIN pattern the view arm will project.

### 1. `relatedTo` (concept → concept)

Mechanical copy of the existing `requires` arm:

```sql
SELECT
  CAST('rel|' || src.SLUG || '|' || tgt.SLUG AS NVARCHAR(600)) AS "EDGE_KEY",
  CAST('concept:' || src.SLUG AS NVARCHAR(280))                AS "SOURCE",
  CAST('concept:' || tgt.SLUG AS NVARCHAR(280))                AS "TARGET",
  'relatedTo'                                                  AS "EDGE_TYPE"
FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES" ce
JOIN "COM_SAP_DEVELOPERS_IMS_CONCEPTS" src ON src.ID = ce.SOURCE_ID
JOIN "COM_SAP_DEVELOPERS_IMS_CONCEPTS" tgt ON tgt.ID = ce.TARGET_ID
WHERE ce.PREDICATE = 'relatedTo' AND ce.STATUS = 'ACTIVE'
  AND src.STATUS = 'ACTIVE' AND tgt.STATUS = 'ACTIVE'
```

### 2. `extends` (tutorial → tutorial)

From `TutorialConceptLinks` where `predicate = 'extends'`; the target is
`extendsTutorial_ID`, not `concept_ID`:

```sql
SELECT
  CAST('ext|' || src.SLUG || '|' || tgt.SLUG AS NVARCHAR(600)) AS "EDGE_KEY",
  CAST('tutorial:' || src.SLUG AS NVARCHAR(280))               AS "SOURCE",
  CAST('tutorial:' || tgt.SLUG AS NVARCHAR(280))               AS "TARGET",
  'extends'                                                    AS "EDGE_TYPE"
FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS" tcl
JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" src ON src.ID = tcl.TUTORIAL_ID
JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" tgt ON tgt.ID = tcl.EXTENDSTUTORIAL_ID
WHERE tcl.PREDICATE = 'extends'
  AND tcl.EXTENDSTUTORIAL_ID IS NOT NULL
```

### 3. `partOf` — tutorial → mission

Via `CompletionPathItems` (path items) → `CompletionPaths` (paths) →
`Missions`. Requires filtering NULL `tutorial_ID` (checkpoint / group items):

```sql
SELECT DISTINCT
  CAST('po|' || t.SLUG || '|' || m.SLUG AS NVARCHAR(600))  AS "EDGE_KEY",
  CAST('tutorial:' || t.SLUG AS NVARCHAR(280))             AS "SOURCE",
  CAST('mission:'  || m.SLUG AS NVARCHAR(280))             AS "TARGET",
  'partOf'                                                 AS "EDGE_TYPE"
FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS" cpi
JOIN "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS" cp ON cp.ID = cpi.PATH_ID
JOIN "COM_SAP_DEVELOPERS_IMS_MISSIONS" m ON m.ID = cp.MISSION_ID
JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t ON t.ID = cpi.TUTORIAL_ID
WHERE cpi.TUTORIAL_ID IS NOT NULL
```

DISTINCT because the same tutorial can appear in multiple paths of the same
mission via variant paths.

### 4. `partOf` — mission → group

Missions carry a direct FK to Groups:

```sql
SELECT
  CAST('po|' || m.SLUG || '|' || g.SLUG AS NVARCHAR(600)) AS "EDGE_KEY",
  CAST('mission:' || m.SLUG AS NVARCHAR(280))             AS "SOURCE",
  CAST('group:'   || g.SLUG AS NVARCHAR(280))             AS "TARGET",
  'partOf'                                                AS "EDGE_TYPE"
FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS" m
JOIN "COM_SAP_DEVELOPERS_IMS_GROUPS" g ON g.ID = m.GROUP_ID
WHERE m.GROUP_ID IS NOT NULL
```

Both arms label their `EDGE_TYPE` as `'partOf'` per Q6.

### 5. `taggedWith` (tutorial → tag)

Via `TutorialTags` join table. Tag identity is `Tags.name`:

```sql
SELECT
  CAST('tw|' || t.SLUG || '|' || tg.NAME AS NVARCHAR(600)) AS "EDGE_KEY",
  CAST('tutorial:' || t.SLUG AS NVARCHAR(280))             AS "SOURCE",
  CAST('tag:'      || tg.NAME AS NVARCHAR(280))            AS "TARGET",
  'taggedWith'                                             AS "EDGE_TYPE"
FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALTAGS" tt
JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t ON t.ID = tt.TUTORIAL_ID
JOIN "COM_SAP_DEVELOPERS_IMS_TAGS" tg ON tg.ID = tt.TAG_ID
WHERE tg.NAME IS NOT NULL
```

### 6. `aboutProduct` (tutorial → product)

Subset of `taggedWith` where `Tags.name LIKE 'software-product>%'`. Product
slug is the suffix after the prefix:

```sql
SELECT
  CAST('ap|' || t.SLUG || '|' ||
    SUBSTRING(tg.NAME, LENGTH('software-product>') + 1) AS NVARCHAR(600))
                                                                AS "EDGE_KEY",
  CAST('tutorial:' || t.SLUG AS NVARCHAR(280))                  AS "SOURCE",
  CAST('product:'  || SUBSTRING(tg.NAME, LENGTH('software-product>') + 1)
                                             AS NVARCHAR(280))  AS "TARGET",
  'aboutProduct'                                                AS "EDGE_TYPE"
FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALTAGS" tt
JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t ON t.ID = tt.TUTORIAL_ID
JOIN "COM_SAP_DEVELOPERS_IMS_TAGS" tg ON tg.ID = tt.TAG_ID
WHERE tg.NAME LIKE 'software-product>%'
```

`SUBSTRING(x, LENGTH(prefix)+1)` is the HANA-portable "everything after the
prefix" idiom. HANA uses 1-based indexing.

### 7. `inCategory` (mission → category)

Via `MissionCategories` join table:

```sql
SELECT
  CAST('ic|' || m.SLUG || '|' || c.SLUG AS NVARCHAR(600)) AS "EDGE_KEY",
  CAST('mission:'  || m.SLUG AS NVARCHAR(280))            AS "SOURCE",
  CAST('category:' || c.SLUG AS NVARCHAR(280))            AS "TARGET",
  'inCategory'                                            AS "EDGE_TYPE"
FROM "COM_SAP_DEVELOPERS_IMS_MISSIONCATEGORIES" mc
JOIN "COM_SAP_DEVELOPERS_IMS_MISSIONS" m ON m.ID = mc.MISSION_ID
JOIN "COM_SAP_DEVELOPERS_IMS_CATEGORIES" c ON c.ID = mc.CATEGORY_ID
```

RDF projection only emits Mission→Category; #919 mirrors that exactly.
`TutorialCategories` exists but is NOT projected either side.

### 8. `coCompletedWith` (tutorial → tutorial, both directions)

`CoCompletions` stores slugs inline (no JOINs) and stores each pair twice
(A→B and B→A). The k-anonymity gate (`score >= 10`) that RDF projection
applies at `kg-projection.js:466-479` must be replicated here so raw pair
counts below the threshold never leak into the property graph:

```sql
SELECT
  CAST('cc|' || SOURCESLUG || '|' || TARGETSLUG AS NVARCHAR(600)) AS "EDGE_KEY",
  CAST('tutorial:' || SOURCESLUG AS NVARCHAR(280))                AS "SOURCE",
  CAST('tutorial:' || TARGETSLUG AS NVARCHAR(280))                AS "TARGET",
  'coCompletedWith'                                               AS "EDGE_TYPE"
FROM "COM_SAP_DEVELOPERS_IMS_COCOMPLETIONS"
WHERE SCORE >= 10
```

## Vertex-view additions

`KG_PG_VERTICES_V` gains 5 UNION-ALL arms. Existing 2 arms (concept, tutorial)
are unchanged.

### mission

```sql
SELECT
  CAST('mission:' || SLUG AS NVARCHAR(280)) AS "VERTEX_KEY",
  'mission'                                 AS "VERTEX_TYPE",
  SLUG                                      AS "SLUG",
  TITLE                                     AS "LABEL",
  'ACTIVE'                                  AS "STATUS"
FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS"
WHERE SLUG IS NOT NULL
```

Missions have no `STATUS` column in the current schema — emit constant
`'ACTIVE'` to match the shape of other vertex arms.

### group

```sql
SELECT
  CAST('group:' || SLUG AS NVARCHAR(280)) AS "VERTEX_KEY",
  'group'                                 AS "VERTEX_TYPE",
  SLUG                                    AS "SLUG",
  TITLE                                   AS "LABEL",
  'ACTIVE'                                AS "STATUS"
FROM "COM_SAP_DEVELOPERS_IMS_GROUPS"
WHERE SLUG IS NOT NULL
```

### tag

```sql
SELECT DISTINCT
  CAST('tag:' || NAME AS NVARCHAR(280)) AS "VERTEX_KEY",
  'tag'                                 AS "VERTEX_TYPE",
  NAME                                  AS "SLUG",
  LABEL                                 AS "LABEL",
  'ACTIVE'                              AS "STATUS"
FROM "COM_SAP_DEVELOPERS_IMS_TAGS"
WHERE NAME IS NOT NULL
```

DISTINCT because `Tags.name` has no `@assert.unique` — the exploration flagged
this as a known dup-risk RDF also lives with. DISTINCT is defense-in-depth so
`KG_PG_EDGES_V.TARGET` never joins to two vertex rows for the same tag.

### product

Synthesized from tags with the `software-product>` prefix:

```sql
SELECT DISTINCT
  CAST('product:' || SUBSTRING(NAME, LENGTH('software-product>') + 1)
                              AS NVARCHAR(280)) AS "VERTEX_KEY",
  'product'                                     AS "VERTEX_TYPE",
  SUBSTRING(NAME, LENGTH('software-product>') + 1) AS "SLUG",
  LABEL                                         AS "LABEL",
  'ACTIVE'                                      AS "STATUS"
FROM "COM_SAP_DEVELOPERS_IMS_TAGS"
WHERE NAME LIKE 'software-product>%'
```

### category

```sql
SELECT
  CAST('category:' || SLUG AS NVARCHAR(280)) AS "VERTEX_KEY",
  'category'                                 AS "VERTEX_TYPE",
  SLUG                                       AS "SLUG",
  LABEL                                      AS "LABEL",
  'ACTIVE'                                   AS "STATUS"
FROM "COM_SAP_DEVELOPERS_IMS_CATEGORIES"
WHERE SLUG IS NOT NULL
```

Categories are seeded via CSV; slugs are stable and mandatory (`db/schema.cds:265`).

## Implementation prerequisite — column-name probe

CDS generates FK column names from Association names in an inflection that
occasionally differs from expectation (e.g. `extendsTutorial` may become
`EXTENDSTUTORIAL_ID` or `EXTENDS_TUTORIAL_ID`). Before writing the view
SQL, the plan's Task 0 verifies exact HANA-side column names for the four
non-trivial FKs:

- `TutorialConceptLinks.extendsTutorial` → `EXTENDSTUTORIAL_ID` or `EXTENDS_TUTORIAL_ID`?
- `CompletionPathItems.tutorial`         → `TUTORIAL_ID` (probable)
- `CompletionPathItems.path`             → `PATH_ID` (probable)
- `Missions.group`                       → `GROUP_ID` (probable)

Probe via `hana-cli inspectTable --schema '**CURRENT_SCHEMA**' --table
<TableName>`; record actuals in the Task 0 notes file. All view SQL uses
these confirmed names.

## Error handling & rollback

**Deploy-time failures.** HDI deploy fails if any UNION arm has a type or
sizing mismatch. The `EDGE_KEY` widening to 600 is the primary risk; if the
workspace declaration or downstream procedures pin the type to 400, they
must widen too. Task 0 of the plan verifies with a probe deploy.

**Runtime failures.** Views are read-only — no mutation surface. If a JOIN
returns unexpectedly many rows (e.g. `taggedWith` explodes with a duplicate
tag-name), the graph engine sees more edges than expected but doesn't fail.
Downstream algorithms (#916 / #917 / #918) are the ones that would observe
performance regression.

**Rollback.** Revert the two view files and redeploy. Downstream procedures
continue to work — they read the same view names with fewer arms. No data
touched. Reverting is git-blameable in one commit.

## Testing

### Hybrid test — `test/hybrid/kg-workspace-widening.test.js`

**Fixture.** Seed one row of each new predicate under a `__TEST__kg-w9-<runId>-`
prefix. Existing `requires` and `teaches` arms already covered by
`kg-graph-rebuild.test.js`; this test covers only the 7 new arms.

Seed sequence (FK-safe):

1. `Concepts` — 2 concepts (`hub`, `related`) for `relatedTo`.
2. `Tutorials` — 3 tutorials (`t1`, `t2`, `t3`).
3. `TutorialConceptLinks` — one `extends` row: `t1` extends `t2`.
4. `ConceptEdges` — one `relatedTo` row: `hub` relatedTo `related`.
5. `Groups` — one group `g1`.
6. `Missions` — one mission `m1` with `group_ID = g1`.
7. `CompletionPaths` — one path `p1` under `m1`.
8. `CompletionPathItems` — one item linking `t1` to `p1`.
9. `Tags` — two tags: `regular-tag` and `software-product>example-product`.
10. `TutorialTags` — link `t1` to both tags.
11. `Categories` — one category `c1` (may already exist in seed data — filter).
12. `MissionCategories` — one row linking `m1` to `c1`.
13. `CoCompletions` — one row with `score = 15` (above k-anon threshold) and
    one row with `score = 5` (below, negative-path assertion).

**Assertions:**

```js
const edgeTypes = await db.run(
  `SELECT DISTINCT EDGE_TYPE FROM "KG_PG_EDGES_V"
     WHERE SOURCE LIKE '%__test__kg-w9-${runId}-%'
        OR TARGET LIKE '%__test__kg-w9-${runId}-%'`
);
const set = new Set(edgeTypes.map(r => r.EDGE_TYPE));
expect(set.has('relatedTo')).toBe(true);
expect(set.has('extends')).toBe(true);
expect(set.has('partOf')).toBe(true);
expect(set.has('taggedWith')).toBe(true);
expect(set.has('aboutProduct')).toBe(true);
expect(set.has('inCategory')).toBe(true);
expect(set.has('coCompletedWith')).toBe(true);
// requires/teaches inherit from existing coverage; not asserted here.
```

Vertex-side assertions:

```js
const vertexTypes = await db.run(
  `SELECT DISTINCT VERTEX_TYPE FROM "KG_PG_VERTICES_V"
     WHERE VERTEX_KEY LIKE '%__test__kg-w9-${runId}-%'
        OR SLUG LIKE '__test__kg-w9-${runId}-%'
        OR SLUG = 'software-product>__test__kg-w9-${runId}-example-product'`
);
const vset = new Set(vertexTypes.map(r => r.VERTEX_TYPE));
expect(vset.has('mission')).toBe(true);
expect(vset.has('group')).toBe(true);
expect(vset.has('tag')).toBe(true);
expect(vset.has('product')).toBe(true);
// `category` vertices come from the CSV-seeded Categories table (8 rows),
// not from fixture inserts. Verify presence with an unfiltered check:
const cats = await db.run(
  `SELECT COUNT(*) AS N FROM "KG_PG_VERTICES_V" WHERE VERTEX_TYPE = 'category'`
);
expect(cats[0].N).toBeGreaterThan(0);
```

K-anonymity negative-path assertion:

```js
const belowThreshold = await db.run(
  `SELECT COUNT(*) AS N FROM "KG_PG_EDGES_V"
     WHERE EDGE_TYPE = 'coCompletedWith'
       AND (SOURCE = 'tutorial:__test__kg-w9-${runId}-tA'
            AND TARGET = 'tutorial:__test__kg-w9-${runId}-tB')`
);
// The score=5 fixture pair should NOT appear.
expect(belowThreshold[0].N).toBe(0);
```

**Teardown.** FK-safe reverse order: `TutorialTags`, `CompletionPathItems`,
`CompletionPaths`, `MissionCategories`, `Missions`, `Groups`,
`TutorialConceptLinks`, `ConceptEdges`, `CoCompletions`, `Tags`, `Tutorials`,
`Concepts`.

### Existing tests

`test/hybrid/kg-graph-rebuild.test.js` and `test/hybrid/kg-path-v2.test.js` MUST
continue to pass unchanged — the view widening is additive.

## Rollout

1. **Merge** — view-only change. Land the two view file edits + one test in a
   single PR. CI hybrid test proves 9 predicates present.
2. **Deploy to DEV** — normal MTA deploy from the main worktree (`cf target -s dev`).
3. **Post-deploy verification** — one manual `SELECT DISTINCT EDGE_TYPE FROM
   KG_PG_EDGES_V` on DEV; confirm all 9. `SELECT COUNT(*) FROM KG_PG_EDGES_V`
   to compare pre-widen (~8k) vs post-widen (upper bound ~60-80k, actual
   likely much lower after k-anon and low tag density).
4. **Regression check** — run existing hybrid KG tests against DEV
   (`npm run test:hybrid` with the relevant filter). No test should have to
   change.
5. **Perf sanity** — call `KG_PATH_V2` on a known concept pair pre-widen vs
   post-widen; latency delta should be small (<20%). If large, note it as a
   follow-up for materialization consideration but don't block #916.
6. **Unblock downstream** — comment on #916, #917, #918 that the prereq has
   landed on DEV.
7. **PROD** — out of scope. Follows the same DEV-only fence as #913.

### Success criteria

- All 9 predicates return non-zero rows from `KG_PG_EDGES_V` on DEV after deploy.
- All 5 new vertex types return non-zero rows from `KG_PG_VERTICES_V` on DEV
  after deploy.
- No existing KG hybrid test needs modification.
- `KG_PATH_V2` latency does not regress > 20% on a smoke query.

## Non-goals

- No RDF-side change — property-graph is the follower here, RDF stays as-is.
- No `graphRebuild()` change.
- No materialization — deferred.
- No `@assert.unique.name` on `Tags` — deferred (would require dup cleanup).
- No `TutorialCategories` projection — RDF doesn't project it; property
  graph mirrors RDF.

## Red flags surfaced during exploration (all addressed)

- **`Tags.name` nullable, no unique constraint** — addressed by `WHERE NAME IS
  NOT NULL` + `SELECT DISTINCT` on the vertex arm. Accepted parity with RDF.
- **`EDGE_KEY 400` overflow** — addressed by widening to 600.
- **`CompletionPathItems.tutorial_ID` NULL for checkpoint/group items** —
  addressed by `WHERE cpi.TUTORIAL_ID IS NOT NULL`.
- **`coCompletedWith` k-anonymity leak** — addressed by `WHERE SCORE >= 10`
  matching RDF's projection-side gate.
- **`aboutProduct` synthesized identity** — addressed by consistent `SUBSTRING`
  extraction on both edge and vertex sides.
