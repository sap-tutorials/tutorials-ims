# KG: community detection for auto-suggested missions/groups — Design

**Issue:** [#917](https://github.com/sap-tutorials/tutorials-ims/issues/917)
**Prereq:** [#919](https://github.com/sap-tutorials/tutorials-ims/issues/919) (widened `KG_PG_WORKSPACE` to 9-predicate parity) — **merged 2026-07-04**, `coCompletedWith` and 6 other edge types are live in `KG_PG_EDGES_V`.
**Parent spike:** [#913](https://github.com/sap-tutorials/tutorials-ims/issues/913), design in [`2026-07-02-913-kg-property-graph-spike-design.md`](2026-07-02-913-kg-property-graph-spike-design.md), gate graduated 2026-07-04.
**Sibling:** [#916 PageRank](2026-07-04-916-kg-pagerank-design.md) — landed 2026-07-04 (commits 187e2b49, 6a715d0f). Templates the sidecar / scheduler / hybrid-test shape reused here.
**Scope:** DEV-only in v1. PROD rollout is out of scope.
**Date:** 2026-07-04

## Problem

Missions and Groups are **curated entirely by hand**. Curators guess at
cluster boundaries by reading tutorials one at a time, and this misses
non-obvious clusters that emerge from concept co-occurrence and cohort
co-completion patterns. As the graph grows past ~800 tutorials, browsing
becomes impractical and legitimate clusters go unnoticed.

## Proposal

A nightly Louvain pass over `KG_PG_WORKSPACE` (the full 9-predicate
graph, post-#919) produces community IDs for every vertex — tutorials,
concepts, missions, groups, tags, products, categories. Memberships are
materialized into a sidecar table `KgCommunity` and surfaced in a new
Fiori Elements admin tile at `/admin-ui/#kg-communities`:

- **List Report** — one row per detected community, aggregated:
  member count, tutorial count, top-3 concept slugs, `detectedAt`.
- **Object Page** — drill-down listing every member vertex, grouped by
  type. Carries a `promoteToMission(missionSlug, title)` action that
  creates a draft `Missions` row + one `CompletionPaths` variant +
  `CompletionPathItems` bound to the community's tutorial members
  (ordered A→Z by title, deterministic). Curator then opens the mission
  in the Missions LR to finish it — write description, reorder, drop
  tutorials, publish.

Communities are **suggestions**, not auto-created missions. Nothing on
this surface is visitor-facing.

## Design decisions (locked during brainstorm)

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| Q1 | Compute engine | **HANA GraphScript** (`KG_LOUVAIN_GRAPH.hdbprocedure`) calling built-in `Communities_Louvain` | The #916 pivot enumerated `BUILTIN_FUNCTIONS_ALGORITHMS` and confirmed `Communities_Louvain` **is** in the set (unlike PageRank). In-DB, sub-second, matches `KG_SHORTEST_PATH_GRAPH` sibling pattern. Gated behind a Task 0 confirmation probe — if `Communities_Louvain` doesn't actually compile at our HANA Cloud version, fall back to Option B without redesigning the rest. |
| Q1-fallback | Task 0 fail path | Node.js iterative Louvain via `graphology-communities-louvain` (MIT, single dep, ~40kb) | Reuses #916's job body shape verbatim. Rest of the design (sidecar, tile, action, tests) unchanged. |
| Q2 | Admin tile shape | **FE List Report + Object Page + `promoteToMission` action** | Copies the `app/admin/missions/` FE pattern; minimum custom UI code. Object Page gives room for filtering/sorting when communities grow. |
| Q3 | Sidecar shape | **One flat memberships table** `KgCommunity { key communityId; key vertexKey; vertexType; slug; detectedAt }`, plus a CDS view `KgCommunitySummaryV` for the LR aggregates | Simplest write path (single TRUNCATE+INSERT batch); aggregates computed on-the-fly like `ConceptRank`. Mirrors how #916 stores rank scores. |
| Q4 | Edge weighting | **Unweighted (all edges weight 1.0)** | Simplest first cut; Louvain sees pure topology. `coCompletedWith` will dominate community boundaries by count (largest arm, ~20k rows), which is fine for v1 — communities reflect learner behavior as much as curator intent. If curators say "these look weird", per-predicate weights come in v2. |
| Q5 | Vertex scope | **All 7 vertex types** (`tutorial`, `concept`, `mission`, `group`, `tag`, `product`, `category`) mixed | Cleanest match to the graph as it exists. The LR's aggregate view filters memberships to `vertexType = 'tutorial'` for the display count; the OP lists all types grouped. |
| Q6 | Promote-to-mission | **Draft mission + CompletionPath + tutorials A→Z, curator finishes** | Reuses existing `Missions`/`CompletionPaths`/`CompletionPathItems` chassis; `Missions.sourceCommunityId : Integer` element added so promoted communities show a badge and are skipped from future suggestion tiles. `published: false` on create — curator publishes only after finishing. |
| Q7 | Job schedule | **Nightly at 03:57 UTC** (unused off-minute; #916 owns :53) | Off-minute per the "avoid :00 / :30" convention. Runs after PageRank so both algorithms operate on the same nightly snapshot of `KG_PG_WORKSPACE`. |
| Q8 | Feature flag | **`KG_COMMUNITIES_ENABLED` env var** — gates admin tile visibility only; job always writes | Same shape as `KG_PAGERANK_ENABLED`. Off → tile hidden in shell nav, but nightly writes still populate the sidecar so a flip-on is instant. Fail-open at read time: missing sidecar rows → empty LR, not a 500. |
| Q9 | Test scope | Hybrid test with a **two-community-plus-bridge** fixture; unit test for the Node.js fallback compute if Task 0 fails | Deterministic 12-tutorial fixture: two 5-tutorial cliques joined by one bridge tutorial. Assert Louvain returns exactly 2 (or 3, if bridge lands in its own singleton) communities and the cliques land in separate ones. |

## Architecture

```text
03:57 UTC nightly
  → CronService (CAP 10 Scheduling API, srv/cron-service.js)
    → cron.kg-communities event
      → runKgCommunities()  [srv/jobs/kg-communities-job.js]
        → CALL KG_LOUVAIN_GRAPH()   [db/src/procedures/, DEFINER pattern]
          → HANA Communities_Louvain over KG_PG_WORKSPACE
          → returns rows: (COMMUNITY_ID, VERTEX_KEY, VERTEX_TYPE, SLUG)
        → db.tx: TRUNCATE KgCommunity → batched INSERT (500/batch)
        → metrics: kg_communities_{run_seconds,count,max_size,failures}

request-time (admin)
  GET /admin-ui/#kg-communities
    → AdminService.KgCommunities (@readonly projection over KgCommunitySummaryV)
    → drill: AdminService.KgCommunityMembers (@readonly over KgCommunity)
    → action: promoteToMission(missionSlug, title) → creates Missions draft
```

## Data model

New file `db/knowledge-graph-communities.cds` (kept separate from
`db/knowledge-graph.cds` so unrelated churn stays scoped):

```cds
using { com.sap.developers.ims } from './knowledge-graph';

namespace com.sap.developers.ims;

@cds.autoexpose: false
entity KgCommunity {
  key communityId : Integer;
  key vertexKey   : String(280);
      vertexType  : String(16);   // 'tutorial' | 'concept' | 'mission' | 'group' | 'tag' | 'product' | 'category'
      slug        : String(255);
      detectedAt  : Timestamp;
}

@cds.autoexpose: false
view KgCommunitySummaryV as
  select from KgCommunity {
    key communityId,
    count(*)                                                as memberCount   : Integer,
    sum(case when vertexType = 'tutorial' then 1 else 0 end) as tutorialCount : Integer,
    max(detectedAt)                                          as detectedAt    : Timestamp,
  } group by communityId;
```

**Top-concept extraction for the LR** is computed by a Node.js `on(READ)`
handler on `AdminService.KgCommunities` in `admin-service.js` that
decorates each row after the DB read: for each `communityId`, look up
the top-3 `slug` values from `KgCommunity` where `vertexType = 'concept'`
(ordered by degree — count of tutorial memberships in the same community
sharing that concept). Held in Node rather than the view because HANA
string aggregation would need a DEFINER hop and the LR opens with 50-ish
rows, well within a batch fetch. Details locked in the implementation
plan.

`Missions.sourceCommunityId : Integer` element added to `db/schema.cds`
(nullable, no default). Populated by `promoteToMission`; unpopulated for
hand-authored missions. Used by the LR to hide already-promoted
communities via a `where sourceCommunityId is null` filter parameter on
the tile.

### HANA table name

`COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY` — referenced via string constant in
the job, same convention as `kg-pagerank-job.js` uses for
`COM_SAP_DEVELOPERS_IMS_CONCEPTRANK`.

## HANA procedure

New `db/src/procedures/KG_LOUVAIN_GRAPH.hdbprocedure`:

```sqlscript
PROCEDURE "KG_LOUVAIN_GRAPH"()
  LANGUAGE GRAPH
  READS SQL DATA
AS BEGIN
  GRAPH g = Graph("KG_PG_WORKSPACE");
  MULTISET<INTEGER> communityIds = Communities_Louvain(:g);
  -- flatten to a table result matching KgCommunity shape
  ...
END;
```

**No `SQL SECURITY DEFINER`** — `LANGUAGE GRAPH` does not accept the
clause; the workspace-level ACL already pins execution identity to the
HDI object owner. Same pattern as `KG_SHORTEST_PATH_GRAPH`.

**QA-channel stub**: `db-qa/src/procedures/KG_LOUVAIN_GRAPH.hdbprocedure`
with a `SIGNAL KG_NOT_AVAILABLE_ON_QA` body; workspace + views not
deployed to `db-qa`. Same shape as the existing QA stubs for other KG
procedures.

**Task 0 gate** (must pass before Task 1 lands):

1. Author a probe procedure that calls `Communities_Louvain` and
   returns a single integer count.
2. Deploy via `cds deploy --to hana`.
3. Confirm HDI precompile succeeds and the procedure returns rows.
4. If HDI errors (as `PAGE_RANK` did in #916), abandon Q1 and switch to
   the Node.js Louvain fallback. Rest of the spec stays.
5. Notes captured in
   `docs/superpowers/reviews/2026-07-04-917-kg-community-detection-task0-notes.md`
   (whether primitive works, wall-clock at 17k/40k, decision).

## Job

New `srv/jobs/kg-communities-job.js`. Structure copies
`kg-pagerank-job.js` verbatim; the compute step differs:

```js
export async function runKgCommunities() {
  const started = Date.now();
  try {
    const rows = await db.run(`CALL KG_LOUVAIN_GRAPH()`);
    // if Task 0 pivoted to Node.js: replace with computeLouvain(vertices, edges)
    await db.tx(async tx => {
      await tx.run(`TRUNCATE TABLE "COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY"`);
      for (let i = 0; i < rows.length; i += 500) {
        await tx.run(
          `INSERT INTO "COM_SAP_DEVELOPERS_IMS_KGCOMMUNITY"
             ("communityId","vertexKey","vertexType","slug","detectedAt")
             VALUES (?,?,?,?, CURRENT_UTCTIMESTAMP)`,
          rows.slice(i, i + 500).map(r => [r.COMMUNITY_ID, r.VERTEX_KEY, r.VERTEX_TYPE, r.SLUG])
        );
      }
    });
    metrics.observe('kg_communities_run_seconds', (Date.now() - started) / 1000);
    metrics.set('kg_communities_count', new Set(rows.map(r => r.COMMUNITY_ID)).size);
    metrics.set('kg_communities_max_size', maxSizeByCommunity(rows));
  } catch (err) {
    metrics.inc('kg_communities_failures');
    LOG.error('[kg-communities] failed', err);
    throw err;
  }
}
```

Registered in `srv/jobs/scheduler.js` alongside `kg-pagerank`:

```js
registerJob({
  jobName: 'kg-communities',
  schedule: '57 3 * * *',
  ttlMs: 600_000,
  description: 'Louvain community detection over KG_PG_WORKSPACE (#917)',
  fn: () => runKgCommunities(),
});
```

`CronService.init()` picks it up automatically. Manual trigger via
`AdminService.JobControls.runJob('kg-communities')` works from day 1.

**Fail-open**: job error propagates through the chassis (PipelineLog
FAILED); readers of `KgCommunity` see stale-or-empty data, never a
500. Admin tile handles the empty case with an FE "No data" state.

## Admin UI

**New component**: `app/admin/kgCommunities/webapp/` — FE List Report +
Object Page, generated from the `AdminService.KgCommunities` +
`AdminService.KgCommunityMembers` OData surface.

- **LR columns**: `communityId`, `memberCount`, `tutorialCount`,
  `topConceptSlugs` (Node-computed), `detectedAt`. Default sort:
  `memberCount desc`. Filter bar: memberCount range, detectedAt range,
  `alreadyPromoted` toggle (default: hide promoted).
- **OP header**: community ID, member/tutorial counts, detectedAt,
  `promoteToMission` action button (SuperAdmin-only per the write-guard
  chassis at `admin-service.js:788`).
- **OP table**: memberships, columns `vertexType`, `slug`, `label`
  (joined from the source entity at read time), grouped by `vertexType`.

**Shell wiring** in `app/admin-shell/webapp/`:

1. `manifest.json` — add `resourceRoots["sap.tutorials.admin.kgCommunities"]`,
   `componentUsages.kgCommunitiesComponent`, `routes.kgCommunities`
   (pattern `kg-communities`, prefix `kc`), `targets.kgCommunitiesTarget`.
2. `controller/Shell.controller.js` — add `kgCommunities: 'kgCommunities'`
   to `NAV_KEY_TO_ROUTE` and `NAV_KEY_TO_TITLE`.
3. Nav model JSON — add an entry under the Knowledge Graph section
   (`#kg-widget`, `#kg-search`, `#kg-communities`, `#kg-overview`).
4. Conditional render — hide the nav entry when `KG_COMMUNITIES_ENABLED`
   is not `'true'` (env-plumbed into the shell's config service).

## Promote-to-mission action

New unbound action in `srv/admin-service.cds`:

```cds
extend service AdminService {
  action promoteCommunityToMission(
    communityId : Integer,
    missionSlug : String,
    title       : String
  ) returns Missions;
}
```

Handler in `srv/admin-service.js` (SuperAdmin-gated via the existing
write-guard chassis at `admin-service.js:788`):

1. Load community members with `vertexType = 'tutorial'` from
   `KgCommunity`; look up `Tutorials.ID` and `Tutorials.title` by slug.
2. Insert `Missions { slug, title, published: false, sourceCommunityId }`.
3. Insert `CompletionPaths { mission_ID, name: 'Default', variant: 'default' }`.
4. Bulk-insert `CompletionPathItems { completionPath_ID, tutorial_ID,
   position }` ordered by `Tutorials.title ASC`.
5. Wrap the whole thing in `db.tx` — atomic promotion.
6. `SecurityEvent` audit row: `event: 'CommunityPromoted', target:
   missionSlug, meta: { communityId, memberCount }`.
7. Return the new mission row so FE navigates the curator to its Object
   Page in the Missions LR.

**Idempotency**: `Missions.slug` has `@assert.unique.slug` — a repeat
promotion attempt with the same slug fails cleanly with the existing
assertion error. The tile's `alreadyPromoted` filter (default on) also
prevents accidental double-promotion by hiding rows with a matching
`sourceCommunityId`.

## Testing

**Task 0 probe** — separate script under
`scripts/kg/probe-louvain-primitive.mjs`, invoked once manually to
confirm `Communities_Louvain` compiles at our HANA Cloud version.
Result committed to
`docs/superpowers/reviews/2026-07-04-917-kg-community-detection-task0-notes.md`.
This is the design gate for Q1.

**Hybrid test** — `test/hybrid/kg-communities.test.js`, canonical shape
from `kg-pagerank.test.js`:

- `TEST_PREFIX = '__test__kg-communities-'`, `RUN_ID` suffix.
- Fixture: **two-community-plus-bridge**. 12 tutorials in two 5-cliques
  (`__test__kg-communities-A1..A5`, `__test__kg-communities-B1..B5`)
  joined by one bridge tutorial `__test__kg-communities-bridge`. Cliques
  linked internally by shared `teaches` concept + `coCompletedWith`
  edges; bridge has one weak edge to each side. Seed via
  `INSERT.into(Concepts/Tutorials/ConceptEdges/TutorialConceptLinks/CoCompletions)`.
- Invoke `runKgCommunities()` directly.
- Assert: `SELECT communityId, count(*) FROM KgCommunity WHERE slug LIKE
  '__test__kg-communities-%' GROUP BY communityId` returns exactly 2 or
  3 rows (bridge either joins one clique or forms a singleton);
  `A1..A5` share a communityId; `B1..B5` share a **different**
  communityId.
- `promoteCommunityToMission` action test: call with the A-community
  ID, assert Mission row + CompletionPath + 5 CompletionPathItems,
  ordered A1→A5 by title.
- `afterAll` FK-ordered cleanup: `KgCommunity` rows → any promoted
  Missions/CompletionPaths/CompletionPathItems → CoCompletions → Links
  → Edges → Tutorials → Concepts.

**Unit test** — only if Task 0 pivots to Node.js Louvain. Deterministic
closed-form fixture (same 2-clique-plus-bridge shape, hand-computed
expected community assignment), tests `computeLouvain(vertices, edges)`
directly without HANA in the loop. Same shape as
`test/unit/kg-pagerank-compute.test.js`.

## Rollback

Cron job writes only to `KgCommunity` and sets `Missions.sourceCommunityId`
on promoted rows.

- **Disable tile only**: `cf unset-env tutorials-srv KG_COMMUNITIES_ENABLED
  && cf restart tutorials-srv` — nav entry disappears; job keeps running;
  no data loss.
- **Disable job**: comment out the `registerJob('kg-communities')` block;
  `cds deploy` and restart. Last-known sidecar rows persist harmlessly.
- **Full removal**: drop the `KgCommunity` table, `KG_LOUVAIN_GRAPH`
  procedure, `KgCommunitySummaryV` view, shell nav entry, and
  `promoteCommunityToMission` action. `Missions.sourceCommunityId`
  element can stay (nullable, no reader depends on it) or be dropped
  via a CDS migration.

## Non-goals

- Not auto-creating missions/groups — communities are **suggestions**.
- Not exposing community membership to visitors, the sidebar widget, or
  `/explore`.
- Not scoring community "quality" in v1 (density, modularity, etc.) —
  the LR shows raw member counts; ranking follows in v2 if needed.
- Not per-predicate edge weighting in v1 (see Q4 rationale).
- Not two-way sync between curator mission edits and Louvain input in
  v1 (see Q6 rationale — deferred to a future ML-feedback feature).
- Not touching Groups in v1. The `promoteCommunityToMission` action
  creates a `Missions` row without a group association; the curator
  assigns a group manually in the Missions LR. A future
  `promoteCommunityToGroup` follows the same shape if needed.

## Related work

- **#913** — property-graph spike (parent). Established `KG_PG_WORKSPACE`
  + views.
- **#919** — widened workspace to 9 predicates (unblocking prereq,
  merged).
- **#916** — PageRank in Node.js (sibling algorithm, landed same day).
  Templates the sidecar / scheduler / hybrid-test shape reused here.
- **#918** — Weakly-connected components (sibling, not started). Also
  has a HANA built-in (`Strongly_Connected_Components`; WCC trivially
  derivable). This spec's Task 0 pattern is a template for #918's own
  primitive-confirmation gate.
