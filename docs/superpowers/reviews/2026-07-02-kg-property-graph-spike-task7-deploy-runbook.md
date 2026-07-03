# Task 7 — Deploy + rollback drill runbook

**Status:** Task 6 authored + committed. Task 7 is a maintainer-execution task requiring `cf` credentials targeted at the DEV space.
**Date:** 2026-07-02
**Prerequisite branches merged / commits in scope:** everything on `worktree-kg-property-graph-spec` (Task 1 notes, Task 2 views, Task 3 procedure + workspace + `.hdiconfig`, Task 4 JS wrapper, Task 5 handler + tests, Task 6 hybrid test).

## Deploy path

**Canonical path (per CLAUDE.md "always deploy from main"):**

1. Merge the spike branch PR to `main` first. Do NOT deploy from the worktree branch.
2. From primary tree (`d:\projects\tutorials-poc`, not the worktree):

   ```bash
   cd d:/projects/tutorials-poc
   git checkout main && git pull
   npm run build:all
   cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
   ```

3. **Confirm before running:** `cf target` shows DEV space (not PROD). If unsure, `cf target -s dev` first. Per `feedback_cf_target_before_push.md`.

**Fast-path (schema-only iteration, if merging isn't ready yet):**

- `cf push tutorials-db-deployer` from primary tree on `main` after cherry-picking the spike commits. Skips the full MTA — pushes only the db-deployer app for a re-deploy of HDI artifacts. ~30-45 s per iteration.

## Post-deploy verification (Step 7.1 continued)

The three probes below tell us whether Path C (workspace declaration + `.hdbgraphworkspace` plugin registration) worked.

### 7.1a — DEV artifacts present

```bash
hana-cli views | grep KG_PG
# Expected: KG_PG_VERTICES_V, KG_PG_EDGES_V
```

```bash
hana-cli procedures | grep KG_PATH_V2
# Expected: KG_PATH_V2
```

```bash
# Verify the workspace was actually created. Two commands to try; whichever
# shows something is the right one for the QRC we deployed against.
hana-cli querySimple --query "SELECT WORKSPACE_NAME FROM SYS.GRAPH_WORKSPACES WHERE WORKSPACE_NAME LIKE '%KG_PG%'"
# OR:
hana-cli querySimple --query "SELECT * FROM SYS.GRAPH_WORKSPACES"
```

**If workspace is NOT present** but views + procedure are: HDI silently skipped the `.hdbgraphworkspace` file. Two likely causes:

- The plugin registration in `db/src/.hdiconfig` is wrong (`com.sap.hana.di.graphworkspace` was a guess — see Task 3 fix-pass commit `82c66f65` for the reasoning). Check the actual HANA Cloud HDI plugin catalog for the correct name.
- Property-graph engine is not entitled on this HDI container despite being enabled at the subaccount level.

**Action if workspace missing:** capture the failing deploy log excerpt (`cf logs tutorials-db-deployer --recent | grep -i graphworkspace`), then either (a) correct the `.hdiconfig` plugin_name and re-deploy, or (b) surface the entitlement gap to BTP ops. This IS the Path C finding the spike was built to produce — a legitimate spike outcome, not a task failure.

### 7.1b — QA stub deployed (parallel MTA path)

```bash
# Assumes the QA HDI container's service key is loaded — swap via
# `hana-cli useKey <qa-key>` or the appropriate hana-cli profile.
hana-cli procedures --profile qa | grep KG_PATH_V2
```

Then probe the stub returns SIGNAL 10002:

```bash
hana-cli querySimple --profile qa --query "DO BEGIN
  DECLARE paths TABLE (path_rank INTEGER, hop_count INTEGER, vertex_seq NVARCHAR(500), seq_index INTEGER);
  CALL KG_PATH_V2('https://developers.sap.com/kg/tutorial/foo',
                  'https://developers.sap.com/kg/tutorial/bar', 8, :paths);
  SELECT * FROM :paths;
END"
```

Expected: SQL error with code `10002` (`KG_NOT_AVAILABLE_ON_QA`). Any other outcome — including "success with empty result" — means the QA stub didn't deploy or the body isn't SIGNAL-only.

### 7.1c — Live procedure probe from DEV

Only proceeds if 7.1a passed. Uses the same DO-block pattern the JS wrapper (`srv/lib/kg-path-v2-client.js`) uses at runtime:

```bash
hana-cli querySimple --query "DO (
  IN from_iri NVARCHAR(500) => 'https://developers.sap.com/kg/tutorial/<known-slug-a>',
  IN to_iri   NVARCHAR(500) => 'https://developers.sap.com/kg/tutorial/<known-slug-b>',
  IN max_hops INTEGER       => 8
) BEGIN
  DECLARE paths TABLE (path_rank INTEGER, hop_count INTEGER, vertex_seq NVARCHAR(500), seq_index INTEGER);
  CALL KG_PATH_V2(:from_iri, :to_iri, :max_hops, :paths);
  SELECT * FROM :paths;
END"
```

Substitute `<known-slug-a>` / `<known-slug-b>` with two tutorial slugs known to be connected via `kg:requires` chain in the live graph. Expected: empty result **initially** — the procedure body is currently a placeholder returning `SELECT ... FROM DUMMY WHERE 1 = 0`. Iterating the body to the real `SHORTEST_PATH` call happens next.

## Iterating the `SHORTEST_PATH` body — RESOLVED 2026-07-03

**Update:** The body iteration completed overnight 2026-07-02/03 across 4 deploys (#932 → #933 → #934 → #936). The confirmed working design is now shipped on `main`. This section documents the final syntax so a future reader doesn't have to re-derive it.

### Final design: SQLScript wrapper + GraphScript sibling

HANA does **not** allow inline `LANGUAGE GRAPH` blocks inside a `LANGUAGE SQLSCRIPT` procedure body. GraphScript is a distinct language declared at the procedure boundary. Solution: two procedures, `KG_PATH_V2` (SQLScript) calls `KG_SHORTEST_PATH_GRAPH` (GraphScript).

**`db/src/procedures/KG_SHORTEST_PATH_GRAPH.hdbprocedure`** — GraphScript sibling:

```sql
PROCEDURE KG_SHORTEST_PATH_GRAPH (
  IN  i_from  NVARCHAR(400),
  IN  i_to    NVARCHAR(400),
  OUT o_verts TABLE (
    vertex_key NVARCHAR(400),
    seq_idx    BIGINT
  )
)
LANGUAGE GRAPH READS SQL DATA AS
BEGIN
  -- Single-arg Graph() constructor. HDI enforces schema-local
  -- references — no explicit schema qualifier permitted (compile
  -- error 8250002: "the reference has to be schema-local").
  GRAPH g = Graph("KG_PG_WORKSPACE");

  -- Guard against missing endpoints — without this, Vertex() throws
  -- when the key doesn't exist, and the caller would see a confusing
  -- exception instead of an empty result. Fail-open with return.
  IF (NOT VERTEX_EXISTS(:g, :i_from) OR NOT VERTEX_EXISTS(:g, :i_to)) {
    return;
  }

  VERTEX v_from = Vertex(:g, :i_from);
  VERTEX v_to   = Vertex(:g, :i_to);

  -- Unit-cost weight lambda + 'ANY' direction. Every edge costs 1
  -- regardless of type or direction; Shortest_Path becomes hop-count-
  -- minimizing with undirected traversal.
  WeightedPath<BIGINT> p = Shortest_Path(:g, :v_from, :v_to,
    (Edge e) => BIGINT{ return 1L; }, 'ANY');

  -- GraphScript SELECT-FOREACH does NOT accept AS aliases on the
  -- projection expressions. Output columns come from the OUT param's
  -- TABLE(...) definition (positional). The ORDINALITY name (:SEQ)
  -- IS valid — it's a variable binding in FOREACH scope.
  o_verts = SELECT :v."VERTEX_KEY", :SEQ
            FOREACH v IN Vertices(:p) WITH ORDINALITY AS SEQ;
END;
```

**Key syntax facts confirmed by deploy iteration:**

| Fact | Notes |
| --- | --- |
| `LANGUAGE GRAPH READS SQL DATA AS` | The `READS SQL DATA` clause goes here, not on `LANGUAGE SQLSCRIPT`-adjacent DEFINER lines. |
| No `SQL SECURITY DEFINER` on GraphScript | GraphScript rejects the clause. Workspace-level ACL pins identity to `#OO`. |
| Single-arg `Graph("WS_NAME")` | The two-arg form `Graph("SCHEMA", "WS")` is only for cross-schema references. Within an HDI container: single-arg. |
| Mixed-case function names | `Shortest_Path`, `Vertex`, `Vertices` — HANA is case-insensitive but the sample-canonical casing is documented for readability. |
| Direction as 5th arg | `'ANY'` — the KG edges are directed (concept→concept for `requires`, tutorial→concept for `teaches`), but PREREQ semantics require walking teaches edges backwards. `'ANY'` enables that. |
| Endpoint-exists guard | `IF (NOT VERTEX_EXISTS(:g, :i_from) OR ...) return;` — matches SAP's sample. Without this, Vertex() throws on missing keys. |
| SELECT-FOREACH projection is BARE | No `AS colname` aliases. Positional match against the OUT TABLE columns. |

### Live probe result

Verified 2026-07-03 05:36 UTC against DEV HANA (schema `AC9753D6C4764F5ABE3B3CA4E88233C0`):

```sql
CALL KG_PATH_V2(
  'https://developers.sap.com/kg/tutorial/btp-cf-ext-successfactors',
  'https://developers.sap.com/kg/tutorial/xsa-create-user-provided-anonymous-service',
  8, :paths);
```

Returned 4 rows, `hop_count=3`, path:

```text
tutorial:btp-cf-ext-successfactors
  → concept:cloud-foundry-app-deployment  (teaches edge)
  → concept:sap-hana-hdi-container         (requires edge)
  → tutorial:xsa-create-user-provided-anonymous-service  (teaches edge, reversed via 'ANY')
```

The hop count is **real** — v1 SPARQL always returned 0 for the same query due to the KGE `{n,m}` limitation the whole spike was designed around.

### Empty-path timeout risk

Live probe of a **nonexistent slug pair** timed out at hana-cli's 30-second default. Shortest_Path does exhaustive BFS before concluding no path exists, and on a workspace with 6,054 vertices / 7,164 edges that can dominate.

Fix landed in the JS wrapper (see PR #938): `Promise.race`-based `withTimeout` in `srv/lib/kg-path-v2-client.js`, default 5000ms, caller-overridable. On expiry, rejects with `err.code === 'ETIMEDOUT'`; the `pathBetween` handler's existing try/catch falls through to v1 SPARQL and emits `kg_path_v2_failed` warning + `kg_path_v2_fallback_error` counter. No handler changes needed.

### Verify the real body against the hybrid fixture

Once rows come back for a known-connected slug pair, the hybrid test in [`test/hybrid/kg-path-v2.test.js`](../../../test/hybrid/kg-path-v2.test.js) has an assertion (`hopCount >= 1` + endpoint vertex keys) that's `.skipIf`-gated on `KG_PATH_V2_BODY_IMPLEMENTED=true`. Flip the env var and re-run:

```bash
ALLOW_HYBRID_WRITES=true KG_PATH_V2_BODY_IMPLEMENTED=true \
  npx cds bind --exec --profile hybrid -- \
  npx vitest run --project hybrid test/hybrid/kg-path-v2.test.js
```

Expected: all 4 tests pass, including the previously-skipped "chained tutorials find a path" case. If that one fails, the real body doesn't yet return the expected shape — inspect the raw `SELECT * FROM :paths` output against the seeded fixture and iterate the procedure body.

## Rollback drill (Step 7.2)

**Only run this after 7.1a-c pass and a real `SHORTEST_PATH` body is landed.** Running the drill against the placeholder body would show only `kg_path_v2_fallback_empty` counters — the drill exists to prove the flag gates cleanly, which requires v2 producing real rows.

1. Enable the flag:

   ```bash
   cf target -s dev
   cf set-env tutorials-srv KG_PATH_V2_ENABLED true
   cf restart tutorials-srv
   ```

2. Drive 5 deliberate calls with a known-connected slug pair:

   ```bash
   BASE=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com
   for i in 1 2 3 4 5; do
     curl -sS "$BASE/graph/pathBetween(fromSlug='SLUG_A',toSlug='SLUG_B')" > /dev/null
     echo "call $i"
   done
   ```

3. Wait 5 minutes for the metrics rollup, then open `/admin-ui/#metrics`. Confirm:
   - `kg_path_between_calls_v2_success_prereq` incremented by 5
   - `kg_path_between_latency_ms_v2` reservoir populated
   - No `kg_path_v2_failed` warnings in `cf logs tutorials-srv --recent`

4. Flip flag off:

   ```bash
   cf set-env tutorials-srv KG_PATH_V2_ENABLED false
   cf restart tutorials-srv
   ```

5. Drive 5 more calls (same command as step 2). Wait 5 minutes.

6. Confirm:
   - `kg_path_between_calls_v1_success` (or `_v1_empty`) incremented — v1 SPARQL PATH_BETWEEN is now serving
   - `kg_path_between_latency_ms_v1` reservoir populated
   - `kg_path_between_latency_ms_v2` no longer incrementing

**If step 6 doesn't hold**, the flag doesn't gate cleanly — investigate before opening it up for the observation week. Likely cause: `process.env.KG_PATH_V2_ENABLED` was cached somewhere or the srv restart didn't fully complete.

## After the drill

Append a "Rollback drill — YYYY-MM-DD" section to `docs/superpowers/reviews/2026-07-02-kg-property-graph-spike-task1-notes.md` with the observed counter values and any anomalies. Then flip flag ON for the remainder of the spike week:

```bash
cf set-env tutorials-srv KG_PATH_V2_ENABLED true
cf restart tutorials-srv
```

The maintainer collects the decision-gate evidence during the week; end-of-week they fill in [`docs/superpowers/reviews/2026-07-09-kg-property-graph-spike-review.md`](2026-07-09-kg-property-graph-spike-review.md) (Task 8 skeleton, rename the date if fill-in lands on a different day) and the team reviews.

## Estimated wall-clock

- Merge PR + deploy from main: ~15 min (unless MTA build hits its 10-min timeout — see `feedback_hugo_before_mbt.md`).
- 7.1a–c verification: ~5 min.
- SHORTEST_PATH body iteration: unknown — anywhere from 30 min (if HANA Graph docs match) to blocked (if entitlement/plugin gate).
- Rollback drill: ~30 min (30 s per env-set + restart + 5-min rollup wait, twice).

## Related feedback references

- Always deploy from `main`, never a worktree — `feedback_always_deploy_from_main_primary_tree.md`
- `cf target` before every push — `feedback_cf_target_before_push.md`
- Merge ≠ deploy authorization — `feedback_merge_confirmation_not_deploy_authorization.md`
- Confirm deploy scope with maintainer — `feedback_confirm_deploy_scope.md`
