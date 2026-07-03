# KG Property Graph Spike — Task 1 Probe Notes

**Date:** 2026-07-02
**Executor:** Tom (verified via Claude Code + hana-cli MCP against DEV HDI)
**Related:** [#913](https://github.com/sap-tutorials/tutorials-ims/issues/913), design spec `../specs/2026-07-02-913-kg-property-graph-spike-design.md`, plan `../plans/2026-07-02-913-kg-property-graph-spike.md`

---

## Runtime identity

```
CURRENT_USER   = AC9753D6C4764F5ABE3B3CA4E88233C0_D6JB1VU4V5WUEM7KTI62GQQ8Q_RT
CURRENT_SCHEMA = AC9753D6C4764F5ABE3B3CA4E88233C0
```

Runtime user of the DEV HDI container — the same identity the deployed `tutorials-srv` uses via service binding. Any privilege the DEFINER procedure body relies on must be present on this user (or on `#OO`, the container's object-owner user, when the procedure runs SQL SECURITY DEFINER).

## Step 1.1 — Privilege check

Query used:

```sql
SELECT PRIVILEGE FROM EFFECTIVE_PRIVILEGES
WHERE USER_NAME = CURRENT_USER
  AND (PRIVILEGE LIKE '%GRAPH%' OR PRIVILEGE LIKE '%SPARQL%' OR PRIVILEGE LIKE '%PROPERTY%')
ORDER BY PRIVILEGE
```

Result:

| PRIVILEGE      |
| -------------- |
| SPARQL QUERY   |
| SPARQL QUERY   |
| SPARQL UPDATE  |
| SPARQL UPDATE  |

**Finding:** the runtime user has `SPARQL QUERY` + `SPARQL UPDATE` (granted via [`docs/developers/operations/kg-grantor-setup.md`](../../developers/operations/kg-grantor-setup.md) for the KGE work in #533) but **no `GRAPH`-prefixed privilege**. Also no `CREATE TABLE` at the schema level, no `CREATE GRAPH WORKSPACE`.

This is **expected and normal for an HDI-container runtime user.** They are not supposed to be able to `CREATE` arbitrary tables — that would violate the HDI object-owner model. HDI DDL happens via `.hdb*` files at deploy time, and `SQL SECURITY DEFINER` procedures execute with `#OO` (the container's object-owner user) privileges regardless of what the calling runtime user can do.

**Implication for the plan:** the original Task 1.3 ("probe `SHORTEST_PATH` via ad-hoc `hana-cli querySimple`") is **not possible** in this container — the runtime user cannot `CREATE COLUMN TABLE`, let alone `CREATE GRAPH WORKSPACE`. Redirect: **the HDI deploy cycle IS the probe.** See "Redirect" section below.

## Step 1.2 — HANA table naming for CDS entities

Query used:

```sql
SELECT TABLE_NAME FROM TABLES
WHERE SCHEMA_NAME = CURRENT_SCHEMA
  AND (UPPER(TABLE_NAME) LIKE '%TUTORIAL%' OR UPPER(TABLE_NAME) LIKE '%CONCEPT%')
ORDER BY TABLE_NAME
```

Result — the four tables Task 2's view DDL joins against exist as:

| CDS entity                                          | HANA table name (confirmed)                    |
| --------------------------------------------------- | ---------------------------------------------- |
| `com.sap.developers.ims.Concepts`                   | `COM_SAP_DEVELOPERS_IMS_CONCEPTS`              |
| `com.sap.developers.ims.ConceptEdges`               | `COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES`          |
| `com.sap.developers.ims.Tutorials`                  | `COM_SAP_DEVELOPERS_IMS_TUTORIALS`             |
| `com.sap.developers.ims.TutorialConceptLinks`       | `COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS`  |

**Finding:** all-uppercase, underscore-flattened — **not** lowercase-dotted (the alternative the plan called out).

Column names inside each table also flatten to uppercase — e.g. `slug` → `SLUG`, `source_ID` → `SOURCE_ID`, `tutorial_ID` → `TUTORIAL_ID`. Confirmed by inspecting one row:

```sql
SELECT * FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS LIMIT 1
```

Returned columns (representative): `ID`, `CREATEDAT`, `MODIFIEDAT`, `CREATEDBY`, `MODIFIEDBY`, `SLUG`, `NAME`, `DESCRIPTION`, `STATUS`, `EMBEDDING`, `PUBLISHEDAT`, `PUBLISHEDBY`.

**Implication for the plan:** the `.hdbview` DDL in Task 2 needs table names + column names in uppercase-underscore form. All double-quoted lowercase-dotted references (`"com.sap.developers.ims.Concepts"`, `"slug"`, `"status"`) must be rewritten as unquoted or uppercase.

## Step 1.3 — `SHORTEST_PATH` syntax probe

**Original plan:** create a throwaway `_KGPROBE_V` / `_KGPROBE_E` / `_KGPROBE_WS` in the runtime schema and hand-write a `MAP GRAPH SHORTEST_PATH(...)` call.

**Actual outcome:** blocked by Step 1.1 finding — runtime user lacks `CREATE TABLE`. First attempt returned:

```
Error: insufficient privilege: Detailed info for this error can be found with guid '95F7C0B4BF52BA45A0B708701FE2C56A'
```

**Redirect (Path C, approved by maintainer):** use the HDI deploy cycle as the probe. Concretely:

1. Author the real `.hdbview` files (Task 2) with the uppercase-underscore table names confirmed in Step 1.2.
2. Author a minimal `.hdbgraphworkspace` declaration + a placeholder `.hdbprocedure` that tries the simplest possible `SHORTEST_PATH` call.
3. `cf push tutorials-db-deployer` (or `mbt build && cf deploy` from `main`) — the HDI plugin either accepts the workspace declaration (→ entitlement + plugin wired, iterate on procedure body) or rejects it at compile time (→ entitlement is enabled at the subaccount level but not on this container's HDI plugin config, and the spike stalls on config, not on code).

The first deploy attempt therefore produces the evidence Task 1.3 was originally supposed to produce, plus proves the workspace-declaration `.hdbgraphworkspace` shape at the same time.

**Status:** deferred to Task 2 + Task 3 execution.

## Step 1.4 — Table-typed OUT via DO-block

Query used:

```sql
DO BEGIN
  DECLARE result TABLE (MSG NVARCHAR(50));
  result = SELECT 'hello' AS MSG FROM DUMMY;
  SELECT * FROM :result;
END
```

Result: **succeeded.** Message: `Statement executed successfully (no result set)`. The `hana-cli querySimple` return-shape wrapper doesn't display DO-block SELECT output well, but the block itself executed without error.

**Implication for the plan:** the DO-block-with-embedded-SELECT pattern (established in [`srv/lib/kg-sparql-client.js:80-107`](../../../srv/lib/kg-sparql-client.js#L80-L107)) does compile in this HANA. Task 4's `kg-path-v2-client.js` `DO_KG_PATH_V2` template is expected to work as-is — the exact row-shape returned when the procedure's table-OUT is bound and re-SELECTed still needs runtime confirmation, but the block form is valid.

## Consolidated impact on Task 2 & Task 3

**Task 2 (`.hdbview` files):** the plan's DDL uses `"com.sap.developers.ims.Concepts"` etc. — **rewrite required.** The confirmed form is uppercase table names + uppercase column names, unquoted or double-quoted-in-uppercase:

```sql
-- Instead of: FROM "com.sap.developers.ims.Concepts"
FROM   "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
-- ...WHERE "status" = 'ACTIVE' becomes...
WHERE  "STATUS" = 'ACTIVE'
```

**Task 3 (procedure + workspace):** the procedure body has to be adjusted for the actual `SHORTEST_PATH` call syntax the HDI plugin accepts. The first HDI deploy is the probe; the plan's placeholder body (returning empty rows from DUMMY) is fine to start with — iterate the actual `SHORTEST_PATH` call once the workspace successfully deploys.

**Task 4 (`kg-path-v2-client.js`):** unchanged. The DO-block pattern is validated.

**Task 5 (handler):** unchanged. The failing-tests-first design still applies.

## Open questions carried into Task 2

- Does the HDI container's `.hdiconfig` map the `.hdbgraphworkspace` suffix to a plugin? If not, the deploy fails with "no plugin registered for file suffix .hdbgraphworkspace" and Task 3 gets blocked on a service-key config change. Verify by running `cds build --production && cat gen/db/src/gen/.hdiconfig | jq '.file_suffixes.hdbgraphworkspace'` before the deploy.
- If `.hdbgraphworkspace` is unsupported by the HDI plugin (older QRC on the actual plugin binary, not the DB), fallback is to declare the workspace inside the procedure body via `CREATE GRAPH WORKSPACE g_ws INSTANCE ...` — see Task 3 Step 3.2's `-- BODY --` comment.

---

## Path C follow-up finding (2026-07-02, post-#925 merge)

**Trigger:** `#925` merged, deploy to DEV kicked off, MTA deploy failed on the new KG_PG artifacts.

**Root cause:** the HDI `.hdbgraphworkspace` plugin **requires** an edge key column, even though HANA's native `CREATE GRAPH WORKSPACE` DDL accepts unkeyed edges. The spec's original design (`edgeKeyColumn: null`) plus `KG_PG_EDGES_V`'s three-column projection (`SOURCE`, `TARGET`, `EDGE_TYPE`) left the workspace with no per-row identity, and the plugin rejected it. Two spec reviewer passes and two plan reviewer passes missed it because none of them ran a live HDI deploy — the `cds build` step doesn't semantically validate `.hdbgraphworkspace` files (it just packs them).

A second drift also surfaced: the workspace file was shipped as **DDL** (`GRAPH WORKSPACE "..." EDGE TABLE ...`), not JSON as the spec + plan showed. Task 3's implementer silently corrected the format during authoring; no reviewer flagged it because none of them read the actual `.hdbgraphworkspace` file (they cross-checked against the JSON shown in the plan).

**Fix (applied in follow-up PR):**

1. Add a composite string `EDGE_KEY` column to `KG_PG_EDGES_V.hdbview`:
    - `requires` arm: `'r|' || src.SLUG || '|' || tgt.SLUG` (max ≈ 163 chars for the 80-char concept-slug cap).
    - `teaches` arm: `'t|' || t.SLUG || '|' || c.SLUG` (max ≈ 338 chars for the 255-char tutorial-slug cap).
    - Sized `NVARCHAR(400)` for headroom. `'r|'` / `'t|'` type prefix prevents any theoretical collision if a concept slug ever equaled a tutorial slug.
2. Update `KG_PG_WORKSPACE.hdbgraphworkspace` to include `KEY COLUMN "EDGE_KEY"` on the edge table. (Not `edgeKeyColumn` in JSON — the file is DDL.)
3. Update spec + plan to match the shipped DDL format and to show the composite EDGE_KEY in the view.

**Why not other options:**

- `ROW_NUMBER() OVER (...)` for the key: order-dependent, shifts on every concept change. Fragile edge identity.
- Materialized `KG_PG_EDGES` table with a real primary key: breaks the spec's locked "views only, no drift" decision. Overkill for a spike.
- Revert #925: throws away the whole design + review chain for a fix that's ~10 lines.

**Verification path:** `cds build --production` packs the fix cleanly, but semantic validation only happens at deploy time. Re-deploy after the follow-up PR merges to confirm the plugin accepts the keyed workspace.

**Reviewer discipline lesson:** for spec/plan-review passes on HDI artifacts that don't get exercised until deploy, adding a "verify by comparing to a working sibling artifact in the repo" step to the reviewer checklist would have caught this — the SAP HANA HDI docs (or a working `.hdbgraphworkspace` elsewhere in SAP samples) would have shown the required KEY column. Filing this as a hindsight note; not proposing a process change today.

---

## Body iteration completed (2026-07-02/03)

The `SHORTEST_PATH` body iteration ran across 4 deploys overnight:

1. **PR #932** — real body first attempt with LANGUAGE GRAPH sibling procedure. HDI rejected: (a) `READS SQL DATA` clause misplaced, (b) mid-body `DECLARE` in SQLScript.
2. **PR #933** — mechanical fixes + full rewrite against SAP's [`HANA_Cloud_2021Q1_Shortest_Path_One_to_One.sql`](https://github.com/SAP-samples/hana-graph-examples/blob/main/GRAPH_PROCEDURE_EXAMPLES/BUILTIN_FUNCTIONS_ALGORITHMS/HANA_Cloud_2021Q1_Shortest_Path_One_to_One.sql) sample. Still wrong on the SELECT-FOREACH grammar.
3. **PR #934** — GraphScript's `SELECT ... FOREACH` doesn't accept `AS` column aliases on the projection. Output columns come from the OUT param's TABLE definition positionally.
4. **PR #936** — HDI enforces schema-local references in procedures; `Graph("**CURRENT_SCHEMA**", "KG_PG_WORKSPACE")` rejected. Single-arg `Graph("KG_PG_WORKSPACE")` works.

After #936 merged, the procedures compiled cleanly and a live probe on 2026-07-03 05:36 UTC confirmed the shipped design works end-to-end:

- Test slug pair: `btp-cf-ext-successfactors` → `xsa-create-user-provided-anonymous-service`
- Result: 4 rows, hop_count=3, path: tutorial → concept:cloud-foundry-app-deployment → concept:sap-hana-hdi-container → tutorial
- The hop count is real (v1 SPARQL always returned 0 due to the KGE `{n,m}` limitation this spike was designed around).

### One-off finding: exhaustive BFS on empty-path case (PR #938)

Live probe of a **nonexistent slug pair** timed out hana-cli's 30-second default. HANA's `Shortest_Path` does exhaustive BFS before concluding no path exists; on the current workspace (6,054 vertices / 7,164 edges) that dominates for unconnected pairs.

Fix landed as PR #938: `Promise.race`-based `withTimeout` in `srv/lib/kg-path-v2-client.js`, default 5000ms, caller-overridable. On expiry the wrapper rejects with `err.code === 'ETIMEDOUT'`; the pathBetween handler's existing try/catch falls through to v1 SPARQL and emits `kg_path_v2_failed` warning + `kg_path_v2_fallback_error` counter.

**Contrast with connected-pair performance:** the successful 3-hop probe above returned in ~50ms. The timeout only bites on truly unconnected pairs OR runs where the graph has expanded significantly beyond current capacity estimates.

### Reviewer-discipline lesson from the whole iteration

Every one of the 4 syntax fixes was readable straight off the HDI compile error. None of them would have been caught by a smarter spec-review or code-quality-review pass, because HDI's semantic validation only runs at `cf push tutorials-db-deployer` time — `cds build` treats `.hdbprocedure` files as passthrough. This makes HDI artifact review structurally different from JS/TS code review; the only reliable validation is a live deploy.

For future property-graph work (follow-ons #916, #917, #918, #919), the runbook now documents the confirmed GraphScript syntax so authors can start from a known-working baseline instead of re-deriving it.
