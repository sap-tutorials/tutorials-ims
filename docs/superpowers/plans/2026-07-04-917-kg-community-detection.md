# KG Community Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a nightly Louvain community-detection pass over `KG_PG_WORKSPACE`, materialize memberships to a `KgCommunity` sidecar, and surface communities in a Fiori Elements admin tile at `/admin-ui/#kgCommunities` with a `promoteCommunityToMission` action that drafts a Missions row + CompletionPath + tutorials A→Z.

**Architecture:** New HANA GraphScript procedure `KG_LOUVAIN_GRAPH.hdbprocedure` runs `Communities_Louvain` over `KG_PG_WORKSPACE`, wrapped by `srv/jobs/kg-communities-job.js` that TRUNCATE+INSERTs into `KgCommunity` inside one `db.tx`. Task 0 confirms the primitive compiles at our HANA Cloud version — if it doesn't, the fallback is a Node.js iterative Louvain via `graphology-communities-louvain`, and only Tasks 2 & 4 change. Admin tile is a stock FE List Report + Object Page over new `@readonly` projections on `AdminService`.

**Tech Stack:** HANA Cloud (property-graph engine, GraphScript `Communities_Louvain`), SAP CAP (Node.js runtime), CAP 10 Scheduling API (via `srv/cron-service.js`), Fiori Elements List Report / Object Page, Vitest hybrid workspace tests, `job-lock` (distributed lock via `runWithLock` chassis), `metrics.js` (observe/gauge/counter).

**Design spec:** [`docs/superpowers/specs/2026-07-04-917-kg-community-detection-design.md`](../specs/2026-07-04-917-kg-community-detection-design.md)

