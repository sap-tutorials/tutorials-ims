# KG_PG_WORKSPACE 9-Predicate Widening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `KG_PG_EDGES_V` and `KG_PG_VERTICES_V` from 2 to 9 predicates / 2 to 7 vertex types so downstream algorithms (#916 PageRank, #917 community detection, #918 WCC) can see the full RDF graph.

**Architecture:** Two view files change; the workspace declaration is unchanged. `KG_PG_VERTICES_V` gains 5 UNION-ALL arms for the new vertex types (`mission`, `group`, `tag`, `product`, `category`). `KG_PG_EDGES_V` gains 7 UNION-ALL arms (`relatedTo`, `extends`, `partOf`×2, `taggedWith`, `aboutProduct`, `inCategory`, `coCompletedWith`) and widens `EDGE_KEY` from `NVARCHAR(400)` to `NVARCHAR(600)` to cover tag-composite worst case (513 chars). K-anonymity gate `WHERE SCORE >= 10` on `coCompletedWith` preserves the projection-side protection RDF applies.

**Tech Stack:** HANA Cloud (property-graph engine, HDI views), SAP CAP-generated table names (`COM_SAP_DEVELOPERS_IMS_<ENTITY>`), Vitest (hybrid workspace test).

**Design spec:** [`docs/superpowers/specs/2026-07-04-919-kg-workspace-widening-design.md`](../specs/2026-07-04-919-kg-workspace-widening-design.md)

