# Pilot enablement runbook

> **Audience:** mission curators piloting branching for the first time.
> **Status:** PR 6 (issue #172). Companion to [branched missions](./branched-missions.md), [branched tutorials](./branched-tutorials.md), the [branching cookbook](./branching-cookbook.md), and [reading branch telemetry](./reading-branch-telemetry.md).

PR 6 ships the user-facing learning-preferences panel + the author/admin debug override. This runbook walks a curator through choosing a pilot mission and rolling out branching. Four phases:

## Phase 1: Pre-pilot

**Mission selection criteria:**

- Mission has at least one tutorial with a natural author-condition fork (e.g. "cloud vs on-prem deployment", "developer vs architect role").
- Mission is in active rotation (≥10 completions/week so telemetry accumulates fast).
- The pilot author owns the mission (or has commit rights) and can iterate on conditions during the pilot.
- Profile fields the pilot will use match the v1 vocabulary: `deployment ∈ {cloud, onprem}`, `role ∈ {developer, architect, sysadmin, student}`, `cloud ∈ {btp, aws, gcp}`.

**Author readiness:**

- The author can write `[BRANCH_BEGIN ... condition="..."]` directives (see [branched-tutorials.md](./branched-tutorials.md)).
- The author has access to the QA channel and can run `npm run fetch-tutorials:qa` locally.
- The author has set their own learning preferences at `/me/` so they have a non-null profile to test against.

## Phase 2: QA pilot

Author writes branches in their fork, pushes to a `*-Contribution` repo, and tests via the QA channel.

**Debug override** (see [Testing your conditions with the debug override](./branching-cookbook.md#debug-override) for the full syntax):

```text
https://tutorial-system-qa.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/<slug>/?profile.deployment=cloud
```

Author exercises all four debug paths:

- `?profile.deployment=cloud` → confirms cloud branch is rendered
- `?profile.deployment=onprem` → confirms on-prem branch is rendered
- No override (anonymous viewing) → confirms the deterministic default branch
- No override + `localStorage` of a completed prerequisite slug → confirms the ranker-driven branch

Joule narration: confirmed to ignore overrides; chat from the unmodified URL (the chat-orchestrator runs through CAP `req`, not the express request — the override never reaches it). See [cookbook §debug-override](./branching-cookbook.md#debug-override) for the full out-of-scope explanation.

**Stale-after-write workaround:** if the author has just edited their own preferences and wants to bypass the 5-minute TTL on the engine's per-callsite caches, combine the override with `?nocache=1` (e.g. `?profile.deployment=cloud&nocache=1`) — `decideHandler` and `missionDetailHandler` short-circuit the per-callsite cache when this flag is present.

## Phase 3: Production rollout

Curator + an admin work together to flip the master flag:

1. Admin sets `ChatSettings.branchingEnabled = true` via `/admin-ui/#chatsettings-display` (DEV first, then PROD).
2. Curator monitors `/admin/analytics/AnalyticsBranchPerformance` (the [Branch Performance section in the Missions ObjectPage](./reading-branch-telemetry.md) — PR 5 surface) for the pilot mission's branch points.
3. Curator watches for `branch-staleness` lint notices in the next `tutorial-markdown` lint run (PR 5 also added this lint rule).

**Rollback:** flip `ChatSettings.branchingEnabled = false`. The engine reverts to default-order behaviour without redeploying.

## Phase 4: Iterate / rollback

- **High click-through rate but low follow-rate:** the recommendation matches reader intent. Tune wording on branch labels.
- **Low click-through rate (<5%):** readers don't see the value of the choice. Consider collapsing the branch back to a single path or rephrasing the prompt.
- **One option picked >95% of the time after 50+ decisions:** the branch is converged — `branch-staleness` lint will emit a notice. Collapse to single path, OR rephrase the prompt to make the underused option more attractive.
- **Pilot fails (low engagement, confusing UX, conflicting feedback):** rollback (Phase 3 step 1 rollback) and revisit the bifurcation criteria from Phase 1.