**Parent spike:** [#913](https://github.com/sap-tutorials/tutorials-ims/issues/913). **Hard prereq:** [#919](https://github.com/sap-tutorials/tutorials-ims/issues/919) — MERGED. **Sibling (same-day landing, template):** [#916](https://github.com/sap-tutorials/tutorials-ims/issues/916). **This issue:** [#917](https://github.com/sap-tutorials/tutorials-ims/issues/917).

## Global Constraints

- **Prereq gate:** #919 (widened `KG_PG_EDGES_V` to 9 predicates) MUST be merged. Confirmed merged 2026-07-04 on `main` (commit history shows `coCompletedWith` in `KG_PG_EDGES_V`).
- **Scope:** DEV-only in v1. No production rollout. No visitor-facing surface. Nothing on OData beyond the two `@readonly` admin projections.
- **Non-goals (per spec):** no auto-mission-creation; no OData exposure of community membership to visitors or the sidebar widget; no per-predicate edge weighting in v1; no "quality" scoring of communities.
- **Env flag:** ~~`KG_COMMUNITIES_ENABLED`~~ **DROPPED from #917 scope.** During Task 10 execution (2026-07-04), grep confirmed no browser-facing shell-config surface exists in this codebase — the precedent this constraint assumed (mirrored from a supposed `jouleEnabled`/`kgEnabled` pattern) does not exist. Joule and Knowledge Graph tiles ship unconditionally in the shell nav today, gated only by XSUAA `Tutorial.Author` scope; their env flags gate srv-side features, not admin-tile visibility. Building a browser-visible config endpoint + async shell sequencing would double this PR's scope. Decision: admin tile is always visible to `Tutorial.Author` scope once deployed. Job runs unconditionally per the original design. See `.superpowers/sdd/task-10-report.md` for the full evidence. Task 10 marked SKIPPED. Task 11's CLAUDE.md gotcha adjusted to drop the flag reference.
- **Sidecar table:** `KgCommunity` — composite key `(communityId, vertexKey)`. NOT `managed`. `@cds.autoexpose: false`. Never on any service projection except the two `@readonly` admin projections defined in Task 6.
- **Missions element:** `sourceKgCommunityId : Integer` (nullable, no default). Distinct from the existing `communityMissionId : String(255)` (legacy IMS field). Populated by `promoteCommunityToMission`; NULL for hand-authored missions.
- **Nightly cron:** `57 3 * * *` (03:57 UTC), off-minute. Neighbours already taken: `:00, :15, :23, :30, :45, :53 (kg-pagerank), 04:33`. `:57` chosen to keep KG jobs close in time (pagerank → communities, same nightly graph snapshot) without collision.
- **QA duality:** GraphScript-procedure precedent (`KG_SHORTEST_PATH_GRAPH`) is to SKIP the `db-qa/` stub — GraphScript workspace + views aren't deployed to `db-qa` so the callable path is unreachable there anyway. This plan follows that precedent; no `db-qa/src/procedures/KG_LOUVAIN_GRAPH.hdbprocedure`.
- **Failure semantic:** every fault path fail-opens. Job failures propagate through the scheduler chassis (PipelineLog FAILED) but never break admin tile reads — an empty `KgCommunity` shows an FE "No data" state, not a 500.
- **Metric names:** `kg_communities_duration_ms` (observe), `kg_communities_count` (gauge, distinct community IDs), `kg_communities_max_size` (gauge), `kg_communities_failures` (counter), `kg_communities_read_failures` (counter, only if a request-time reader is added — v1 doesn't add one).
- **Write-guard:** the SuperAdmin/publish write-guard referenced in `db/schema.cds` as "admin-service.js:788" is a stale comment (the actual line is `initLegacyIdForEntity`). Task 8 greps for the real guard (`@requires` at service level plus per-action explicit role check) and applies the same shape to `promoteCommunityToMission`.

---

## File map

**Create:**
- `db/src/procedures/KG_LOUVAIN_GRAPH.hdbprocedure` — GraphScript proc, calls `Communities_Louvain` over `KG_PG_WORKSPACE`, returns membership rows.
- `db/knowledge-graph-communities.cds` — `KgCommunity` entity + `KgCommunitySummaryV` view. Kept out of `db/knowledge-graph.cds` so unrelated churn stays scoped.
- `srv/jobs/kg-communities-job.js` — `runKgCommunities()` entry point (called by scheduler + AdminService.JobControls).
- `test/hybrid/kg-communities.test.js` — two-community-plus-bridge fixture, real job invocation, sidecar assertions, promote action assertion.
- `app/admin/kgCommunities/webapp/` — FE List Report + Object Page component (manifest.json, Component.js, i18n/i18n.properties, index.html, ui5.yaml, package.json). Generated from the two `AdminService` projections; annotation-driven UI.
- `scripts/kg/probe-louvain-primitive.mjs` — one-shot Task 0 probe.
- `docs/superpowers/reviews/2026-07-04-917-kg-community-detection-task0-notes.md` — Task 0 result artifact (committed).

**Modify:**
- `db/schema.cds` — add `sourceKgCommunityId : Integer;` to `Missions`.
- `srv/jobs/scheduler.js` — import `runKgCommunities`, add `registerJob({...})` block for `kg-communities`.
- `srv/admin-service.cds` — two `@readonly` projections (`KgCommunities`, `KgCommunityMembers`) + `promoteCommunityToMission` action.
- `srv/admin-service.js` — read handler decorating `KgCommunities` with top-3 concept slugs; `promoteCommunityToMission` action handler.
- `app/admin-shell/webapp/manifest.json` — add resourceRoot, componentUsage, route, target for `kgCommunities`.
- `app/admin-shell/webapp/controller/Shell.controller.js` — add `kgCommunities` to `NAV_KEY_TO_ROUTE` and `NAV_KEY_TO_TITLE`.
- `app/admin-shell/webapp/model/navigation.json` — add `{ "key": "kgCommunities", "title": "KG Communities" }` in the System group adjacent to `knowledgeGraph`.
- `CLAUDE.md` — gotcha line for `KG_COMMUNITIES_ENABLED`.

---

## Task list

| # | Task | One-line goal |
|---|---|---|
| 0 | Probe `Communities_Louvain` primitive | Deploy a throwaway probe proc; confirm HDI precompile succeeds and it returns rows at our HANA Cloud version. Decide HANA-native vs Node.js fallback. |
| 1 | Add `KgCommunity` CDS entity + summary view | Land the sidecar in HANA before anything writes to it. |
| 2 | Write and deploy `KG_LOUVAIN_GRAPH.hdbprocedure` | GraphScript proc reads `KG_PG_WORKSPACE`, calls `Communities_Louvain`, returns `(COMMUNITY_ID, VERTEX_KEY, VERTEX_TYPE, SLUG)` rows. |
| 3 | Nightly job body — `srv/jobs/kg-communities-job.js` | Node-side entry point: CALL proc, TRUNCATE + batched INSERT in one `db.tx`, metrics. |
| 4 | Wire the job into `srv/jobs/scheduler.js` | Register `kg-communities` at `57 3 * * *` under `runWithLock`. |
| 5 | Hybrid test — two-community-plus-bridge fixture | Prove Louvain separates two cliques joined by one bridge tutorial. |
| 6 | Add `Missions.sourceKgCommunityId` element + `AdminService` projections + action | Data-model + service surface for the admin tile. |
| 7 | Implement `promoteCommunityToMission` handler | INSERT Missions + CompletionPath + CompletionPathItems A→Z, atomic in one `db.tx`, SecurityEvent audit. |
| 8 | FE admin tile — `app/admin/kgCommunities/webapp/` | Stock FE List Report + Object Page from the two projections. |
| 9 | Shell wiring — nav, manifest, controller | Add `#kgCommunities` route so the tile is reachable when `KG_COMMUNITIES_ENABLED === 'true'`. |
| 10 | ~~Feature-flag gate in shell~~ **SKIPPED** | ~~Hide the nav entry when the env flag isn't on.~~ No shell-config precedent — see Global Constraints and `.superpowers/sdd/task-10-report.md`. |
| 11 | `CLAUDE.md` gotcha line | Future engineers learn about the flag + the job. |
| 12 | Deploy dark, verify data, flip flag | Roll out to DEV with flag OFF, verify data quality, flip flag, monitor. |

---

### Task 0: Probe `Communities_Louvain` primitive

**Goal:** Before writing any HDI artifact, prove the built-in exists at our HANA Cloud version. #916 taught us the primitive enumeration is not always trustworthy — deploy a probe proc against DEV HANA, confirm HDI precompile succeeds and the primitive returns rows. If it fails, we abandon Task 2 as designed and pivot to a Node.js Louvain fallback in Task 3.

**Files:**
- Create: `scripts/kg/probe-louvain-primitive.mjs` — orchestrates the probe.
- Create: `db/src/procedures/KG_LOUVAIN_PROBE.hdbprocedure` — throwaway probe (deleted at end of Task 0).
- Create: `docs/superpowers/reviews/2026-07-04-917-kg-community-detection-task0-notes.md` — committed result artifact.

**Interfaces:**
- Consumes: existing `KG_PG_WORKSPACE`, `KG_PG_VERTICES_V`, `KG_PG_EDGES_V` on DEV HDI.
- Produces: the decision "HANA-native path (default) or Node.js fallback for Task 3", captured in the notes file.

**Prerequisites:** worktree active; `cf login` targeting DEV space; `cds bind` set up (`npm run bind:setup` from a fresh clone).

- [ ] **Step 0.1: Author the probe procedure.**

Create `db/src/procedures/KG_LOUVAIN_PROBE.hdbprocedure` with body:

```sqlscript
PROCEDURE KG_LOUVAIN_PROBE (
  OUT o_result TABLE (
    community_id BIGINT,
    vertex_count BIGINT
  )
)
LANGUAGE GRAPH READS SQL DATA AS
BEGIN
  GRAPH g = Graph("KG_PG_WORKSPACE");
  MULTISET<INTEGER> communities = Communities_Louvain(:g);
  o_result = SELECT :community, COUNT(*) AS vertex_count
             FROM :communities
             GROUP BY :community
             ORDER BY :community;
END;
```

Notes:
- No `SQL SECURITY DEFINER` — GraphScript rejects it (see `KG_SHORTEST_PATH_GRAPH.hdbprocedure`).
- Single-arg `Graph("KG_PG_WORKSPACE")` — HDI enforces schema-local reference.
- Exact primitive name is `Communities_Louvain` per the enumerated set in the #916 pivot notes. Return type per HANA docs is `MULTISET<INTEGER>` keyed by vertex ordinal — adjust the projection if compile fails on syntax and re-probe.

- [ ] **Step 0.2: Deploy and observe.**

Run:

```bash
cd db && cds deploy --to hana 2>&1 | tee /tmp/kg-louvain-probe.log
```

Expected: HDI precompile succeeds. If it fails with `syntax error at <token>` or `Unknown identifier: Communities_Louvain`, capture the exact error and jump to Step 0.5.

- [ ] **Step 0.3: Call the probe.**

Create `scripts/kg/probe-louvain-primitive.mjs`:

```js
#!/usr/bin/env node
import cds from '@sap/cds';

const db = await cds.connect.to('db');
try {
  const t0 = Date.now();
  const rows = await db.run('CALL "KG_LOUVAIN_PROBE"()');
  const ms = Date.now() - t0;
  const communities = rows.length;
  const totalVerts = rows.reduce((s, r) => s + Number(r.VERTEX_COUNT), 0);
  console.log(JSON.stringify({ ok: true, communities, totalVerts, wallClockMs: ms }, null, 2));
  process.exit(0);
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err.message, code: err.code }, null, 2));
  process.exit(1);
}
```

Run:

```bash
cds bind --exec -- node scripts/kg/probe-louvain-primitive.mjs
```

Expected on success: JSON with `ok: true`, `communities >= 2`, `totalVerts` roughly matching the vertex count in `KG_PG_VERTICES_V`, `wallClockMs < 10000` at 17k/40k scale.

- [ ] **Step 0.4: Record the notes.**

Write `docs/superpowers/reviews/2026-07-04-917-kg-community-detection-task0-notes.md` with:

```markdown
# Task 0 probe notes — KG_LOUVAIN

**Date:** <ISO date>
**HANA Cloud version:** <SELECT VERSION FROM M_DATABASE — record it>
**Probe outcome:** SUCCESS | FAILURE
**Wall-clock ms:** <from probe output>
**Communities detected:** <count>
**Total vertices:** <count>
**Decision:** HANA-native path for Task 2/3 | Node.js Louvain fallback for Task 3 (Task 2 dropped)
**Raw probe output:**

```json
<paste probe stdout>
```

**Deploy log snippet (if failure):**

```
<paste relevant HDI error>
```
```

Commit:

```bash
git add scripts/kg/probe-louvain-primitive.mjs \
        db/src/procedures/KG_LOUVAIN_PROBE.hdbprocedure \
        docs/superpowers/reviews/2026-07-04-917-kg-community-detection-task0-notes.md
git commit -m "chore(#917): Task 0 probe for Communities_Louvain primitive"
```

- [ ] **Step 0.5: Clean up the probe artifact (SUCCESS path).**

If Step 0.3 succeeded:

```bash
git rm db/src/procedures/KG_LOUVAIN_PROBE.hdbprocedure
cd db && cds deploy --to hana   # undeploys the throwaway proc
git commit -m "chore(#917): remove Task 0 probe procedure after success"
```

Keep `scripts/kg/probe-louvain-primitive.mjs` and the notes file — the script becomes a re-probe tool if the HANA version changes later.

- [ ] **Step 0.6: Fallback pivot (FAILURE path).**

If Step 0.2 or 0.3 failed, edit the plan header's task map to strike Task 2 and change Task 3's title to "Nightly job body — Node.js Louvain compute + INSERT". The Node.js fallback implementation is spelled out in **Task 3B** below (append-only variant). All other tasks unchanged.

Commit the pivot:

```bash
git add docs/superpowers/plans/2026-07-04-917-kg-community-detection.md
git commit -m "docs(#917): Task 0 pivoted to Node.js Louvain fallback (see notes)"
```

---

### Task 1: Add `KgCommunity` CDS entity + summary view

**Goal:** Land the sidecar table in HANA before any writer targets it. Mirrors #916's `ConceptRank`/`TutorialRank` shape.

**Files:**
- Create: `db/knowledge-graph-communities.cds`

**Interfaces:**
- Produces: HANA table `COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY` with composite PK `(communityId, vertexKey)`; view `COM_SAP_DEVELOPERS_IMS_KGCOMMUNITYSUMMARYV`. Consumed by Task 3 (write), Task 6 (read projection), Task 5 (hybrid test).

**Prerequisites:** Task 0 complete (regardless of outcome — the sidecar shape is identical in both paths).

- [ ] **Step 1.1: Write the CDS.**

Create `db/knowledge-graph-communities.cds`:

```cds
namespace com.sap.developers.ims;

// KgCommunity — per-vertex membership in a Louvain-detected community.
//
// Not @managed on purpose: TRUNCATE + INSERT is atomic inside one db.tx;
// managed timestamps would only add write noise.
//
// @cds.autoexpose: false keeps this off AdminService automatically.
// Task 6 adds two explicit @readonly projections that expose only what
// the admin tile needs.
//
// Composite PK (communityId, vertexKey): a vertex belongs to exactly one
// community per Louvain pass, so this is a natural unique key without
// carrying a synthetic ID.
@cds.autoexpose: false
entity KgCommunity {
  key communityId : Integer;
  key vertexKey   : String(280);      // matches KG_PG_VERTICES_V.VERTEX_KEY
      vertexType  : String(16);       // 'tutorial'|'concept'|'mission'|'group'|'tag'|'product'|'category'
      slug        : String(255);      // widened to max source-entity slug width
      detectedAt  : Timestamp;
}

// KgCommunitySummaryV — LR-facing aggregate. Recomputed on every read;
// KgCommunity holds a few thousand rows at most, so this is free.
@cds.autoexpose: false
view KgCommunitySummaryV as
  select from KgCommunity {
    key communityId,
        count(*)                                                 as memberCount   : Integer,
        sum(case when vertexType = 'tutorial' then 1 else 0 end) as tutorialCount : Integer,
        max(detectedAt)                                          as detectedAt    : Timestamp,
  } group by communityId;
```

- [ ] **Step 1.2: Build and verify.**

Run:

```bash
npx cds compile db --to hana > /tmp/kg-communities-compile.log 2>&1
grep -i "COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY" /tmp/kg-communities-compile.log
```

Expected: two matches — the table and the view. If either is missing, CDS compile errored above; read the log.

- [ ] **Step 1.3: Deploy to DEV HDI.**

```bash
cd db && cds deploy --to hana
```

Expected: `Successfully deployed`, one new table, one new view.

- [ ] **Step 1.4: Commit.**

```bash
git add db/knowledge-graph-communities.cds
git commit -m "feat(#917): KgCommunity sidecar entity and summary view"
```

---

### Task 2: Write and deploy `KG_LOUVAIN_GRAPH.hdbprocedure` (HANA-native path)

**Goal:** GraphScript procedure that reads `KG_PG_WORKSPACE`, calls `Communities_Louvain`, and returns membership rows keyed to `VERTEX_KEY`.

**Skip this task entirely if Task 0 pivoted to the Node.js fallback.** In that case go straight to Task 3B.

**Files:**
- Create: `db/src/procedures/KG_LOUVAIN_GRAPH.hdbprocedure`

**Interfaces:**
- Consumes: `KG_PG_WORKSPACE`, `KG_PG_VERTICES_V` (for `VERTEX_TYPE`, `SLUG` join).
- Produces: table result `(COMMUNITY_ID BIGINT, VERTEX_KEY NVARCHAR(280), VERTEX_TYPE NVARCHAR(16), SLUG NVARCHAR(255))`. Consumed by Task 3.

**Prerequisites:** Task 0 SUCCESS path; Task 1 deployed.

- [ ] **Step 2.1: Write the procedure.**

Create `db/src/procedures/KG_LOUVAIN_GRAPH.hdbprocedure`:

```sqlscript
-- KG_LOUVAIN_GRAPH — community detection over KG_PG_WORKSPACE.
--
-- LANGUAGE GRAPH + READS SQL DATA (no SQL SECURITY DEFINER; GraphScript
-- rejects the clause — workspace-level ACL pins execution to the HDI
-- object owner). Same header shape as KG_SHORTEST_PATH_GRAPH.
--
-- Called nightly by srv/jobs/kg-communities-job.js. Returns one row per
-- vertex, keyed to VERTEX_KEY, tagged with VERTEX_TYPE and SLUG so the
-- caller doesn't have to join back to KG_PG_VERTICES_V.
--
-- Issue #917
PROCEDURE KG_LOUVAIN_GRAPH (
  OUT o_members TABLE (
    community_id BIGINT,
    vertex_key   NVARCHAR(280),
    vertex_type  NVARCHAR(16),
    slug         NVARCHAR(255)
  )
)
LANGUAGE GRAPH READS SQL DATA AS
BEGIN
  GRAPH g = Graph("KG_PG_WORKSPACE");
  MULTISET<INTEGER> communities = Communities_Louvain(:g);
  o_members = SELECT :community    AS community_id,
                     :v."VERTEX_KEY",
                     :v."VERTEX_TYPE",
                     :v."SLUG"
              FROM :communities
              JOIN "KG_PG_VERTICES_V" :v ON :v."VERTEX_KEY" = :vertex_key;
END;
```

Note: the exact projection shape (`:community`, `:vertex_key`) depends on how the primitive keys its result — Task 0's Step 0.3 output shows the actual column names. If Task 0 revealed different key names (e.g., `:vertexId` rather than `:vertex_key`), edit this step to match before deploying.

- [ ] **Step 2.2: Compile.**

```bash
npx cds compile db --to hana 2>&1 | tail -20
```

Expected: no error mentioning `KG_LOUVAIN_GRAPH`.

- [ ] **Step 2.3: Deploy.**

```bash
cd db && cds deploy --to hana
```

Expected: `Successfully deployed`.

- [ ] **Step 2.4: Smoke-call.**

```bash
cds bind --exec -- node -e "
  const cds = require('@sap/cds');
  cds.connect.to('db').then(async db => {
    const rows = await db.run('CALL \"KG_LOUVAIN_GRAPH\"()');
    console.log('rows:', rows.length);
    console.log('sample:', rows.slice(0, 3));
    const uniq = new Set(rows.map(r => r.COMMUNITY_ID));
    console.log('communities:', uniq.size);
    process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
"
```

Expected: hundreds-to-thousands of rows, `communities` between 5 and 100 (order-of-magnitude sanity check for a knowledge graph of this size), no error.

- [ ] **Step 2.5: Commit.**

```bash
git add db/src/procedures/KG_LOUVAIN_GRAPH.hdbprocedure
git commit -m "feat(#917): KG_LOUVAIN_GRAPH — HANA GraphScript Louvain over KG_PG_WORKSPACE"
```


---

### Task 3: Nightly job body — `srv/jobs/kg-communities-job.js` (HANA-native path)

**Goal:** Node-side entry point that calls the HANA proc, TRUNCATE+INSERTs the sidecar in one `db.tx`, and emits metrics. Structure mirrors `srv/jobs/kg-pagerank-job.js` verbatim.

**Skip this task if Task 0 pivoted — use Task 3B instead.**

**Files:**
- Create: `srv/jobs/kg-communities-job.js`

**Interfaces:**
- Consumes: HANA proc `KG_LOUVAIN_GRAPH` (Task 2); table `COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY` (Task 1).
- Produces: exported async function `runKgCommunities()`. Consumed by `srv/jobs/scheduler.js` (Task 4) and `test/hybrid/kg-communities.test.js` (Task 5). Also invocable from `AdminService.JobControls.runJob('kg-communities')` (chassis auto-wires from Task 4).

**Prerequisites:** Tasks 1 and 2 deployed.

- [ ] **Step 3.1: Author the job.**

Create `srv/jobs/kg-communities-job.js`:

```js
// KG community detection nightly job (#917).
//
// Calls HANA GraphScript KG_LOUVAIN_GRAPH, TRUNCATEs KgCommunity, and
// batch-INSERTs the memberships inside one db.tx. Fail-open: errors
// propagate up so the scheduler chassis writes PipelineLog FAILED, but
// no request-time reader breaks because loading is decoupled at Task 6.

import cds from '@sap/cds';
import * as metrics from '../lib/metrics.js';

const LOG = cds.log('kg-communities');

const KG_COMMUNITY_TABLE = '"COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY"';
const INSERT_BATCH_SIZE = 500;

export async function runKgCommunities() {
  const started = Date.now();
  try {
    const db = await cds.connect.to('db');
    const rows = await db.run('CALL "KG_LOUVAIN_GRAPH"()');

    const byCommunity = new Map();
    for (const r of rows) {
      const cid = Number(r.COMMUNITY_ID);
      byCommunity.set(cid, (byCommunity.get(cid) || 0) + 1);
    }
    const maxSize = byCommunity.size ? Math.max(...byCommunity.values()) : 0;

    await db.tx(async (tx) => {
      await tx.run(`TRUNCATE TABLE ${KG_COMMUNITY_TABLE}`);
      const now = new Date().toISOString();
      const insertSql = `INSERT INTO ${KG_COMMUNITY_TABLE}
        ("communityId","vertexKey","vertexType","slug","detectedAt")
        VALUES (?, ?, ?, ?, ?)`;
      for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
        const batch = rows.slice(i, i + INSERT_BATCH_SIZE).map((r) => [
          Number(r.COMMUNITY_ID),
          String(r.VERTEX_KEY),
          String(r.VERTEX_TYPE),
          r.SLUG == null ? null : String(r.SLUG),
          now,
        ]);
        await tx.run(insertSql, batch);
      }
    });

    const durationMs = Date.now() - started;
    metrics.observe('kg_communities_duration_ms', durationMs);
    metrics.gauge('kg_communities_count', byCommunity.size);
    metrics.gauge('kg_communities_max_size', maxSize);
    LOG.info(`[kg-communities] wrote ${rows.length} memberships across ${byCommunity.size} communities (max size ${maxSize}) in ${durationMs}ms`);

    return { rowCount: rows.length, communityCount: byCommunity.size, maxSize, durationMs };
  } catch (err) {
    metrics.counter('kg_communities_failures');
    LOG.error('[kg-communities] failed', err);
    throw err;
  }
}

export default { runKgCommunities };
```

- [ ] **Step 3.2: Ad-hoc invocation.**

```bash
cds bind --exec -- node -e "import('./srv/jobs/kg-communities-job.js').then(async ({ runKgCommunities }) => { const r = await runKgCommunities(); console.log(JSON.stringify(r, null, 2)); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });"
```

Expected: JSON with `rowCount` in the low thousands, `communityCount` between 5 and 100. Re-run twice; both runs succeed (TRUNCATE clears prior rows).

- [ ] **Step 3.3: Verify HANA state.**

```bash
cds bind --exec -- node -e "import('@sap/cds').then(async ({ default: cds }) => { const db = await cds.connect.to('db'); const [{ CNT }] = await db.run('SELECT COUNT(*) AS CNT FROM \"COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY\"'); console.log('KgCommunity rows:', CNT); process.exit(0); });"
```

Expected: matches `rowCount` from Step 3.2.

- [ ] **Step 3.4: Commit.**

```bash
git add srv/jobs/kg-communities-job.js
git commit -m "feat(#917): kg-communities nightly job body"
```

---

### Task 3B: Nightly job body — Node.js Louvain fallback (only if Task 0 pivoted)

**Goal:** Same public interface as Task 3, but compute runs in Node via `graphology-communities-louvain`.

**Skip this task if Task 0 SUCCESS — use Task 3 instead.**

**Files:**
- Create: `srv/jobs/kg-communities-job.js`
- Modify: `package.json` — add `graphology` + `graphology-communities-louvain`.

**Interfaces:** identical to Task 3.

**Prerequisites:** Task 0 FAILURE + pivot commit; Task 1 deployed.

- [ ] **Step 3B.1: Add dependencies.**

```bash
npm install graphology graphology-communities-louvain --save
```

Expected: both under `dependencies` in `package.json`. Combined size ~40kb, MIT, zero native deps.

- [ ] **Step 3B.2: Author the job.**

Create `srv/jobs/kg-communities-job.js`:

```js
// KG community detection nightly job (#917) — Node.js fallback.
// Task 0 confirmed Communities_Louvain does not compile at our HANA
// Cloud version. Compute runs in Node using graphology-communities-louvain
// over KG_PG_VERTICES_V + KG_PG_EDGES_V.

import cds from '@sap/cds';
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import * as metrics from '../lib/metrics.js';

const LOG = cds.log('kg-communities');
const KG_COMMUNITY_TABLE = '"COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY"';
const INSERT_BATCH_SIZE = 500;

// Seeded RNG — Louvain is order-sensitive; deterministic output helps
// hybrid-test stability and PipelineLog diffing between runs.
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export async function runKgCommunities() {
  const started = Date.now();
  try {
    const db = await cds.connect.to('db');
    const [vertices, edges] = await Promise.all([
      db.run('SELECT "VERTEX_KEY","VERTEX_TYPE","SLUG" FROM "KG_PG_VERTICES_V"'),
      db.run('SELECT "SOURCE","TARGET" FROM "KG_PG_EDGES_V"'),
    ]);

    const g = new Graph({ type: 'undirected', multi: false });
    for (const v of vertices) g.addNode(v.VERTEX_KEY, { type: v.VERTEX_TYPE, slug: v.SLUG });
    for (const e of edges) {
      if (e.SOURCE === e.TARGET) continue;
      if (!g.hasNode(e.SOURCE) || !g.hasNode(e.TARGET)) continue;
      if (g.hasEdge(e.SOURCE, e.TARGET)) continue;
      g.addEdge(e.SOURCE, e.TARGET);
    }

    const communities = louvain(g, { rng: seededRng(20260704) });

    const byCommunity = new Map();
    const rows = [];
    for (const v of vertices) {
      const cid = communities[v.VERTEX_KEY];
      if (cid == null) continue;
      byCommunity.set(cid, (byCommunity.get(cid) || 0) + 1);
      rows.push({ communityId: cid, vertexKey: v.VERTEX_KEY, vertexType: v.VERTEX_TYPE, slug: v.SLUG });
    }
    const maxSize = byCommunity.size ? Math.max(...byCommunity.values()) : 0;

    await db.tx(async (tx) => {
      await tx.run(`TRUNCATE TABLE ${KG_COMMUNITY_TABLE}`);
      const now = new Date().toISOString();
      const insertSql = `INSERT INTO ${KG_COMMUNITY_TABLE}
        ("communityId","vertexKey","vertexType","slug","detectedAt")
        VALUES (?, ?, ?, ?, ?)`;
      for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
        const batch = rows.slice(i, i + INSERT_BATCH_SIZE).map((r) => [
          r.communityId, r.vertexKey, r.vertexType, r.slug, now,
        ]);
        await tx.run(insertSql, batch);
      }
    });

    const durationMs = Date.now() - started;
    metrics.observe('kg_communities_duration_ms', durationMs);
    metrics.gauge('kg_communities_count', byCommunity.size);
    metrics.gauge('kg_communities_max_size', maxSize);
    LOG.info(`[kg-communities] wrote ${rows.length} memberships across ${byCommunity.size} communities (max size ${maxSize}) in ${durationMs}ms`);

    return { rowCount: rows.length, communityCount: byCommunity.size, maxSize, durationMs };
  } catch (err) {
    metrics.counter('kg_communities_failures');
    LOG.error('[kg-communities] failed', err);
    throw err;
  }
}

export default { runKgCommunities };
```

- [ ] **Step 3B.3: Ad-hoc invocation.** Same command and expectations as Step 3.2.

- [ ] **Step 3B.4: Commit.**

```bash
git add srv/jobs/kg-communities-job.js package.json package-lock.json
git commit -m "feat(#917): kg-communities job — Node.js Louvain fallback"
```

---

### Task 4: Register the job in `srv/jobs/scheduler.js`

**Goal:** Wire `kg-communities` into the CAP 10 scheduler chassis so it fires nightly at 03:57 UTC.

**Files:**
- Modify: `srv/jobs/scheduler.js`

**Interfaces:**
- Consumes: `runKgCommunities` from Task 3 (or 3B).
- Produces: scheduled `cron.kg-communities` event; `AdminService.JobControls.runJob('kg-communities')` becomes usable for manual triggers.

**Prerequisites:** Task 3 (or 3B) committed.

- [ ] **Step 4.1: Add the import.**

Locate the import block near line 49 of `srv/jobs/scheduler.js` (currently ends with `import { runKgPageRank } from './kg-pagerank-job.js';`). Append:

```js
import { runKgCommunities } from './kg-communities-job.js';
```

- [ ] **Step 4.2: Register the job.**

Locate the `kg-pagerank` `registerJob` block (starts around line 598, ends around line 602). Immediately after its closing `});`, insert:

```js
  // Daily 03:57 UTC — Louvain community detection over KG_PG_WORKSPACE.
  // Runs 4 minutes after kg-pagerank (:53) so both algorithms see the
  // same nightly snapshot of the graph. Off-minute per the "avoid :00
  // and :30" convention. ttlMs 10 min — expected wall-clock is sub-3s
  // (compute) + sub-1s (write); 10 min is loud headroom.
  //
  // Fail-open: errors propagate to PipelineLog FAILED but never break
  // request-time reads (admin tile renders an empty state).
  //
  // Spec: docs/superpowers/specs/2026-07-04-917-kg-community-detection-design.md
  // Issue: #917
  registerJob({
    jobName: 'kg-communities',
    schedule: '57 3 * * *',
    ttlMs: 600000,
    description: 'Nightly Louvain community detection over KG_PG_WORKSPACE — populates KgCommunity sidecar (#917)',
    fn: () => runKgCommunities(),
  });
```

- [ ] **Step 4.3: Restart and observe.**

```bash
npm run dev:hybrid 2>&1 | grep -i 'kg-communities'
```

Expected: two log lines during boot — scheduler registers the job; `CronService.init()` attaches the handler for `cron.kg-communities`.

- [ ] **Step 4.4: Manual trigger via AdminService.**

While `dev:hybrid` is running:

```bash
curl -X POST -u <SuperAdmin-basic-auth> \
  'http://localhost:4004/admin/JobControls_runJob' \
  -H 'Content-Type: application/json' \
  -d '{"jobName":"kg-communities"}'
```

Expected: HTTP 200; JSON echoes the summary from `runKgCommunities`.

- [ ] **Step 4.5: Commit.**

```bash
git add srv/jobs/scheduler.js
git commit -m "feat(#917): register kg-communities nightly job at 03:57 UTC"
```

---

### Task 5: Hybrid test — two-community-plus-bridge fixture

**Goal:** Prove Louvain separates two intentionally-clustered groups of tutorials joined by a single bridge vertex.

**Files:**
- Create: `test/hybrid/kg-communities.test.js`

**Interfaces:**
- Consumes: `runKgCommunities` from Task 3/3B; sidecar from Task 1.
- Produces: passing hybrid test.

**Prerequisites:** Task 4 committed; `cds bind` targeting DEV.

- [ ] **Step 5.1: Author the test.**

Create `test/hybrid/kg-communities.test.js`:

```js
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import crypto from 'node:crypto';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { runKgCommunities } from '../../srv/jobs/kg-communities-job.js';

const TEST_PREFIX = `__test__kg-communities-`;
const RUN_ID = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const P = `${TEST_PREFIX}${RUN_ID}-`;

const A_TUTS = [1, 2, 3, 4, 5].map((n) => `${P}A${n}`);
const B_TUTS = [1, 2, 3, 4, 5].map((n) => `${P}B${n}`);
const BRIDGE = `${P}bridge`;
const CONCEPT_A = `${P}concept-a`;
const CONCEPT_B = `${P}concept-b`;
const CONCEPT_BRIDGE_A = `${P}concept-bridge-a`;
const CONCEPT_BRIDGE_B = `${P}concept-bridge-b`;

let db;

beforeAll(async () => {
  if (!isSafeForWrites()) throw new Error('hybrid write guard refused');
  process.env.ALLOW_HYBRID_WRITES = 'true';
  db = await cds.connect.to('db');
  const kind = db.options?.kind || db.constructor?.name;
  if (!(kind === 'hana' || kind === 'HANAService')) throw new Error(`expected HANA binding, got ${kind}`);

  const { Concepts, Tutorials, ConceptEdges, TutorialConceptLinks } =
    cds.entities('com.sap.developers.ims');

  await INSERT.into(Concepts).entries([
    { slug: CONCEPT_A, label: `A ${RUN_ID}` },
    { slug: CONCEPT_B, label: `B ${RUN_ID}` },
    { slug: CONCEPT_BRIDGE_A, label: `bridge-A ${RUN_ID}` },
    { slug: CONCEPT_BRIDGE_B, label: `bridge-B ${RUN_ID}` },
  ]);
  await INSERT.into(Tutorials).entries(
    [...A_TUTS, ...B_TUTS, BRIDGE].map((slug) => ({ slug, title: slug }))
  );

  const concepts = await SELECT.from(Concepts).columns('ID', 'slug').where({
    slug: { in: [CONCEPT_A, CONCEPT_B, CONCEPT_BRIDGE_A, CONCEPT_BRIDGE_B] },
  });
  const tutorials = await SELECT.from(Tutorials).columns('ID', 'slug').where({
    slug: { in: [...A_TUTS, ...B_TUTS, BRIDGE] },
  });
  const cId = (s) => concepts.find((c) => c.slug === s).ID;
  const tId = (s) => tutorials.find((t) => t.slug === s).ID;

  // Each A-tutorial teaches CONCEPT_A; each B-tutorial teaches CONCEPT_B.
  // Bridge teaches CONCEPT_BRIDGE_A + CONCEPT_BRIDGE_B (one edge each side).
  // CONCEPT_BRIDGE_A relatedTo CONCEPT_A; CONCEPT_BRIDGE_B relatedTo CONCEPT_B.
  await INSERT.into(TutorialConceptLinks).entries([
    ...A_TUTS.map((s) => ({ tutorial_ID: tId(s), concept_ID: cId(CONCEPT_A), predicate: 'teaches' })),
    ...B_TUTS.map((s) => ({ tutorial_ID: tId(s), concept_ID: cId(CONCEPT_B), predicate: 'teaches' })),
    { tutorial_ID: tId(BRIDGE), concept_ID: cId(CONCEPT_BRIDGE_A), predicate: 'teaches' },
    { tutorial_ID: tId(BRIDGE), concept_ID: cId(CONCEPT_BRIDGE_B), predicate: 'teaches' },
  ]);
  await INSERT.into(ConceptEdges).entries([
    { source_ID: cId(CONCEPT_BRIDGE_A), target_ID: cId(CONCEPT_A), predicate: 'relatedTo' },
    { source_ID: cId(CONCEPT_BRIDGE_B), target_ID: cId(CONCEPT_B), predicate: 'relatedTo' },
  ]);
}, 120_000);

afterAll(async () => {
  if (!db) return;
  await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY"
    WHERE LOWER("vertexKey") LIKE 'tutorial:__test__kg-communities-%'
       OR LOWER("vertexKey") LIKE 'concept:__test__kg-communities-%'`);
  await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS"
    WHERE "tutorial_ID" IN (SELECT "ID" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
    WHERE LOWER("slug") LIKE '__test__kg-communities-%')`);
  await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES"
    WHERE "source_ID" IN (SELECT "ID" FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
    WHERE LOWER("slug") LIKE '__test__kg-communities-%')`);
  await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
    WHERE LOWER("slug") LIKE '__test__kg-communities-%'`);
  await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS"
    WHERE LOWER("slug") LIKE '__test__kg-communities-%'`);
}, 60_000);

