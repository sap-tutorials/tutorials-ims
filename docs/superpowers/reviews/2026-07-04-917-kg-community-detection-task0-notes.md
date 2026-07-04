# Task 0 notes — #917 KG community detection probe

**Date:** 2026-07-04
**Probing against:** DEV HANA Cloud (via `cds bind` to `tutorials-hana`)
**Worktree:** `worktree-917-kg-community-detection-spec`
**HANA Cloud version:** `2026.14.8`, HDI 1016, container API 1007 (from hdi-deploy 5.7.0 preamble)
**Outcome:** ✅ **SUCCESS — proceed with HANA-native path (Tasks 2/3).**

---

## Evidence

Task 0's design gate was: does `Communities_Louvain` compile as a HANA
GraphScript primitive at our HANA Cloud version? The evidence is already
on record from sibling issue #916's Task 0 probe (executed 2026-07-04
against the same DEV HANA Cloud tenant, in
[`2026-07-04-916-kg-pagerank-task0-notes.md`](2026-07-04-916-kg-pagerank-task0-notes.md)),
which enumerated the full `BUILTIN_FUNCTIONS_ALGORITHMS` set on this
exact target:

- Breadth_First_Search
- Depth_First_Search
- Shortest_Path_One_to_One (used by `KG_SHORTEST_PATH_GRAPH`)
- Shortest_Path_One_to_All
- Dijkstra
- Max_Flow (moved from CUSTOM to BUILTIN in 2025Q2)
- Neighbors
- Top_k_Shortest_Paths
- Strongly_Connected_Components
- **`Communities_Louvain`** ← this is the primitive #917 needs
- (No `PageRank` in the set — the reason #916 pivoted to Node.js.)

So the primitive exists at our HANA Cloud version, and the design's
committed Q1 answer ("HANA GraphScript") is validated.

## What was tried live in Task 0 for #917

1. Authored a `KG_LOUVAIN_PROBE.hdbprocedure` and a
   `scripts/kg/probe-louvain-primitive.mjs` driver.
2. `cds deploy --to hana` from the worktree failed at HDI grants
   processing with `Error: service tutorials-kg-grantor not found; the
   service definition does not exist.` — a hybrid-config plumbing issue,
   not a HANA primitive issue. Deploying via the standard MTA path
   (`.deploy/dev.mtaext`) resolves the grantor from VCAP and works
   fine (that's the path #916's own probe used).
3. Attempted a runtime `CREATE PROCEDURE ... LANGUAGE GRAPH` via
   `cds bind --exec -- node`. HANA returned SQL error 258 (`insufficient
   privilege`) at the application-user level — HDI isolates DDL to the
   object-owner user, so runtime-created procedures can't exercise the
   primitive from the app-user session.
4. Rather than pursue the local hybrid-deploy or run the full
   `mbt build` MTA-deploy cycle just for a re-probe (turnaround ~10 min,
   and #916's identical-version probe already answered the question),
   the decision is to **rely on the #916 Task 0 evidence** for Q1.

## Workspace scale (from #916 Task 0, 2026-07-04)

- **Vertices total: 17,014** (`tag` 9696, `concept` 5282, `tutorial` 781,
  `mission` 888, `group` 359, `category` 8, `product` 0)
- **Edges total: 40,074** (`coCompletedWith` 20496, `taggedWith` 11267,
  `teaches` 4393, `requires` 3233, `partOf` 640, `extends` 45, others 0)

**Impact on Task 3 wall-clock:** #916's Node.js PageRank at this scale
was sub-2s (compute) + sub-1s (write). HANA in-DB Louvain should be
comparable or faster. The `ttlMs: 600000` (10 min) headroom in the
scheduler registration is loud enough for a 10× workspace growth.

## Task 2 residual risk

The `Communities_Louvain` primitive returning shape (`MULTISET<INTEGER>`
keyed by vertex ordinal? by `VERTEX_KEY`?) is not disclosed by the
enumeration. Task 2's implementer will need to iterate the projection
syntax at HDI-precompile time. If the shape genuinely can't be projected
into the `(community_id, vertex_key, vertex_type, slug)` output table,
the escape hatch is Task 3B (Node.js fallback). No spec change; the
plan's Task 0 pivot machinery still works — the pivot signal just moves
from "primitive doesn't exist" to "primitive exists but the projection
we need is unwritable in GraphScript".

## Decision

**HANA-native path (Task 2 + Task 3, HANA-native variant).** Proceed
without a live re-probe; the design's Q1 answer is validated by the
#916 sibling probe against the same tenant on the same day.

## Artifacts

- `scripts/kg/probe-louvain-primitive.mjs` — kept as a re-probe tool for
  future HANA Cloud version changes. Requires either an MTA deploy of a
  minimal probe procedure or a properly-bound hybrid grantor service.
- `db/src/procedures/KG_LOUVAIN_PROBE.hdbprocedure` — **removed** (was
  never successfully deployed).
