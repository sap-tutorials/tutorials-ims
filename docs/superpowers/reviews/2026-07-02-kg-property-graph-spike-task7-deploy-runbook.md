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

## Iterating the `SHORTEST_PATH` body

Once the workspace is confirmed created and the procedure is deployed with a placeholder body, the property-graph syntax probe (originally Task 1.3) resumes here. Two experimental approaches to try in order:

### Approach 1 — GraphScript procedure inside KG_PATH_V2's body

```sql
-- Replace the placeholder `paths = SELECT ... FROM DUMMY WHERE 1 = 0;` block
-- in db/src/procedures/KG_PATH_V2.hdbprocedure with:

paths = SELECT
          1                                    AS path_rank,
          CARDINALITY(:v_path) - 2             AS hop_count,
          :vertex                              AS vertex_seq,
          :idx - 1                             AS seq_index
        FROM :v_path
        UNORDERED;
```

You'll need a GraphScript block preceding this to compute `:v_path`. Try:

```sql
DECLARE g GRAPH USING "AC9753D6C4764F5ABE3B3CA4E88233C0"."KG_PG_WORKSPACE";
DECLARE v_from VERTEX = VERTEX(:g, :from_key);
DECLARE v_to   VERTEX = VERTEX(:g, :to_key);
DECLARE v_path = SHORTEST_PATH(:g, :v_from, :v_to, 'ANY');
```

**These are best-guess call shapes based on HANA Graph documentation patterns.** The exact syntax needs iterative testing against the deployed workspace. Update the procedure body, re-deploy via `cf push tutorials-db-deployer`, probe with the DO-block from 7.1c. Repeat until rows come back for a known-connected slug pair.

### Approach 2 — CREATE PROCEDURE ... LANGUAGE GRAPH sibling

If the inline GraphScript block above doesn't compile, HANA may require a separate `LANGUAGE GRAPH` procedure that KG_PATH_V2 then CALLs. Pattern:

```sql
-- New file: db/src/procedures/KG_SHORTEST_PATH_IMPL.hdbprocedure
PROCEDURE KG_SHORTEST_PATH_IMPL(
  IN  workspace_name NVARCHAR(100),
  IN  from_key       NVARCHAR(280),
  IN  to_key         NVARCHAR(280),
  OUT path_vertices  TABLE(vertex_key NVARCHAR(280), seq_index INTEGER)
)
LANGUAGE GRAPH
AS BEGIN
  GRAPH g = Graph(:workspace_name);
  Vertex v_from = Vertex(:g, :from_key);
  Vertex v_to   = Vertex(:g, :to_key);
  MULTISET<VERTEX> path = SHORTEST_PATH(:g, :v_from, :v_to);
  -- flatten into path_vertices with FOREACH...
END;
```

KG_PATH_V2 (SQLScript) then calls it. Same iteration pattern.

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