**Issue:** [#919](https://github.com/sap-tutorials/tutorials-ims/issues/919). **Parent spike:** [#913](https://github.com/sap-tutorials/tutorials-ims/issues/913). **Unblocks:** [#916](https://github.com/sap-tutorials/tutorials-ims/issues/916), [#917](https://github.com/sap-tutorials/tutorials-ims/issues/917), [#918](https://github.com/sap-tutorials/tutorials-ims/issues/918).

## Global Constraints

- **Scope:** DEV-only per #913 non-goals. No PROD rollout.
- **View-only:** no schema changes, no new physical tables, no `graphRebuild()` changes, no workspace-declaration changes.
- **Sizing:** `EDGE_KEY` widens `NVARCHAR(400)` → `NVARCHAR(600)`. `VERTEX_KEY` stays `NVARCHAR(280)`.
- **RDF-parity:** every projection decision mirrors what `srv/lib/kg-projection.js` already emits. No new predicate semantics.
- **K-anonymity:** `coCompletedWith` arm MUST filter `WHERE SCORE >= 10` — same threshold RDF projection uses at `srv/lib/kg-projection.js:466-479`.
- **NULL safety:** `CompletionPathItems.tutorial_ID` and `Missions.group_ID` can be NULL — filter each arm's SQL accordingly.
- **DISTINCT usage:** `taggedWith`, `partOf` (tutorial→mission), and the `tag`/`product` vertex arms use `SELECT DISTINCT` to defend against RDF-projection duplication.
- **QA-channel duality:** views may or may not be shadowed by `db-qa/src/views/`. Task 0.5 verifies and dictates whether the QA-side needs mirroring.
- **Table names:** all raw SQL uses the HDI-flattened form `"COM_SAP_DEVELOPERS_IMS_<ENTITY>"` in uppercase (verified in Task 0.4).

---

## File Structure

**Modified files (2):**
- `db/src/views/KG_PG_VERTICES_V.hdbview` — add 5 vertex-type arms; keep 2 existing.
- `db/src/views/KG_PG_EDGES_V.hdbview` — add 7 edge arms; widen `EDGE_KEY` to 600; keep 2 existing.

**Possibly modified (verified in Task 0.5):**
- `db-qa/src/views/KG_PG_VERTICES_V.hdbview` — only if the QA channel shadows this file.
- `db-qa/src/views/KG_PG_EDGES_V.hdbview` — same conditional.

**New files (2):**
- `test/hybrid/kg-workspace-widening.test.js` — hybrid fixture asserting all 9 predicates + 5 new vertex types present.
- `docs/superpowers/reviews/2026-07-04-919-kg-workspace-widening-task0-notes.md` — Task 0 probe notes (column names, QA-mirror decision, deploy verification).

**Unchanged:**
- `db/src/graph/KG_PG_WORKSPACE.hdbgraphworkspace` — the plugin infers types from view columns.
- `db/knowledge-graph.cds` — schema unchanged.
- `srv/lib/kg-graph-rebuild.js`, `srv/lib/kg-projection.js`, `srv/lib/kg-sparql-client.js`.
- All existing HANA procedures (`KG_QUERY`, `KG_PATH_V2`, `KG_SHORTEST_PATH_GRAPH`, `KG_ADMIN_RUNSPARQL`, `KG_GRAPH_CLEAR`, `KG_GRAPH_INSERT`).

---

## Task 0: Probe HANA column names + QA-mirror decision

**Goal:** Confirm the exact HANA-side column names CDS generated for the four non-trivial FKs, and decide whether `db-qa/src/views/` shadows these files.

**Files:**
- Create: `docs/superpowers/reviews/2026-07-04-919-kg-workspace-widening-task0-notes.md`

**Prerequisites:**
- `hana-cli` authenticated against the DEV HDI container.

- [ ] **Step 0.1: Confirm `TutorialConceptLinks.extendsTutorial_ID` column name.**

Run:

```bash
hana-cli inspectTable --schema '**CURRENT_SCHEMA**' --table 'com.sap.developers.ims.TutorialConceptLinks'
```

Look for a column starting with `EXTENDSTUTORIAL` or `EXTENDS_TUTORIAL`. Record the exact form in the notes file — this is the FK the `extends` edge arm reads.

- [ ] **Step 0.2: Confirm `CompletionPathItems` FK column names.**

```bash
hana-cli inspectTable --schema '**CURRENT_SCHEMA**' --table 'com.sap.developers.ims.CompletionPathItems'
```

Expected: `TUTORIAL_ID` and `PATH_ID`. Record actuals.

- [ ] **Step 0.3: Confirm `Missions.group_ID` column name.**

```bash
hana-cli inspectTable --schema '**CURRENT_SCHEMA**' --table 'com.sap.developers.ims.Missions'
```

Expected: `GROUP_ID`. Record actual.

- [ ] **Step 0.4: Confirm HDI-flattened table naming convention.**

```bash
hana-cli tables --table 'com.sap.developers.ims.*' | head -30
```

Expected form: `COM_SAP_DEVELOPERS_IMS_<ENTITY>` (dots collapsed to underscores, uppercase). Confirm this is the form used in the existing `KG_PG_EDGES_V.hdbview` (already using `"COM_SAP_DEVELOPERS_IMS_CONCEPTS"` etc.). Any deviation invalidates the view SQL in later tasks.

- [ ] **Step 0.5: Determine whether QA channel shadows these view files.**

```bash
ls db-qa/src/views/ 2>&1
```

If `KG_PG_VERTICES_V.hdbview` and `KG_PG_EDGES_V.hdbview` exist under `db-qa/src/views/`, they need parallel edits (Task 6 conditional). If they don't exist, the QA HDI reads a shared source — no QA-side edit needed.

Record the decision (`QA_MIRROR: yes` or `QA_MIRROR: no`) in the notes file. Task 6 branches on this value.

- [ ] **Step 0.6: Commit the notes file.**

```bash
git add docs/superpowers/reviews/2026-07-04-919-kg-workspace-widening-task0-notes.md
git commit -m "docs(#919): task 0 notes — HANA column names + QA-mirror decision"
```

---

## Task 1: Widen `EDGE_KEY` sizing (defensive first commit)

**Goal:** Change `EDGE_KEY NVARCHAR(400)` to `NVARCHAR(600)` in the existing view file and update the sizing comment. Deploy this alone so we prove the workspace declaration accepts the wider type before adding 7 new arms.

**Files:**
- Modify: `db/src/views/KG_PG_EDGES_V.hdbview`

**Interfaces:**
- Produces: view `KG_PG_EDGES_V` with `EDGE_KEY NVARCHAR(600)`, still 2 UNION-ALL arms (unchanged content).

- [ ] **Step 1.1: Update sizing comment at the top of `db/src/views/KG_PG_EDGES_V.hdbview`.**

Replace the block starting `-- EDGE_KEY sizing (NVARCHAR(400)):` with:

```
  -- EDGE_KEY sizing (NVARCHAR(600)): the composite is 'type-prefix|source-slug|target-slug'.
  --   Widest arms post-#919 are `taggedWith` and `aboutProduct`, both of which include
  --   tutorial-slug(≤255) and tag-name(≤255):
  --     taggedWith: 'tw|' + 255 + '|' + 255            = 513 chars
  --     aboutProduct: 'ap|' + 255 + '|' + product-suffix(≤240)  ≈ 500 chars
  --   NVARCHAR(600) gives modest headroom for future arms. Prior to #919 the ceiling
  --   was 400; widened here in defensive isolation before the 7 new UNION-ALL arms
  --   land in a separate commit.
```

- [ ] **Step 1.2: Update every `CAST(... AS NVARCHAR(400)) AS "EDGE_KEY"` to `NVARCHAR(600)`.**

There are 2 occurrences in the current file (one per existing arm). Both change identically:

```
  CAST('r|' || src.SLUG || '|' || tgt.SLUG AS NVARCHAR(600)) AS "EDGE_KEY",
```

and:

```
  CAST('t|' || t.SLUG || '|' || c.SLUG AS NVARCHAR(600)) AS "EDGE_KEY",
```

- [ ] **Step 1.3: Verify with `cds build`.**

```bash
npx cds build --production
```

Expected: no build errors. The generated `.hdbview` should end up under `gen/db/src/gen/`.

- [ ] **Step 1.4: Commit.**

```bash
git add db/src/views/KG_PG_EDGES_V.hdbview
git commit -m "chore(#919): widen KG_PG_EDGES_V.EDGE_KEY to NVARCHAR(600)"
```

---

## Task 2: Add `relatedTo` and `extends` edge arms

**Goal:** Land the two "same-shape" arms first — both are minor variations on existing patterns (`relatedTo` mirrors `requires`; `extends` mirrors `teaches`).

**Files:**
- Modify: `db/src/views/KG_PG_EDGES_V.hdbview`

**Interfaces:**
- Consumes: `TutorialConceptLinks.EXTENDSTUTORIAL_ID` column name (verified Task 0.1).
- Produces: `KG_PG_EDGES_V` now emits `EDGE_TYPE IN ('requires','teaches','relatedTo','extends')`.

- [ ] **Step 2.1: Append `relatedTo` arm.**

Add after the existing `teaches` arm, before the terminating `;`:

```sql
  UNION ALL
  -- relatedTo edges: concept → concept. Same source table as `requires`.
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

- [ ] **Step 2.2: Append `extends` arm.**

Add after the `relatedTo` arm (replace `<EXTENDS_FK>` with the exact column name recorded in Task 0.1):

```sql
  UNION ALL
  -- extends edges: tutorial → tutorial. Uses TutorialConceptLinks with
  -- predicate='extends' and the extendsTutorial FK (concept FK is NULL
  -- in this predicate — schema invariant at db/knowledge-graph.cds:44).
  SELECT
    CAST('ext|' || src.SLUG || '|' || tgt.SLUG AS NVARCHAR(600)) AS "EDGE_KEY",
    CAST('tutorial:' || src.SLUG AS NVARCHAR(280))               AS "SOURCE",
    CAST('tutorial:' || tgt.SLUG AS NVARCHAR(280))               AS "TARGET",
    'extends'                                                    AS "EDGE_TYPE"
  FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS" tcl
  JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" src ON src.ID = tcl.TUTORIAL_ID
  JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" tgt ON tgt.ID = tcl.<EXTENDS_FK>
  WHERE tcl.PREDICATE = 'extends'
    AND tcl.<EXTENDS_FK> IS NOT NULL
```

- [ ] **Step 2.3: Build and commit.**

```bash
npx cds build --production
git add db/src/views/KG_PG_EDGES_V.hdbview
git commit -m "feat(#919): add relatedTo + extends edge arms to KG_PG_EDGES_V"
```

---

## Task 3: Add `partOf` arms (tutorial→mission, mission→group)

**Goal:** Both arms carry `EDGE_TYPE = 'partOf'` per Q6 (RDF-parity, single predicate visible to algorithms).

**Files:**
- Modify: `db/src/views/KG_PG_EDGES_V.hdbview`

**Interfaces:**
- Consumes: `CompletionPathItems.TUTORIAL_ID`, `CompletionPathItems.PATH_ID`, `Missions.GROUP_ID` (verified Task 0.2, 0.3).

- [ ] **Step 3.1: Append tutorial→mission `partOf` arm.**

```sql
  UNION ALL
  -- partOf (tutorial → mission) via CompletionPathItems -> CompletionPaths -> Missions.
  -- tutorial_ID is NULL for CHECKPOINT/GROUP items — filter. DISTINCT because
  -- variant paths of the same mission can list a tutorial more than once.
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
    AND t.SLUG IS NOT NULL AND m.SLUG IS NOT NULL
```

- [ ] **Step 3.2: Append mission→group `partOf` arm.**

```sql
  UNION ALL
  -- partOf (mission → group) via Missions.group_ID FK.
  SELECT
    CAST('po|' || m.SLUG || '|' || g.SLUG AS NVARCHAR(600)) AS "EDGE_KEY",
    CAST('mission:' || m.SLUG AS NVARCHAR(280))             AS "SOURCE",
    CAST('group:'   || g.SLUG AS NVARCHAR(280))             AS "TARGET",
    'partOf'                                                AS "EDGE_TYPE"
  FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS" m
  JOIN "COM_SAP_DEVELOPERS_IMS_GROUPS" g ON g.ID = m.GROUP_ID
  WHERE m.GROUP_ID IS NOT NULL
    AND m.SLUG IS NOT NULL AND g.SLUG IS NOT NULL
```

- [ ] **Step 3.3: Build and commit.**

```bash
npx cds build --production
git add db/src/views/KG_PG_EDGES_V.hdbview
git commit -m "feat(#919): add partOf edge arms (tutorial->mission, mission->group)"
```

---

## Task 4: Add `taggedWith`, `aboutProduct`, `inCategory` arms

**Goal:** The three tag/category arms in one commit — they share `Tags`/`Categories` join semantics.

**Files:**
- Modify: `db/src/views/KG_PG_EDGES_V.hdbview`

- [ ] **Step 4.1: Append `taggedWith` arm.**

```sql
  UNION ALL
  -- taggedWith (tutorial → tag). Tag identity is Tags.name (no dedicated
  -- slug column — RDF projection at srv/lib/kg-projection.js:1027-1028
  -- uses NAME for the same reason). Filter NULL names.
  SELECT
    CAST('tw|' || t.SLUG || '|' || tg.NAME AS NVARCHAR(600)) AS "EDGE_KEY",
    CAST('tutorial:' || t.SLUG AS NVARCHAR(280))             AS "SOURCE",
    CAST('tag:'      || tg.NAME AS NVARCHAR(280))            AS "TARGET",
    'taggedWith'                                             AS "EDGE_TYPE"
  FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALTAGS" tt
  JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t ON t.ID = tt.TUTORIAL_ID
  JOIN "COM_SAP_DEVELOPERS_IMS_TAGS" tg ON tg.ID = tt.TAG_ID
  WHERE tg.NAME IS NOT NULL AND t.SLUG IS NOT NULL
```

- [ ] **Step 4.2: Append `aboutProduct` arm.**

Note: `LENGTH('software-product>') + 1 = 18` (the substring starts at position 18, one past the `>`). Using the literal 18 avoids repeating `LENGTH(...)` twice in one CAST:

```sql
  UNION ALL
  -- aboutProduct (tutorial → product). Products are synthesized from tags
  -- named 'software-product>...'. Substring starts at position 18 (past
  -- the 17-char 'software-product>' prefix). RDF projection does the same
  -- at srv/lib/kg-projection.js:305-310.
  SELECT
    CAST('ap|' || t.SLUG || '|' || SUBSTRING(tg.NAME, 18) AS NVARCHAR(600)) AS "EDGE_KEY",
    CAST('tutorial:' || t.SLUG AS NVARCHAR(280))                            AS "SOURCE",
    CAST('product:'  || SUBSTRING(tg.NAME, 18) AS NVARCHAR(280))            AS "TARGET",
    'aboutProduct'                                                          AS "EDGE_TYPE"
  FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALTAGS" tt
  JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t ON t.ID = tt.TUTORIAL_ID
  JOIN "COM_SAP_DEVELOPERS_IMS_TAGS" tg ON tg.ID = tt.TAG_ID
  WHERE tg.NAME LIKE 'software-product>%'
    AND t.SLUG IS NOT NULL
```

- [ ] **Step 4.3: Append `inCategory` arm.**

```sql
  UNION ALL
  -- inCategory (mission → category) via MissionCategories junction.
  -- RDF only emits Mission->Category; TutorialCategories exists but is
  -- not projected either side (mirrored here for parity).
  SELECT
    CAST('ic|' || m.SLUG || '|' || c.SLUG AS NVARCHAR(600)) AS "EDGE_KEY",
    CAST('mission:'  || m.SLUG AS NVARCHAR(280))            AS "SOURCE",
    CAST('category:' || c.SLUG AS NVARCHAR(280))            AS "TARGET",
    'inCategory'                                            AS "EDGE_TYPE"
  FROM "COM_SAP_DEVELOPERS_IMS_MISSIONCATEGORIES" mc
  JOIN "COM_SAP_DEVELOPERS_IMS_MISSIONS" m ON m.ID = mc.MISSION_ID
  JOIN "COM_SAP_DEVELOPERS_IMS_CATEGORIES" c ON c.ID = mc.CATEGORY_ID
  WHERE m.SLUG IS NOT NULL AND c.SLUG IS NOT NULL
```

- [ ] **Step 4.4: Build and commit.**

```bash
npx cds build --production
git add db/src/views/KG_PG_EDGES_V.hdbview
git commit -m "feat(#919): add taggedWith, aboutProduct, inCategory edge arms"
```

---

## Task 5: Add `coCompletedWith` arm (with k-anonymity gate)

**Goal:** The last edge arm. K-anonymity `WHERE SCORE >= 10` MUST match `kg-projection.js:466-479`.

**Files:**
- Modify: `db/src/views/KG_PG_EDGES_V.hdbview`

- [ ] **Step 5.1: Append `coCompletedWith` arm.**

```sql
  UNION ALL
  -- coCompletedWith (tutorial → tutorial). Stored twice in CoCompletions
  -- (A→B AND B→A) so both directions emit naturally. K-anonymity gate
  -- SCORE >= 10 mirrors the RDF projection's k=10 threshold at
  -- srv/lib/kg-projection.js:466-479 — raw pair counts below the
  -- threshold must never reach the property graph.
  SELECT
    CAST('cc|' || SOURCESLUG || '|' || TARGETSLUG AS NVARCHAR(600)) AS "EDGE_KEY",
    CAST('tutorial:' || SOURCESLUG AS NVARCHAR(280))                AS "SOURCE",
    CAST('tutorial:' || TARGETSLUG AS NVARCHAR(280))                AS "TARGET",
    'coCompletedWith'                                               AS "EDGE_TYPE"
  FROM "COM_SAP_DEVELOPERS_IMS_COCOMPLETIONS"
  WHERE SCORE >= 10
    AND SOURCESLUG IS NOT NULL AND TARGETSLUG IS NOT NULL
```

Verify the terminating `;` is now at the end of the file. All arms should be UNION-ALL-linked.

- [ ] **Step 5.2: Build and commit.**

```bash
npx cds build --production
git add db/src/views/KG_PG_EDGES_V.hdbview
git commit -m "feat(#919): add coCompletedWith edge arm with k>=10 gate"
```

---

## Task 6: Widen `KG_PG_VERTICES_V` with 5 new vertex types

**Goal:** Add `mission`, `group`, `tag`, `product`, `category` vertex arms so edge endpoints resolve.

**Files:**
- Modify: `db/src/views/KG_PG_VERTICES_V.hdbview`

**Interfaces:**
- Produces: `KG_PG_VERTICES_V` now emits `VERTEX_TYPE IN ('concept','tutorial','mission','group','tag','product','category')`.

- [ ] **Step 6.1: Append `mission` arm.**

Add after the existing `tutorial` arm, before the terminating `;`:

```sql
  UNION ALL
  -- Mission vertices. Missions have no STATUS column in the current
  -- schema — emit constant 'ACTIVE' to match the vertex-arm shape.
  SELECT
    CAST('mission:' || SLUG AS NVARCHAR(280)) AS "VERTEX_KEY",
    'mission'                                 AS "VERTEX_TYPE",
    SLUG                                      AS "SLUG",
    TITLE                                     AS "LABEL",
    'ACTIVE'                                  AS "STATUS"
  FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS"
  WHERE SLUG IS NOT NULL
```

- [ ] **Step 6.2: Append `group` arm.**

```sql
  UNION ALL
  -- Group vertices.
  SELECT
    CAST('group:' || SLUG AS NVARCHAR(280)) AS "VERTEX_KEY",
    'group'                                 AS "VERTEX_TYPE",
    SLUG                                    AS "SLUG",
    TITLE                                   AS "LABEL",
    'ACTIVE'                                AS "STATUS"
  FROM "COM_SAP_DEVELOPERS_IMS_GROUPS"
  WHERE SLUG IS NOT NULL
```

- [ ] **Step 6.3: Append `tag` arm.**

```sql
  UNION ALL
  -- Tag vertices. Tags have no dedicated slug column — RDF and the
  -- taggedWith edge arm both use NAME as the identifier. DISTINCT
  -- because Tags.name has no @assert.unique (dup-risk RDF also lives
  -- with). Filter NULL names.
  SELECT DISTINCT
    CAST('tag:' || NAME AS NVARCHAR(280)) AS "VERTEX_KEY",
    'tag'                                 AS "VERTEX_TYPE",
    NAME                                  AS "SLUG",
    LABEL                                 AS "LABEL",
    'ACTIVE'                              AS "STATUS"
  FROM "COM_SAP_DEVELOPERS_IMS_TAGS"
  WHERE NAME IS NOT NULL
```

- [ ] **Step 6.4: Append `product` arm.**

```sql
  UNION ALL
  -- Product vertices — synthesized from tags whose name starts with
  -- 'software-product>'. Substring position 18 = 'software-product>' + 1
  -- (LENGTH('software-product>') = 17). DISTINCT because multiple tag
  -- rows may extract to the same product slug.
  SELECT DISTINCT
    CAST('product:' || SUBSTRING(NAME, 18) AS NVARCHAR(280)) AS "VERTEX_KEY",
    'product'                                                AS "VERTEX_TYPE",
    SUBSTRING(NAME, 18)                                      AS "SLUG",
    LABEL                                                    AS "LABEL",
    'ACTIVE'                                                 AS "STATUS"
  FROM "COM_SAP_DEVELOPERS_IMS_TAGS"
  WHERE NAME LIKE 'software-product>%'
```

- [ ] **Step 6.5: Append `category` arm.**

```sql
  UNION ALL
  -- Category vertices. Categories are CSV-seeded (8 rows) with mandatory
  -- slugs — no NULL filter needed but included for defense-in-depth.
  SELECT
    CAST('category:' || SLUG AS NVARCHAR(280)) AS "VERTEX_KEY",
    'category'                                 AS "VERTEX_TYPE",
    SLUG                                       AS "SLUG",
    LABEL                                      AS "LABEL",
    'ACTIVE'                                   AS "STATUS"
  FROM "COM_SAP_DEVELOPERS_IMS_CATEGORIES"
  WHERE SLUG IS NOT NULL
```

Verify the terminating `;` is at the end.

- [ ] **Step 6.6: Build and commit.**

```bash
npx cds build --production
git add db/src/views/KG_PG_VERTICES_V.hdbview
git commit -m "feat(#919): add 5 vertex types (mission/group/tag/product/category)"
```

---

## Task 7: QA-channel mirror (conditional)

**Goal:** If Task 0.5 found `db-qa/src/views/KG_PG_*.hdbview` files, apply the same widening there. If not, skip.

**Files (conditional):**
- Modify: `db-qa/src/views/KG_PG_VERTICES_V.hdbview` (only if it exists)
- Modify: `db-qa/src/views/KG_PG_EDGES_V.hdbview` (only if it exists)

- [ ] **Step 7.1: Read the Task 0.5 decision.**

```bash
grep QA_MIRROR docs/superpowers/reviews/2026-07-04-919-kg-workspace-widening-task0-notes.md
```

- [ ] **Step 7.2 (if `QA_MIRROR: yes`): Apply the same edits.**

Copy `db/src/views/KG_PG_VERTICES_V.hdbview` and `db/src/views/KG_PG_EDGES_V.hdbview` into `db-qa/src/views/` (overwriting the existing files):

```bash
cp db/src/views/KG_PG_VERTICES_V.hdbview db-qa/src/views/KG_PG_VERTICES_V.hdbview
cp db/src/views/KG_PG_EDGES_V.hdbview    db-qa/src/views/KG_PG_EDGES_V.hdbview
```

Verify the QA views compile:

```bash
npx cds build --production
```

Commit:

```bash
git add db-qa/src/views/
git commit -m "feat(#919): mirror widened views into db-qa channel"
```

- [ ] **Step 7.3 (if `QA_MIRROR: no`): Confirm no action needed.**

Add a note to the Task 0 notes file explaining that QA reads shared source, no mirror needed. Skip the commit.

---

## Task 8: Hybrid test — assert all 9 predicates + 5 new vertex types

**Goal:** Prove the widening works against real HANA before deploy.

**Files:**
- Create: `test/hybrid/kg-workspace-widening.test.js`

**Interfaces:**
- Consumes: widened `KG_PG_VERTICES_V` and `KG_PG_EDGES_V` (Tasks 2-6).

- [ ] **Step 8.1: Read the sibling hybrid-test scaffolding.**

```bash
cat test/hybrid/kg-graph-rebuild.test.js
```

Note: `_guard.js` import, `crypto.randomBytes(3)` runId, `TEST_PREFIX`, `beforeAll` seed order, `afterAll` FK-safe teardown.

- [ ] **Step 8.2: Create `test/hybrid/kg-workspace-widening.test.js` — imports and skeleton.**

```js
// test/hybrid/kg-workspace-widening.test.js
//
// Asserts KG_PG_VERTICES_V + KG_PG_EDGES_V surface all 9 predicates and
// 5 new vertex types after #919 widening. Seeds a minimal fixture with
// one row of each new predicate under __TEST__kg-w9-<runId>-.
//
// Spec:  docs/superpowers/specs/2026-07-04-919-kg-workspace-widening-design.md
// Issue: #919

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const RUN_ID = crypto.randomBytes(3).toString('hex');
const PFX = `__test__kg-w9-${RUN_ID}-`;

// Slugs of fixture entities.
const HUB_C   = `${PFX}hub`;
const REL_C   = `${PFX}related`;
const TUT_1   = `${PFX}t1`;
const TUT_2   = `${PFX}t2`;
const TUT_A   = `${PFX}ta`;
const TUT_B   = `${PFX}tb`;
const GRP     = `${PFX}g1`;
const MIS     = `${PFX}m1`;
const TAG_R   = `${PFX}regular-tag`;
const TAG_P   = `software-product>${PFX}example-product`;
const PROD    = `${PFX}example-product`;

let db;
```

- [ ] **Step 8.3: Add `beforeAll` seed block.**

```js
beforeAll(async () => {
  if (!isSafeForWrites()) {
    throw new Error('ALLOW_HYBRID_WRITES=true not set — refusing to seed.');
  }
  db = await cds.connect.to('db');

  const NS = 'com.sap.developers.ims';
  const {
    Concepts, Tutorials, TutorialConceptLinks, ConceptEdges,
    Groups, Missions, CompletionPaths, CompletionPathItems,
    Tags, TutorialTags, Categories, MissionCategories, CoCompletions,
  } = db.entities(NS);

  // Concepts: hub + related.
  await INSERT.into(Concepts).entries([
    { slug: HUB_C, name: 'Hub',     status: 'ACTIVE' },
    { slug: REL_C, name: 'Related', status: 'ACTIVE' },
  ]);

  // Tutorials: 4 (t1 teaches hub, t2 extended by t1, ta/tb for co-completion).
  await INSERT.into(Tutorials).entries([
    { slug: TUT_1, title: 'T1' },
    { slug: TUT_2, title: 'T2' },
    { slug: TUT_A, title: 'TA' },
    { slug: TUT_B, title: 'TB' },
  ]);

  // Look up IDs (uppercase in raw SELECT).
  const conceptRows = await db.run(
    `SELECT ID, SLUG FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS" WHERE SLUG LIKE ?`,
    [`${PFX}%`]
  );
  const tutRows = await db.run(
    `SELECT ID, SLUG FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE SLUG LIKE ?`,
    [`${PFX}%`]
  );
  const cId = Object.fromEntries(conceptRows.map(r => [r.SLUG, r.ID]));
  const tId = Object.fromEntries(tutRows.map(r => [r.SLUG, r.ID]));

  // ConceptEdges: hub relatedTo related.
  await INSERT.into(ConceptEdges).entries([
    { source_ID: cId[HUB_C], target_ID: cId[REL_C], predicate: 'relatedTo', status: 'ACTIVE' },
  ]);

  // TutorialConceptLinks: t1 extends t2 (extends predicate).
  await INSERT.into(TutorialConceptLinks).entries([
    { tutorial_ID: tId[TUT_1], extendsTutorial_ID: tId[TUT_2], predicate: 'extends' },
  ]);

  // Groups + Missions + CompletionPaths + CompletionPathItems.
  await INSERT.into(Groups).entries([{ slug: GRP, title: 'Grp' }]);
  const grpRows = await db.run(
    `SELECT ID, SLUG FROM "COM_SAP_DEVELOPERS_IMS_GROUPS" WHERE SLUG = ?`, [GRP]
  );
  const gId = grpRows[0].ID;

  await INSERT.into(Missions).entries([{ slug: MIS, title: 'Mis', group_ID: gId }]);
  const misRows = await db.run(
    `SELECT ID, SLUG FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS" WHERE SLUG = ?`, [MIS]
  );
  const mId = misRows[0].ID;

  await INSERT.into(CompletionPaths).entries([{ mission_ID: mId, name: 'default' }]);
  const cpRows = await db.run(
    `SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS" WHERE MISSION_ID = ?`, [mId]
  );
  const pId = cpRows[0].ID;

  await INSERT.into(CompletionPathItems).entries([
    { path_ID: pId, tutorial_ID: tId[TUT_1], sortOrder: 1 },
  ]);

  // Tags + TutorialTags: regular tag + software-product tag.
  await INSERT.into(Tags).entries([
    { name: TAG_R, label: 'Regular' },
    { name: TAG_P, label: 'Example Product' },
  ]);
  const tagRows = await db.run(
    `SELECT ID, NAME FROM "COM_SAP_DEVELOPERS_IMS_TAGS" WHERE NAME LIKE ? OR NAME LIKE ?`,
    [`${PFX}%`, `software-product>${PFX}%`]
  );
  const tagId = Object.fromEntries(tagRows.map(r => [r.NAME, r.ID]));

  await INSERT.into(TutorialTags).entries([
    { tutorial_ID: tId[TUT_1], tag_ID: tagId[TAG_R] },
    { tutorial_ID: tId[TUT_1], tag_ID: tagId[TAG_P] },
  ]);

  // MissionCategories — reuse an existing seeded category (categories
  // are CSV-seeded with stable slugs). Pick the first one.
  const catRows = await db.run(
    `SELECT TOP 1 ID, SLUG FROM "COM_SAP_DEVELOPERS_IMS_CATEGORIES" WHERE SLUG IS NOT NULL`
  );
  if (catRows.length === 0) {
    throw new Error('No Categories seeded — kg-workspace-widening test requires >= 1 category.');
  }
  const catId = catRows[0].ID;
  await INSERT.into(MissionCategories).entries([
    { mission_ID: mId, category_ID: catId },
  ]);

  // CoCompletions: one row above threshold, one below (negative-path).
  await INSERT.into(CoCompletions).entries([
    { sourceSlug: TUT_A, targetSlug: TUT_B, score: 15 },
    { sourceSlug: TUT_B, targetSlug: TUT_A, score: 15 },   // reverse direction
    { sourceSlug: TUT_1, targetSlug: TUT_2, score:  5 },   // below k=10 gate
  ]);
}, 120_000);
```

- [ ] **Step 8.4: Add `afterAll` teardown block (FK-safe reverse order).**

```js
afterAll(async () => {
  if (!db) return;
  const cleanupOrder = [
    `DELETE FROM "COM_SAP_DEVELOPERS_IMS_MISSIONCATEGORIES" WHERE MISSION_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS" WHERE LOWER(SLUG) LIKE ?)`,
    `DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALTAGS"      WHERE TUTORIAL_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE LOWER(SLUG) LIKE ?)`,
    `DELETE FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS" WHERE TUTORIAL_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE LOWER(SLUG) LIKE ?)`,
    `DELETE FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"   WHERE MISSION_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS" WHERE LOWER(SLUG) LIKE ?)`,
    `DELETE FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS"          WHERE LOWER(SLUG) LIKE ?`,
    `DELETE FROM "COM_SAP_DEVELOPERS_IMS_GROUPS"            WHERE LOWER(SLUG) LIKE ?`,
    `DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS" WHERE TUTORIAL_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE LOWER(SLUG) LIKE ?)`,
    `DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES"      WHERE SOURCE_ID IN (SELECT ID FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS" WHERE LOWER(SLUG) LIKE ?)`,
    `DELETE FROM "COM_SAP_DEVELOPERS_IMS_COCOMPLETIONS"     WHERE LOWER(SOURCESLUG) LIKE ? OR LOWER(TARGETSLUG) LIKE ?`,
    `DELETE FROM "COM_SAP_DEVELOPERS_IMS_TAGS"              WHERE LOWER(NAME) LIKE ? OR LOWER(NAME) LIKE ?`,
    `DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"         WHERE LOWER(SLUG) LIKE ?`,
    `DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"          WHERE LOWER(SLUG) LIKE ?`,
  ];
  const arg1 = `${PFX}%`;
  const arg2 = `software-product>${PFX}%`;
  for (const sql of cleanupOrder) {
    const paramCount = (sql.match(/\?/g) || []).length;
    const params = paramCount === 2 ? [arg1, arg2] : [arg1];
    await db.run(sql, params);
  }
}, 60_000);
```

- [ ] **Step 8.5: Add the test body.**

```js
describe('KG_PG_WORKSPACE — 9-predicate widening (#919)', () => {
  it('emits all 7 new edge types from the widened view', async () => {
    const rows = await db.run(
      `SELECT DISTINCT EDGE_TYPE FROM "KG_PG_EDGES_V"
         WHERE SOURCE LIKE ? OR TARGET LIKE ? OR SOURCE LIKE ? OR TARGET LIKE ?`,
      [`%${PFX}%`, `%${PFX}%`,
       `%software-product>${PFX}%`, `%software-product>${PFX}%`]
    );
    const set = new Set(rows.map(r => r.EDGE_TYPE));
    expect(set.has('relatedTo')).toBe(true);
    expect(set.has('extends')).toBe(true);
    expect(set.has('partOf')).toBe(true);           // covers both arms
    expect(set.has('taggedWith')).toBe(true);
    expect(set.has('aboutProduct')).toBe(true);
    expect(set.has('inCategory')).toBe(true);
    expect(set.has('coCompletedWith')).toBe(true);
  });

  it('emits 4 new vertex types filtered by prefix + product', async () => {
    const rows = await db.run(
      `SELECT DISTINCT VERTEX_TYPE FROM "KG_PG_VERTICES_V"
         WHERE SLUG LIKE ? OR SLUG LIKE ?`,
      [`${PFX}%`, `${PFX}example-product`]
    );
    const set = new Set(rows.map(r => r.VERTEX_TYPE));
    expect(set.has('mission')).toBe(true);
    expect(set.has('group')).toBe(true);
    expect(set.has('tag')).toBe(true);
    expect(set.has('product')).toBe(true);
  });

  it('emits the 5th (category) vertex type at all', async () => {
    const rows = await db.run(
      `SELECT COUNT(*) AS N FROM "KG_PG_VERTICES_V" WHERE VERTEX_TYPE = 'category'`
    );
    expect(rows[0].N).toBeGreaterThan(0);
  });

  it('enforces k-anonymity gate (score=5 pair does NOT appear)', async () => {
    const rows = await db.run(
      `SELECT COUNT(*) AS N FROM "KG_PG_EDGES_V"
         WHERE EDGE_TYPE = 'coCompletedWith'
           AND SOURCE = ? AND TARGET = ?`,
      [`tutorial:${TUT_1}`, `tutorial:${TUT_2}`]
    );
    expect(rows[0].N).toBe(0);
  });

  it('emits both directions of coCompletedWith when both are stored', async () => {
    const rows = await db.run(
      `SELECT SOURCE, TARGET FROM "KG_PG_EDGES_V"
         WHERE EDGE_TYPE = 'coCompletedWith'
           AND (SOURCE = ? OR SOURCE = ?)`,
      [`tutorial:${TUT_A}`, `tutorial:${TUT_B}`]
    );
    const pairs = new Set(rows.map(r => `${r.SOURCE}=>${r.TARGET}`));
    expect(pairs.has(`tutorial:${TUT_A}=>tutorial:${TUT_B}`)).toBe(true);
    expect(pairs.has(`tutorial:${TUT_B}=>tutorial:${TUT_A}`)).toBe(true);
  });
});
```

- [ ] **Step 8.6: Run the test.**

```bash
ALLOW_HYBRID_WRITES=true npx vitest run test/hybrid/kg-workspace-widening.test.js --project hybrid
```

Expected: PASS on all 5 assertions.

Common failure modes:
- **`extends` not found** — Task 0.1 recorded the wrong column name; re-check `TutorialConceptLinks` `extendsTutorial` FK.
- **`partOf` missing** — check `CompletionPathItems.tutorial_ID` is populated; verify `sortOrder` isn't required as NOT NULL (Step 8.3 seed).
- **`inCategory` missing** — check the `MissionCategories` seed didn't silently fail because `Categories` was empty. Task 8.3 already guards; if the guard fired, the DB has no categories seeded — investigate.
- **`taggedWith` missing** — the `Tags.name` FK might be wrong; re-check.

- [ ] **Step 8.7: Commit.**

```bash
git add test/hybrid/kg-workspace-widening.test.js
git commit -m "test(#919): hybrid test asserts 9 predicates + 5 new vertex types + k-anon"
```

---

## Task 9: Push branch, open draft PR, verify CI

**Files:** none (Git + gh operations only).

- [ ] **Step 9.1: Verify branch and status.**

```bash
git branch --show-current   # expect worktree-issue-919-kg-workspace-widening
git status                  # expect clean
git log --oneline -10       # expect all Task 1-8 commits
```

- [ ] **Step 9.2: Push.**

```bash
git push -u origin worktree-issue-919-kg-workspace-widening
```

- [ ] **Step 9.3: Open draft PR.**

```bash
gh pr create --draft \
  --title "feat(#919): widen KG_PG_WORKSPACE to 9-predicate parity" \
  --body "Implements docs/superpowers/specs/2026-07-04-919-kg-workspace-widening-design.md.

## What

View-only widening of KG_PG_VERTICES_V (2→7 vertex types) and KG_PG_EDGES_V (2→9 edge types). Adds mission, group, tag, product, category vertices and relatedTo, extends, partOf (×2), taggedWith, aboutProduct, inCategory, coCompletedWith edge arms. EDGE_KEY widens NVARCHAR(400) to NVARCHAR(600) for taggedWith/aboutProduct worst case. K-anonymity gate SCORE >= 10 on coCompletedWith mirrors kg-projection.js:466-479.

## Unblocks

- #916 PageRank for whatToLearnNext
- #917 community detection
- #918 WCC as curation quality signal

## Rollout

DEV-only per #913 non-goals. Views only — no schema changes, no graphRebuild changes, no workspace declaration change. Downstream KG procedures inherit the widening for free."
```

- [ ] **Step 9.4: Wait for CI.**

Poll:

```bash
gh pr checks --watch
```

Expected: unit tests PASS. Hybrid tests do NOT run on PR (they need `ALLOW_HYBRID_WRITES` and a DEV binding). That's expected — Step 8.6 proved the hybrid test passes locally.

- [ ] **Step 9.5: Post rollout notes on the PR body.**

Add a comment describing how to promote to DEV once the PR merges:

```bash
gh pr comment --body "## After merge — deploy to DEV

From a primary tree checkout on \`main\` (NOT from this worktree):

\`\`\`bash
cf target -s dev
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
\`\`\`

Post-deploy verification:

\`\`\`bash
hana-cli querySimple --query 'SELECT DISTINCT EDGE_TYPE FROM \"KG_PG_EDGES_V\" ORDER BY 1'
\`\`\`

Expected 9 types: aboutProduct, coCompletedWith, extends, inCategory, partOf, relatedTo, requires, taggedWith, teaches.

Once verified, comment on #916 that the prereq has landed."
```

---

## Self-Review

**Spec coverage:**
- Widen EDGE_KEY sizing — Task 1.
- 7 new edge arms — Tasks 2 (2 arms), 3 (2 arms), 4 (3 arms), 5 (1 arm) = 8 arm-writes; note task 3 emits two `partOf` arms both labeled `partOf`.
- 5 new vertex arms — Task 6.
- QA-channel mirror — Task 7 conditional.
- Hybrid test — Task 8.
- Column-name probe (spec's implementation prerequisite) — Task 0.
- Deploy + verify runbook — Task 9.5.

**Non-goals honored:**
- No schema changes.
- No `graphRebuild()` changes.
- No workspace declaration change (Task 0 confirmed via reading the file).
- No new physical tables.
- No `TutorialCategories` projection.
- No `@assert.unique.name` on Tags.

**Placeholder scan:**
- `<EXTENDS_FK>` in Task 2.2 is intentional — Task 0.1 resolves it. Not "TBD" — a HANA-side probe substitution.
- No other TODO / TBD / vague placeholders.

**Type consistency:**
- `EDGE_KEY` is `NVARCHAR(600)` in every arm (Tasks 1-5).
- `SOURCE` and `TARGET` are `NVARCHAR(280)` in every arm.
- Every new vertex-type arm emits `VERTEX_KEY NVARCHAR(280)`.
- `EDGE_TYPE` literals match spec: `relatedTo`, `extends`, `partOf`, `taggedWith`, `aboutProduct`, `inCategory`, `coCompletedWith`.
- `VERTEX_TYPE` literals match spec: `mission`, `group`, `tag`, `product`, `category`.
- k-anonymity threshold: `>= 10` (Task 5 and Task 8 negative assertion).

**Handoff:** ready for subagent-driven execution.