describe('kg-communities nightly job (hybrid)', () => {
  it('separates two cliques joined by a bridge', async () => {
    const summary = await runKgCommunities();
    expect(summary.rowCount).toBeGreaterThan(0);
    expect(Number.isFinite(summary.durationMs)).toBe(true);

    const rows = await db.run(
      `SELECT "communityId","vertexKey" FROM "COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY"
       WHERE LOWER("vertexKey") LIKE 'tutorial:__test__kg-communities-%'`
    );
    const communityOf = Object.fromEntries(
      rows.map((r) => [r.vertexKey.replace(/^tutorial:/, ''), Number(r.communityId)])
    );

    const aCommunities = new Set(A_TUTS.map((s) => communityOf[s]));
    const bCommunities = new Set(B_TUTS.map((s) => communityOf[s]));
    expect(aCommunities.size).toBe(1);
    expect(bCommunities.size).toBe(1);
    expect([...aCommunities][0]).not.toBe([...bCommunities][0]);
  }, 120_000);
});
```

- [ ] **Step 5.2: Run.**

```bash
npx vitest --project hybrid run test/hybrid/kg-communities.test.js
```

Expected: 1 passed. If Louvain places the bridge into a third singleton community that's fine — the assertion is that A-tutorials share one community and B-tutorials share a different one.

- [ ] **Step 5.3: Commit.**

```bash
git add test/hybrid/kg-communities.test.js
git commit -m "test(#917): hybrid test — Louvain separates two-community-plus-bridge fixture"
```

---

### Task 6: Add `Missions.sourceKgCommunityId` + `AdminService` projections + action definition

**Goal:** Data-model change on `Missions` and the two read-only projections + action stub that the FE tile will bind to. Handler body comes in Task 7.

**Files:**
- Modify: `db/schema.cds`
- Modify: `srv/admin-service.cds`

**Interfaces:**
- Produces: OData entity sets `/admin/KgCommunities` (LR feed) and `/admin/KgCommunityMembers` (OP feed); OData action `/admin/promoteCommunityToMission`. Consumed by the FE tile (Task 8) and Task 7's handler.

**Prerequisites:** Task 1 committed.

- [ ] **Step 6.1: Extend `Missions` in `db/schema.cds`.**

Locate the `entity Missions : TaskBase { ... }` block (currently around lines 50–65 per the pattern recon). Insert this element between `communityMissionId` and `missionType`:

```cds
  // Set when the mission was drafted via promoteCommunityToMission (#917).
  // NULL for hand-authored missions. Distinct from communityMissionId,
  // which is the IMS-legacy community ID from the old CMS import.
  sourceKgCommunityId       : Integer;
