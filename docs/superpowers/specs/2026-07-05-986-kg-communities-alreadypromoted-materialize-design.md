# Materialize `alreadyPromoted` in `KgCommunitySummaryV` — #986

> **⚠️ SUPERSEDED — do not implement this spec.**
>
> Issue #986 was fixed by **[PR #991](https://github.com/sap-tutorials/tutorials-ims/pull/991)** (merged 2026-07-05), rolled up with **#985** (Louvain-ID volatility).
>
> **Why this spec's design was wrong:** it joins `Missions.sourceKgCommunityId` to `KgCommunity.communityId`. Louvain output IDs are order-sensitive and **shuffle across nightly re-runs** (that's issue #985) — so the same cluster of tutorials gets a fresh integer ID each pass, and any join on `communityId` flags the wrong community half the time. This spec was written from a base commit that predated #985 landing on `main`, so the volatility wasn't visible to the author.
>
> **What PR #991 does instead:** joins on a **content-based `communityFingerprint`** — SHA-256 hex over the sorted tutorial-typed member slug set. Computed once per Louvain pass, stored on both `KgCommunity.communityFingerprint` and `Missions.sourceKgCommunityFingerprint`. Stable across re-runs. Shared helper at `srv/lib/kg-community-fingerprint.js`.
>
> **Kept as a record of** how the #986 symptom looked from the DEV LR before the #985 root cause was known, and as a cautionary tale on why "verify against live artifact and fresh main before writing a spec" matters. See `~/.claude/projects/D--projects-tutorials-poc/memory/` — [[probe-live-before-believing-plan-recon]] and [[sdd-translate-global-gotchas-into-briefs]] apply directly.

---