```

Confirm there's no annotation collision with an existing element of the same name:

```bash
grep -n 'sourceKgCommunityId' db/schema.cds
```

Expected: one match (the line you just added).

- [ ] **Step 6.2: Compile + deploy.**

```bash
npx cds compile db --to hana 2>&1 | grep -i 'Missions\|sourceKgCommunity'
cd db && cds deploy --to hana
```

Expected: `Missions` alter statement includes new nullable INTEGER column.

- [ ] **Step 6.3: Add projections + action to `srv/admin-service.cds`.**

Append inside the top-level `service AdminService { ... }` block (or in a trailing `extend service AdminService with { ... }` — match the existing style near the file's end where `rebuildContent` lives):

```cds
using { com.sap.developers.ims as ims } from '../db/knowledge-graph-communities';

extend service AdminService with {

  // LR-facing aggregate. One row per detected community.
  @readonly
  entity KgCommunities as projection on ims.KgCommunitySummaryV;

  // OP-facing memberships. Rows keyed to (communityId, vertexKey).
  @readonly
  entity KgCommunityMembers as projection on ims.KgCommunity;

  // Drafts a Mission from the community's tutorial members, ordered A→Z.
  // Curator finishes the draft in the Missions LR (write description,
  // reorder, drop tutorials, publish). Returns the new Mission ID so
  // FE can navigate to it. See srv/admin-service.js for the handler.
  action promoteCommunityToMission(
    communityId : Integer,
    missionSlug : String(255),
    title       : String(255)
  ) returns Missions;
}
```

Compile:

```bash
npx cds compile srv --to json 2>&1 | grep -i 'KgCommunities\|promoteCommunity'
```

Expected: both entity names + the action appear in the compiled CSN.

- [ ] **Step 6.4: Boot check.**

```bash
npm run dev:hybrid 2>&1 | grep -i 'admin.*ready\|error'
```

Then verify the OData surface:

```bash
curl -s -u <SuperAdmin-basic-auth> 'http://localhost:4004/admin/$metadata' | grep -oE 'KgCommunit\w+'
```

Expected: `KgCommunities`, `KgCommunityMembers`, and `promoteCommunityToMission` appear.

- [ ] **Step 6.5: Commit.**

```bash
git add db/schema.cds srv/admin-service.cds
git commit -m "feat(#917): Missions.sourceKgCommunityId + AdminService KgCommunities projections + promote action"
```

---

### Task 7: Implement `promoteCommunityToMission` action handler + top-concepts read decorator

**Goal:** Wire the action to INSERT a Missions row + CompletionPath + CompletionPathItems A→Z inside one `db.tx`, and decorate `KgCommunities` reads with a `topConceptSlugs` computed column.

**Files:**
- Modify: `srv/admin-service.js`

**Interfaces:**
- Consumes: entities `Missions`, `CompletionPaths`, `CompletionPathItems`, `Tutorials`, `KgCommunity` from `com.sap.developers.ims` namespace.
- Produces: OData action handler `promoteCommunityToMission`; `after READ` decorator on `KgCommunities` populating `topConceptSlugs`.

**Prerequisites:** Task 6 committed.

- [ ] **Step 7.1: Find the real write-guard.**

The `db/schema.cds` comment `Write-guard at admin-service.js:788. Issue #348` is stale — the actual line is `initLegacyIdForEntity`. Locate the current SuperAdmin publish gate:

```bash
grep -n "req\.user\.is\|@requires\|superadmin\|SuperAdmin\|role" srv/admin-service.js | head -20
grep -n "@requires\|@restrict" srv/admin-service.cds | head -20
```

Look for the pattern used by other write-heavy actions (`rebuildContent`, `clearChangeLog`). Record the exact role name — typically `tutorials.SuperAdmin` — and reuse it in Step 7.2's `@requires`.

- [ ] **Step 7.2: Gate the action in the CDS.**

Open `srv/admin-service.cds` and locate the `promoteCommunityToMission` block added in Task 6. Add the `@requires` annotation matching the role found in 7.1:

```cds
  @requires: 'tutorials.SuperAdmin'
  action promoteCommunityToMission(
    communityId : Integer,
    missionSlug : String(255),
    title       : String(255)
  ) returns Missions;
```

(Use the exact role name from 7.1 — if it differs from `tutorials.SuperAdmin`, use that instead.)

- [ ] **Step 7.3: Author the handler.**

In `srv/admin-service.js`, near the other action `on(...)` registrations (search for `this.on('rebuildContent'` for the anchor), add:

```js
    // #917 — promote a Louvain community to a draft Mission.
    // Atomic: Missions + CompletionPaths + CompletionPathItems in one tx.
    // Ordering: member tutorials sorted A→Z by title (deterministic; no
    // fake curation intelligence). Curator finishes the draft in the
    // Missions LR (title/description/reorder/publish).
    this.on('promoteCommunityToMission', async (req) => {
      const { communityId, missionSlug, title } = req.data;
      if (!communityId || !missionSlug || !title) {
        return req.reject(400, 'communityId, missionSlug, and title are required');
      }

      const { Missions, CompletionPaths, CompletionPathItems, Tutorials, KgCommunity } =
        cds.entities('com.sap.developers.ims');

      // 1. Load community's tutorial members, joined to Tutorials for ID + title.
      const memberSlugs = (
        await SELECT.from(KgCommunity)
          .columns('slug')
          .where({ communityId, vertexType: 'tutorial' })
      ).map((r) => r.slug);
      if (memberSlugs.length === 0) {
        return req.reject(404, `no tutorial members found for community ${communityId}`);
      }
      const tutorials = await SELECT.from(Tutorials)
        .columns('ID', 'title', 'slug')
        .where({ slug: { in: memberSlugs } })
        .orderBy('title asc');
      if (tutorials.length === 0) {
        return req.reject(404, `community ${communityId} members not found in Tutorials`);
      }

      const missionId = cds.utils.uuid();
      const pathId = cds.utils.uuid();

      // 2. Atomic write.
      await cds.tx(req).run(async (tx) => {
        await tx.run(
          INSERT.into(Missions).entries({
            ID: missionId,
            slug: missionSlug.toLowerCase(),
            title,
            published: false,
            sourceKgCommunityId: communityId,
          })
        );
        await tx.run(
          INSERT.into(CompletionPaths).entries({
            ID: pathId,
            mission_ID: missionId,
            name: 'Default',
            slug: `${missionSlug.toLowerCase()}-default`,
          })
        );
        await tx.run(
          INSERT.into(CompletionPathItems).entries(
            tutorials.map((t, idx) => ({
              ID: cds.utils.uuid(),
              path_ID: pathId,
              tutorial_ID: t.ID,
              taskType: 'tutorial',
              // position element name may differ — verify with grep
              // `entity CompletionPathItems` in db/schema.cds before running.
              // If the field is `sortOrder` or `sequence`, replace here.
              position: idx,
            }))
          )
        );
      });

      // 3. Audit.
      try {
        const { SecurityEvents } = cds.entities('com.sap.developers.ims');
        await INSERT.into(SecurityEvents).entries({
          ID: cds.utils.uuid(),
          event: 'CommunityPromoted',
          target: missionSlug,
          meta: JSON.stringify({ communityId, memberCount: tutorials.length }),
        });
      } catch (err) {
        // Non-fatal — audit failure must not block the promotion.
        cds.log('kg-communities').warn('audit write failed', err);
      }

      // 4. Return the created Mission so FE can navigate to its OP.
      return (await SELECT.one.from(Missions).where({ ID: missionId }));
    });
```

Notes:
- Confirm the position element on `CompletionPathItems` before running by `grep -n 'CompletionPathItems' db/schema.cds` — the recon showed the entity has `taskLegacyId`, `taskType`, associations to `Tutorials/Groups/Prizes`. If the sort element is named differently (e.g. `sortOrder`, `sequence`, `pos`), replace `position` in the entries().
- Confirm `SecurityEvents` entity + column names — if the audit table uses different column names (`eventType`, `entityRef`, `payload`), adjust.

- [ ] **Step 7.4: Author the topConceptSlugs decorator.**

Same file. After the action handler, add:

```js
    // #917 — decorate KgCommunities LR rows with top-3 concept slugs.
    // Computed at read time (not persisted): for each communityId in the
    // result batch, take the 3 concept-type members whose slug appears
    // most often across the same community's tutorial members.
    this.after('READ', 'KgCommunities', async (rows /*, req */) => {
      if (!rows || rows.length === 0) return;
      const { KgCommunity } = cds.entities('com.sap.developers.ims');
      const ids = rows.map((r) => r.communityId);
      const concepts = await SELECT.from(KgCommunity)
        .columns('communityId', 'slug')
        .where({ communityId: { in: ids }, vertexType: 'concept' });
      const byId = new Map();
      for (const c of concepts) {
        if (!byId.has(c.communityId)) byId.set(c.communityId, []);
        byId.get(c.communityId).push(c.slug);
      }
      for (const row of rows) {
        const slugs = byId.get(row.communityId) || [];
        row.topConceptSlugs = slugs.slice(0, 3).join(', ');
      }
    });
```

- [ ] **Step 7.5: Extend the projection with the virtual element.**

Return to `srv/admin-service.cds` and add the `topConceptSlugs` virtual element to the `KgCommunities` projection so the FE tile can bind to it:

```cds
  @readonly
  entity KgCommunities as projection on ims.KgCommunitySummaryV {
    *,
    virtual null as topConceptSlugs : String(255),
  };
```

Deploy:

```bash
cd db && cds deploy --to hana
```

- [ ] **Step 7.6: Ad-hoc test the read decorator.**

```bash
curl -s -u <SuperAdmin-basic-auth> 'http://localhost:4004/admin/KgCommunities?$top=3' | jq '.value[0]'
```

Expected: rows include `topConceptSlugs` populated with comma-separated slugs (or empty string if the community has no concept members).

- [ ] **Step 7.7: Ad-hoc test the action.**

Pick a real `communityId` from the KgCommunity table (from prior nightly run):

```bash
curl -X POST -u <SuperAdmin-basic-auth> \
  'http://localhost:4004/admin/promoteCommunityToMission' \
  -H 'Content-Type: application/json' \
  -d '{"communityId": 42, "missionSlug": "__test__promote-1", "title": "Test Promotion 1"}'
```

Expected: HTTP 200, response body is the new Mission row with `sourceKgCommunityId: 42`, `published: false`. Verify in HANA:

```bash
cds bind --exec -- node -e "
  import('@sap/cds').then(async ({default: cds}) => {
    const db = await cds.connect.to('db');
    const m = await db.run('SELECT * FROM \"COM_SAP_DEVELOPERS_IMS_MISSIONS\" WHERE \"slug\" = ?', ['__test__promote-1']);
    const p = await db.run('SELECT * FROM \"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS\" WHERE \"mission_ID\" = ?', [m[0].ID]);
    const i = await db.run('SELECT * FROM \"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS\" WHERE \"path_ID\" = ?', [p[0].ID]);
    console.log({ missions: m.length, paths: p.length, items: i.length });
    process.exit(0);
  });
"
```

Expected: `{ missions: 1, paths: 1, items: N }` where N is the community's tutorial-member count.

Clean up the test row:

```bash
cds bind --exec -- node -e "
  import('@sap/cds').then(async ({default: cds}) => {
    const db = await cds.connect.to('db');
    await db.run('DELETE FROM \"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS\" WHERE \"path_ID\" IN (SELECT \"ID\" FROM \"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS\" WHERE \"mission_ID\" IN (SELECT \"ID\" FROM \"COM_SAP_DEVELOPERS_IMS_MISSIONS\" WHERE \"slug\" = ?))', ['__test__promote-1']);
    await db.run('DELETE FROM \"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS\" WHERE \"mission_ID\" IN (SELECT \"ID\" FROM \"COM_SAP_DEVELOPERS_IMS_MISSIONS\" WHERE \"slug\" = ?)', ['__test__promote-1']);
    await db.run('DELETE FROM \"COM_SAP_DEVELOPERS_IMS_MISSIONS\" WHERE \"slug\" = ?', ['__test__promote-1']);
    process.exit(0);
  });
"
```

- [ ] **Step 7.8: Extend the hybrid test to cover the action.**

Open `test/hybrid/kg-communities.test.js` from Task 5 and add a second `it(...)`:

```js
  it('promoteCommunityToMission drafts a Mission with all A-tutorials, sorted A→Z', async () => {
    await runKgCommunities();
    const [{ communityId: aCommunityId }] = await db.run(
      `SELECT DISTINCT "communityId" FROM "COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY"
       WHERE "vertexKey" = ?`,
      [`tutorial:${A_TUTS[0]}`]
    );
    const AdminService = await cds.connect.to('AdminService');
    const missionSlug = `${P}mission`;
    const mission = await AdminService.send({
      event: 'promoteCommunityToMission',
      data: { communityId: aCommunityId, missionSlug, title: `Promoted ${RUN_ID}` },
    });
    expect(mission.ID).toBeTruthy();
    expect(mission.sourceKgCommunityId).toBe(aCommunityId);
    expect(mission.published).toBe(false);

    const items = await db.run(
      `SELECT i."position", t."slug" FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS" i
       JOIN "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS" p ON i."path_ID" = p."ID"
       JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t ON i."tutorial_ID" = t."ID"
       WHERE p."mission_ID" = ? ORDER BY i."position"`,
      [mission.ID]
    );
    expect(items.length).toBe(A_TUTS.length);
    for (let i = 1; i < items.length; i++) {
      expect(items[i].slug.localeCompare(items[i - 1].slug)).toBeGreaterThan(0);
    }
  }, 120_000);
```

Extend the `afterAll` cleanup to delete the promoted mission:

```js
  await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"
    WHERE "path_ID" IN (SELECT "ID" FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"
    WHERE "mission_ID" IN (SELECT "ID" FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS"
    WHERE LOWER("slug") LIKE '__test__kg-communities-%'))`);
  await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"
    WHERE "mission_ID" IN (SELECT "ID" FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS"
    WHERE LOWER("slug") LIKE '__test__kg-communities-%')`);
  await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS"
    WHERE LOWER("slug") LIKE '__test__kg-communities-%'`);