**Issue:** [sap-tutorials/tutorials-ims#986](https://github.com/sap-tutorials/tutorials-ims/issues/986)
**Related:** #917 (KG community detection, PR #984 whole-branch review)
**Scope:** DEV-only v1 tile; small follow-on to #917.

## Problem

`app/admin-annotations.cds:3213-3253` declares a `UI.SelectionPresentationVariant #default` on `AdminService.KgCommunities` that excludes rows where `alreadyPromoted = true`, so curators see only still-actionable communities.

But `alreadyPromoted` is declared `virtual null : Boolean` on the projection (`srv/admin-service.cds:882`) and populated only by a Node.js `after('READ')` decorator (`srv/admin-service.js:2603-2618`). When Fiori Elements serializes the SPV as `$filter=not (alreadyPromoted eq true)`, CAP evaluates the predicate at the **DB layer**, where `alreadyPromoted` resolves to `NULL`. `NOT (NULL = TRUE)` is `NULL`, which is falsy in a `WHERE` clause — so the LR can render empty even when `KgCommunity` is populated.

Secondary problem: the `after('READ')` decorator issues a per-page `SELECT sourceKgCommunityId FROM Missions WHERE sourceKgCommunityId IN (...)` — an N+1 on every LR page load.

## Fix — Option (a) from the issue: materialize `alreadyPromoted` in the CDS view

The filter has to evaluate against a real DB column. Moving the "any Missions row carries `sourceKgCommunityId = <id>`" check into `KgCommunitySummaryV` gives us that column and removes the N+1.

### Shape

The aggregate view already groups by `communityId` with `count(*)`, `sum(case ...)`, `max(detectedAt)`. A naive `left join Missions on sourceKgCommunityId = communityId` would multiply `KgCommunity` rows when a community is pointed at by more than one Missions row (curator retries `promoteCommunityToMission` with a fresh slug), breaking `count(*)` and `sum(...)`.

Fix: interpose a **deduplicated helper view** so the join stays 1:1. CDS `case when ... in aggregate` on the joined column then materializes `alreadyPromoted` cleanly.

**`db/knowledge-graph-communities.cds`** — add a helper view and extend the summary:

```cds
// Distinct source-community IDs across all Missions. One row per
// community that has been promoted at least once. Keeps the join
// against KgCommunitySummaryV at cardinality 1 so count(*) / sum(...)
// stay correct even when a community has been promoted to more than
// one Mission (curators can retry promoteCommunityToMission with a
// different missionSlug).
@cds.autoexpose: false
view KgCommunityPromotedV as
  select distinct
    key sourceKgCommunityId as communityId : Integer
  from Missions
  where sourceKgCommunityId is not null;

@cds.autoexpose: false
view KgCommunitySummaryV as
  select from KgCommunity as k
    left join KgCommunityPromotedV as p on p.communityId = k.communityId
  {
    key k.communityId,
        count(*)                                                     as memberCount   : Integer,
        sum(case when k.vertexType = 'tutorial' then 1 else 0 end)   as tutorialCount : Integer,
        max(k.detectedAt)                                            as detectedAt    : Timestamp,
        case when max(p.communityId) is not null
             then true else false end                                as alreadyPromoted : Boolean,
  } group by k.communityId;
```

Notes:
- `max(p.communityId) is not null` is the aggregate form of "any row in the group has a match". Portable across HANA and SQLite.
- `key sourceKgCommunityId as communityId` in the helper view: needed for the CDS compiler to accept the view as joinable; `select distinct ...` guarantees the key is actually unique.

### AdminService projection

**`srv/admin-service.cds:878-883`** — drop the virtual for `alreadyPromoted`:

```cds
@readonly
entity KgCommunities as projection on ims.KgCommunitySummaryV {
  *,
  virtual null as topConceptSlugs : String(255),
  // alreadyPromoted is now surfaced by * from the base view (#986)
};
```

`topConceptSlugs` stays virtual — it's still computed by the `after('READ')` decorator.

### Node handler

**`srv/admin-service.js:2599-2618`** — delete the `after('READ', 'KgCommunities')` handler that populated `alreadyPromoted`. Keep the `topConceptSlugs` handler above it. Delete the block comment header down to the closing `});` of the alreadyPromoted handler.

### CSN rebuild

Schema-critical: run `cds build --production` after the CDS change so `db/last-dev/csn.json` reflects the new view + column. Per the project memory rule, `cds compile` is not sufficient.

## Tests

### Unit (`test/unit/kg-communities.test.js` — extend existing)

Verify:
1. Insert `KgCommunity` rows for `communityId=1` and `communityId=2`.
2. Insert a `Missions` row with `sourceKgCommunityId=1`.
3. `SELECT` `AdminService.KgCommunities` and assert:
   - Row for `communityId=1`: `alreadyPromoted === true`.
   - Row for `communityId=2`: `alreadyPromoted === false`.
4. `SELECT` with `$filter=alreadyPromoted eq false`: only `communityId=2` returned.
5. Two Missions both pointing at `communityId=1`: `memberCount` and `tutorialCount` unchanged from the single-Mission baseline (regression guard on the join cardinality).

### Hybrid smoke (optional but recommended)

Extend a hybrid test if one exists for KG communities; otherwise defer to Task 12 live-check in #917.

## Failure modes / rollout

- **Fail-open**: the base view has no dependency that could throw at read time. If `Missions` is empty, `KgCommunityPromotedV` is empty, the left join yields NULL for every row, `alreadyPromoted` is `false` everywhere — LR renders full set, curator sees everything. That matches the pre-#986 behavior when nothing has been promoted yet.
- **Deploy order**: view-only change; `cds build --production` regenerates `db/last-dev/csn.json`, HDI picks up the new view at deploy. No table migration.
- **No env flag**: this is a bug fix inside an already-shipped tile; toggling would only be useful for a rollback, and `git revert` is fine.

## Out of scope

- Changing the SPV UX (Option b in the issue).
- Investigating sap.fe virtual-filter behavior across versions (Option c). We have a real fix; no need to depend on a version-specific quirk.
- Any change to `KgCommunityMembers`, the `promoteCommunityToMission` action, or the `topConceptSlugs` computation.

## Refs

- `db/knowledge-graph-communities.cds` — view definitions
- `srv/admin-service.cds:868-885` — projection
- `srv/admin-service.js:2570-2618` — after('READ') decorators
- `app/admin-annotations.cds:3213-3253` — SPV #default
- `db/schema.cds:57` — `Missions.sourceKgCommunityId`