```

(Add these three DELETEs BEFORE the KgCommunity/Tutorial/Concept deletes already present.)

- [ ] **Step 7.9: Run the hybrid test.**

```bash
npx vitest --project hybrid run test/hybrid/kg-communities.test.js
```

Expected: 2 passed.

- [ ] **Step 7.10: Commit.**

```bash
git add srv/admin-service.js srv/admin-service.cds test/hybrid/kg-communities.test.js
git commit -m "feat(#917): promoteCommunityToMission handler + topConceptSlugs decorator + action test"
```

---

### Task 8: FE admin tile — `app/admin/kgCommunities/webapp/`

**Goal:** Stock FE List Report + Object Page over `AdminService.KgCommunities` and `AdminService.KgCommunityMembers`. No custom UI code beyond the manifest and annotation-driven line-items.

**Files:**
- Create: `app/admin/kgCommunities/webapp/manifest.json`
- Create: `app/admin/kgCommunities/webapp/Component.js`
- Create: `app/admin/kgCommunities/webapp/index.html` (may not be needed if hosted componentUsage-only, but include for FE dev-mode)
- Create: `app/admin/kgCommunities/webapp/i18n/i18n.properties`
- Create: `app/admin/kgCommunities/webapp/annotations/annotations.cds` OR inline in manifest.json under `sap.ui.generic.app` — match the missions/ tile pattern.
- Create: `app/admin/kgCommunities/package.json` + `ui5.yaml` (mirror `app/admin/missions/`).

**Interfaces:**
- Consumes: `AdminService.KgCommunities` (LR feed), `AdminService.KgCommunityMembers` (OP feed), action `AdminService.promoteCommunityToMission`.
- Produces: a UI5 component `sap.tutorials.admin.kgCommunities` loadable at `/admin-ui/#kgCommunities`.

**Prerequisites:** Task 7 committed; `app/admin/missions/webapp/manifest.json` is the reference template.

- [ ] **Step 8.1: Scaffold the folder from missions/ template.**

```bash
cp -r app/admin/missions app/admin/kgCommunities
cd app/admin/kgCommunities
grep -rl 'missions\|Missions\|MISSION' webapp | xargs -I {} echo "review: {}"
```

Do a careful global rename: `Missions` → `KgCommunityMembers`, `MissionsList` → `KgCommunitiesList`, `MissionsObjectPage` → `KgCommunityObjectPage`, path `/Missions` → `/KgCommunities`, `sap.tutorials.admin.missions` → `sap.tutorials.admin.kgCommunities`. Do NOT rename the CompletionPaths sub-navigation — instead drop that route entirely (KgCommunities has no sub-navigation).

- [ ] **Step 8.2: Adjust `manifest.json`.**

Set `sap.app.id` to `sap.tutorials.admin.kgCommunities`. Set `sap.app.dataSources.mainService.uri` to `/admin/`. Set `sap.ui.generic.app` (or `sap.fe`) routing to two targets: LR over `/KgCommunities` and OP over `/KgCommunityMembers`. Remove the CompletionPaths route.

Line-items for LR — configure via `com.sap.vocabularies.UI.v1.LineItem` annotation targeting `AdminService.KgCommunities`:

```
communityId, memberCount, tutorialCount, topConceptSlugs, detectedAt
```

Sort default: `memberCount desc`. Filter bar: `memberCount` (range), `detectedAt` (range), `alreadyPromoted` (custom filter — see Step 8.4).

OP header — bind to `KgCommunityMembers` grouped by `communityId` (use `contextPath` `/KgCommunityMembers({communityId=...,vertexKey=...})` isn't right; the correct pattern is a separate lightweight OP against `KgCommunities({communityId})` with a table facet showing memberships). Cleanest: OP over `KgCommunities` with a `to_members` navigation added in Task 6 (skipped for v1; use a separate table facet filtered client-side by `communityId`).

- [ ] **Step 8.3: Add the `promoteToMission` action button.**

In manifest annotations (or `annotations/annotations.cds`), add:

```cds
annotate AdminService.KgCommunities with @(
  UI.Identification: [
    { $Type: 'UI.DataFieldForAction',
      Action: 'AdminService.promoteCommunityToMission',
      Label: 'Promote to Mission',
      Determining: true
    }
  ]
);
```

FE will render this as a header button on the OP. When clicked FE opens a parameter dialog for `missionSlug` and `title`; on submit, it calls the action and navigates to the created Mission (FE auto-follows a `returns Missions` action).

- [ ] **Step 8.4: `alreadyPromoted` filter (server-side, via the LR filter).**

The projection `KgCommunities` currently has no reference to `sourceKgCommunityId` on `Missions`. Rather than add a client filter, extend the projection in `srv/admin-service.cds` with a virtual boolean computed server-side (in the same `after READ` handler at Task 7.4):

Update the CDS projection:

```cds
  @readonly
  entity KgCommunities as projection on ims.KgCommunitySummaryV {
    *,
    virtual null as topConceptSlugs   : String(255),
    virtual null as alreadyPromoted   : Boolean,
  };
```

Update the `after READ` handler in `srv/admin-service.js` to populate `alreadyPromoted`:

```js
    // (Add near the topConceptSlugs population, inside the same after('READ', 'KgCommunities') handler.)
    const promoted = await SELECT.from(Missions)
      .columns('sourceKgCommunityId')
      .where({ sourceKgCommunityId: { in: ids } });
    const promotedSet = new Set(promoted.map((m) => m.sourceKgCommunityId));
    for (const row of rows) {
      row.alreadyPromoted = promotedSet.has(row.communityId);
    }
```

(Add `Missions` to the `cds.entities(...)` destructure at the top of the handler if not already present.)

In the FE manifest, configure the LR filter bar to hide already-promoted rows by default via `SelectionFields` + a default filter value.

- [ ] **Step 8.5: Verify FE build.**

```bash
cd app/admin/kgCommunities && npm install && npx ui5 build
```

Expected: build succeeds, produces a `dist/` folder.

- [ ] **Step 8.6: Manual smoke — mount into shell.**

Defer to Task 9 (shell wiring). For now, run the FE tile standalone:

```bash
npx ui5 serve
# Open http://localhost:8080/index.html?sap-ui-xx-viewCache=false
```

Expected: LR loads and renders rows from `/admin/KgCommunities`.

- [ ] **Step 8.7: Commit.**

```bash
git add app/admin/kgCommunities srv/admin-service.cds srv/admin-service.js
git commit -m "feat(#917): FE admin tile for KgCommunities + alreadyPromoted decorator"
```

---

### Task 9: Wire the tile into `app/admin-shell/`

**Goal:** Make `/admin-ui/#kgCommunities` route to the new component.

**Files:**
- Modify: `app/admin-shell/webapp/manifest.json`
- Modify: `app/admin-shell/webapp/controller/Shell.controller.js`
- Modify: `app/admin-shell/webapp/model/navigation.json`

**Prerequisites:** Task 8 committed.

- [ ] **Step 9.1: Add resourceRoot.**

In `app/admin-shell/webapp/manifest.json`, locate the `resourceRoots` block (around line 43, adjacent to `"sap.tutorials.admin.missions"`). Add:

```json
"sap.tutorials.admin.kgCommunities": "./components/kgCommunities",
```

- [ ] **Step 9.2: Add componentUsage.**

Locate the `componentUsages` block (around line 105, adjacent to `missionsComponent`). Add:

```json
"kgCommunitiesComponent": {
  "name": "sap.tutorials.admin.kgCommunities",
  "settings": {},
  "componentData": {},
  "lazy": true
},
```

- [ ] **Step 9.3: Add route.**

Locate the `routes` block (around line 301, adjacent to `missions`). Add:

```json
{ "name": "kgCommunities", "pattern": "kgCommunities", "target": [{ "name": "kgCommunitiesTarget", "prefix": "kc" }] },
```

- [ ] **Step 9.4: Add target.**

Locate the `targets` block (around line 350, adjacent to `missionsTarget`). Add:

```json
"kgCommunitiesTarget": {
  "type": "Component",
  "usage": "kgCommunitiesComponent",
  "id": "kgCommunitiesTarget",
  "viewLevel": 1,
  "prefix": "kc"
},
```

- [ ] **Step 9.5: Update Shell.controller.js dicts.**

In `app/admin-shell/webapp/controller/Shell.controller.js`, locate `var NAV_KEY_TO_ROUTE = {...}` (near line 9). Add adjacent to `knowledgeGraph: "knowledgeGraph",`:

```js
    kgCommunities: "kgCommunities",
```

Same for `NAV_KEY_TO_TITLE`:

```js
    kgCommunities: "KG Communities",
```

- [ ] **Step 9.6: Update navigation.json.**

In `app/admin-shell/webapp/model/navigation.json`, locate the `"System"` group. Add after the `knowledgeGraph` entry:

```json
      { "key": "kgCommunities", "title": "KG Communities" },
```

- [ ] **Step 9.7: Manual verify.**

```bash
npm run dev:hybrid
# Open http://localhost:5000/admin-ui/#kgCommunities
```

Expected: LR renders. Nav entry visible under System.

- [ ] **Step 9.8: Commit.**

```bash
git add app/admin-shell/webapp/manifest.json \
        app/admin-shell/webapp/controller/Shell.controller.js \
        app/admin-shell/webapp/model/navigation.json
git commit -m "feat(#917): shell wiring for #kgCommunities tile"
```

---

### Task 10: Feature-flag gate in shell (`KG_COMMUNITIES_ENABLED`)

**Goal:** Hide the nav entry — and refuse the route — when `KG_COMMUNITIES_ENABLED` is not `'true'`.

**Files:**
- Modify: `app/admin-shell/webapp/controller/Shell.controller.js` (or wherever the shell reads its config surface)
- Modify: whatever server config endpoint the shell fetches its runtime config from (typically `/admin-shell/config.json` served by `srv/lib/admin-shell-config.js` or similar — grep to find it)

**Prerequisites:** Task 9 committed.

- [ ] **Step 10.1: Locate the shell's runtime-config endpoint.**

```bash
grep -rn 'admin-shell/config\|shell.*config\|configService' srv/ app/admin-shell/ | head -20
```

Expected: some endpoint like `/admin-shell/config` or a `srv/lib/shell-config.js` that returns feature flags as JSON. The joule / knowledgeGraph tiles almost certainly use the same mechanism — model your addition on theirs.

- [ ] **Step 10.2: Expose `KG_COMMUNITIES_ENABLED` in the config.**

Edit the config surface to include:

```js
kgCommunitiesEnabled: process.env.KG_COMMUNITIES_ENABLED === 'true',
```

Match the exact style of neighboring flags (`kgEnabled`, `jouleEnabled`, etc.).

- [ ] **Step 10.3: Consume in the shell controller.**

In `Shell.controller.js`, add a filter step at the point where the nav model is loaded that removes the `kgCommunities` entry when `kgCommunitiesEnabled === false`. Find the analogous handling for other feature-flagged tiles (Joule is the most likely precedent) and mirror it.

- [ ] **Step 10.4: Verify OFF.**

```bash
cf unset-env tutorials-srv KG_COMMUNITIES_ENABLED   # or just don't set it locally
npm run dev:hybrid
# Open http://localhost:5000/admin-ui/
```

Expected: nav entry not visible.

- [ ] **Step 10.5: Verify ON.**

```bash
KG_COMMUNITIES_ENABLED=true npm run dev:hybrid
# Open http://localhost:5000/admin-ui/#kgCommunities
```

Expected: nav entry visible; route resolves.

- [ ] **Step 10.6: Commit.**

```bash
git add app/admin-shell srv/lib/  # whichever files changed
git commit -m "feat(#917): KG_COMMUNITIES_ENABLED gates the tile visibility"
```

---

### Task 11: Update `CLAUDE.md` gotcha line

**Goal:** Future agents learn about the flag, the job schedule, and the DEV-only scope in one line, matching the existing "Top Gotchas" style.

**Files:**
- Modify: `CLAUDE.md`

**Prerequisites:** Task 10 committed.

- [ ] **Step 11.1: Add the line.**

In `CLAUDE.md` under `## Top Gotchas`, after the `KG_PAGERANK_ENABLED` bullet, add:

```markdown
- **`KG_COMMUNITIES_ENABLED` env var (issue #917)** — when `'true'`, the `#kgCommunities` admin tile at `/admin-ui/#kgCommunities` renders a List Report of Louvain-detected communities over `KG_PG_WORKSPACE` and offers a `promoteCommunityToMission` action that drafts a Mission with tutorials A→Z. Nightly job at 03:57 UTC (`srv/jobs/kg-communities-job.js`) always writes the `KgCommunity` sidecar regardless of the flag — the flag only gates tile visibility so flipping it on is instant. Fail-open on job failures (empty sidecar → empty LR). DEV-only in v1; PROD deferred. Toggle: `cf set-env tutorials-srv KG_COMMUNITIES_ENABLED true && cf restart tutorials-srv`.
```

- [ ] **Step 11.2: Commit.**

```bash
git add CLAUDE.md
git commit -m "docs(#917): CLAUDE.md gotcha line for KG_COMMUNITIES_ENABLED"
```

---

### Task 12: Deploy dark, verify data, flip flag

**Goal:** Land the whole feature in DEV with the flag OFF. Confirm nightly data quality on one real run. Flip the flag. Monitor.

**Files:** none — this is an operational task.

**Prerequisites:** Tasks 1–11 committed and merged to `main`.

- [ ] **Step 12.1: Merge PR to main.**

Ensure the PR from this worktree is merged with all reviews satisfied. Confirm via `gh pr status`.

- [ ] **Step 12.2: Deploy dark to DEV.**

From the primary tree on `main`:

```bash
cf target -o <dev-org> -s dev
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

Confirm `KG_COMMUNITIES_ENABLED` is NOT set:

```bash
cf env tutorials-srv | grep KG_COMMUNITIES_ENABLED
```

Expected: no output (flag off).

- [ ] **Step 12.3: Trigger the job manually.**

Via `AdminService.JobControls.runJob('kg-communities')` from the admin shell, or:

```bash
curl -X POST -u <SuperAdmin> 'https://<dev-approuter>/admin/JobControls_runJob' \
  -H 'Content-Type: application/json' \
  -d '{"jobName":"kg-communities"}'
```

Expected: HTTP 200; PipelineLog shows a `kg-communities` SUCCESS row with `rowCount`, `communityCount`, `maxSize`, `durationMs`.

- [ ] **Step 12.4: Sanity-check the data.**

```bash
cf ssh tutorials-srv -c 'echo "select COUNT(*) from COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY;" | hdbsql -i 90 -d $VCAP_SERVICES...'
```

Or (easier) hit `AdminService.KgCommunities`:

```bash
curl -s -u <SuperAdmin> 'https://<dev-approuter>/admin/KgCommunities?$orderby=memberCount desc&$top=5' | jq
```

Expected:
- Between 5 and 100 distinct communities.
- Largest community < 30% of total vertex count (otherwise Louvain likely collapsed; investigate).
- `topConceptSlugs` populated for the top 5.
- `detectedAt` matches the manual run time (or the last nightly run).

- [ ] **Step 12.5: Flip the flag.**

```bash
cf set-env tutorials-srv KG_COMMUNITIES_ENABLED true
cf restart tutorials-srv
```

- [ ] **Step 12.6: Verify the tile.**

Open `https://<dev-approuter>/admin-ui/#kgCommunities`. Expected: LR renders. Click the largest community → OP renders memberships grouped by vertexType. Try `promoteCommunityToMission` on a small test community (3-5 tutorials): expect a Mission draft in `/admin-ui/#missions` with the correct tutorials A→Z. Delete the test mission afterwards.

- [ ] **Step 12.7: Monitor overnight.**

Confirm the 03:57 UTC run fires and succeeds — check `PipelineLog` for a `kg-communities` SUCCESS row the next morning. If it fails, PipelineLog + Cloud Foundry app logs (`cf logs tutorials-srv --recent | grep kg-communities`) show the reason. Fail-open behavior means no user-facing surface breaks — investigate and re-run manually.

- [ ] **Step 12.8: Close the issue.**

```bash
gh issue close 917 --comment "Landed in main. DEV-only. Task 0 outcome: <HANA-native | Node.js fallback>. See docs/superpowers/plans/2026-07-04-917-kg-community-detection.md for the shipped plan and docs/superpowers/reviews/2026-07-04-917-kg-community-detection-task0-notes.md for the primitive-probe outcome."
```

---

## Self-Review

Ran the plan against the spec — findings and fixes applied inline:

1. **Spec coverage:**
   - Nightly Louvain over `KG_PG_WORKSPACE` → Tasks 2/3 (HANA-native) or 3B (Node fallback).
   - `KgCommunity` sidecar (composite key, `@cds.autoexpose: false`) → Task 1.
   - Task 0 primitive probe with locked fallback → Task 0 explicitly written; Task 3B is the fallback body.
   - FE List Report + Object Page at `/admin-ui/#kgCommunities` → Tasks 8 (component) + 9 (shell wiring).
   - `promoteCommunityToMission` action with tutorials A→Z + SuperAdmin gate + audit → Task 7.
   - `Missions.sourceKgCommunityId` element (distinct from legacy `communityMissionId`) → Task 6.
   - `KG_COMMUNITIES_ENABLED` flag → Task 10.
   - Nightly schedule 03:57 UTC → Task 4.
   - Hybrid test with two-community-plus-bridge fixture → Task 5; extended for action in Task 7.8.
   - Rollback (unset env var → tile hidden; drop table → full removal) → covered in the CLAUDE.md gotcha (Task 11) and spec's Rollback section.
   - Metrics — `kg_communities_duration_ms`, `_count`, `_max_size`, `_failures` → Task 3/3B.
   - DEV-only scope → global constraints.
   - QA-channel duality → global constraints (skipped per `KG_SHORTEST_PATH_GRAPH` precedent).

2. **Placeholder scan:** none — no TBD/TODO/FIXME/"handle edge cases"/"similar to Task N". Every step has concrete code, commands, or annotations.

3. **Type consistency:**
   - `runKgCommunities()` return shape `{ rowCount, communityCount, maxSize, durationMs }` used consistently in Task 3, 3B, 4.4, 5.1's assertions.
   - `KgCommunity` column names (`communityId`, `vertexKey`, `vertexType`, `slug`, `detectedAt`) match across Task 1 (CDS), Task 3/3B (INSERT), Task 5 (test SELECTs), Task 7 (join queries).
   - `promoteCommunityToMission(communityId : Integer, missionSlug : String(255), title : String(255)) returns Missions` — matches action signature in Task 6.3, handler in Task 7.3, and test call in Task 7.8.
   - `sourceKgCommunityId : Integer` (never `communityId`, never `sourceCommunityId`) — matches across schema (Task 6.1), handler (Task 7.3), test assertion (Task 7.8), and the `alreadyPromoted` decorator (Task 8.4).

4. **Ambiguities/risks noted:**
   - Task 7.3 step notes the `position` element on `CompletionPathItems` needs a `grep` confirmation — if the codebase uses a different sort element name, the step explicitly instructs the engineer to substitute.
   - Task 7.1 makes explicit that the "admin-service.js:788" write-guard comment is stale; the plan tells the engineer to grep for the real guard rather than assume the line number.
   - Task 8.2 flags that the `KgCommunities` → `KgCommunityMembers` navigation is not modeled in v1; the OP filters memberships client-side by `communityId`. If this proves clunky in review, adding a `to_members : Association to many KgCommunityMembers on ...` element to the summary view is a small follow-on that would clean the FE binding.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-04-917-kg-community-detection.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach?
