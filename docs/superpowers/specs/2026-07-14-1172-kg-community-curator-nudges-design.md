# Design: KG communities — curator-assist nudges on the promote flow (#1172)

**Issue:** [#1172](https://github.com/sap-tutorials/tutorials-ims/issues/1172) — Curator-assist nudges on the community→mission promote flow
**Epic:** #1126 (PR-scope item 3 of 4). See [2026-07-12-1126-kg-communities-joule-design.md](2026-07-12-1126-kg-communities-joule-design.md) → "Out of scope": _"Curator-assist nudges on the promote flow."_
**Date:** 2026-07-14
**Status:** Approved — ready for implementation plan

## Context

KG **community detection** (Louvain, #917) clusters related tutorials/concepts/
tags/products nightly and materializes membership into the `KgCommunity`
sidecar. The admin surface `/admin-ui/#kgCommunities` renders a Fiori Elements
List Report + Object Page over `AdminService.KgCommunities` (a projection on the
`KgCommunitySummaryV` aggregate) and `AdminService.KgCommunityMembers`. The one
mutation is the SuperAdmin-gated unbound action `promoteCommunityToMission`,
which drafts a `Missions` row + `CompletionPaths` + `CompletionPathItems` from
the community's tutorial members (A→Z by title) and stamps
`Missions.sourceKgCommunityFingerprint` so already-promoted communities are
filtered out of the LR by default (#985/#986).

Today a curator eyeballs each cluster and decides whether to promote it. This
spec adds **curator-assist nudges**: surface, per community, how much of it is
_already_ covered by a published mission (and which mission dominates), and how
many of its tutorials are **orphaned** (in no mission) — the strongest promote
candidates. When a community is mostly already covered, warn the curator at
promote time to consider _extending_ the existing mission instead of creating a
duplicate.

### Prerequisite state (confirmed 2026-07-14)

- HEAD == `origin/main` @ `b998a428` (fetched 2026-07-14).
- `after('READ', 'KgCommunities')` decorator already exists in
  `srv/admin-service.js:2872` (computes `topConceptSlugs` at read time). This is
  the extension point.
- #918 established the **fail-quiet after-READ badge** pattern (virtual
  `isolated : Boolean` on `Tutorials`/`Concepts`, populated by a decorator,
  rendered via `@UI.Criticality` `$If $Path` — `srv/admin-service.js:405`,
  `app/admin-annotations.cds:2529/2565`). This spec mirrors it exactly.
- `concepts` / `categories` admin apps have FE V4 action-controller precedents
  (`app/admin/concepts/webapp/ext/ConceptActionsController.js`) — plain module,
  **not** `.controller.js` (documented FE V4 suffix-collision gotcha).
- `kgCommunities` app has **no** `ext/` dir yet — this PR adds one.

## Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Coverage semantics | **Published missions only** | Cleanest "extend a live mission" signal; sidesteps self-inflation from the community's own draft (a prior Promote leaves a *draft* mission). |
| Coverage-% denominator | **Tutorial members only** | Only tutorials can be in a mission. An all-vertices denominator would read a fully-covered 5-tutorial + 20-concept cluster as "20% covered", inverting the nudge intent. Member-vertex counts shown separately as context, not folded into the %. |
| Computation site | **Read-time**, in the existing `after('READ','KgCommunities')` decorator | Communities are few (thousands of `KgCommunity` rows total) and small (tens of members); FE pages 30 rows → a handful of small batched queries. No new job (issue: "No new job if computed at read time"). Coverage reflects **live** mission-publish state, not a nightly snapshot. |
| Nudge delivery | **LR/OP badges + interactive promote-time warning** | Badges give at-a-glance triage; the MessageBox at promote time is the actual "extend instead?" intervention. |
| Threshold | **70%** default, env-overridable | Single server-computed `coverageHigh` boolean is the source of truth for both the LR badge and the FE nudge. |

## Non-goals

- Auto-promoting or auto-extending missions (human stays in the loop).
- Changing `promoteCommunityToMission` semantics or its SuperAdmin gate.
- A nightly sidecar/job (rejected: read-time is cheap and gives live coverage;
  a job would make coverage stale until the next night).

## Architecture

Four pieces, one additive PR (no new persisted table, no migration bump, no job):

1. **Pure helper** `srv/lib/kg-community-coverage.js` — DB-agnostic coverage/
   orphan math, unit-testable without a service.
2. **Read-time decorator** — extend `after('READ','KgCommunities')` to call the
   helper and populate new virtual fields. Fail-quiet.
3. **Projection virtual fields + FE annotations** — new columns/badges on the LR
   and OP.
4. **FE promote-time warning** — new `KgCommunityActionsController.js` +
   manifest wiring intercepts the Promote button when `coverageHigh`.

### 1. Data model — virtual fields on `AdminService.KgCommunities`

Added to the projection in `srv/admin-service.cds` (alongside the existing
`virtual null as topConceptSlugs`):

```cds
entity KgCommunities as projection on ims.KgCommunitySummaryV {
  *,
  virtual null as topConceptSlugs      : String(255),
  virtual null as missionCoveragePct   : Integer,   // covered tutorials / total tutorials × 100
  virtual null as dominantMissionTitle : String(255),
  virtual null as dominantMissionSlug  : String(255),
  virtual null as orphanTutorialCount  : Integer,   // tutorial members in NO published mission
  virtual null as coverageHigh         : Boolean,   // missionCoveragePct >= threshold
};
```

All default to `null` → fail-quiet renders no badge (matches #918 `isolated`).
No change to the underlying `KgCommunitySummaryV` view or `KgCommunity` table.

**Field semantics:**
- `missionCoveragePct` — `round(coveredTutorials / totalTutorials × 100)`.
  Denominator = tutorial-typed members only. **Unset (not 0)** when a community
  has 0 tutorial members (concept/tag-only cluster) — avoids a misleading "0%
  covered".
- `dominantMissionTitle` / `dominantMissionSlug` — the single published mission
  covering the most of _this_ community's tutorial members; null if none. Ties
  broken by mission title ascending (deterministic).
- `orphanTutorialCount` — tutorial members in **no** published mission. Unset
  when 0 tutorial members.
- `coverageHigh` — `missionCoveragePct >= THRESHOLD`. Single source of truth for
  the LR criticality badge and the FE nudge; both key off this one
  server-computed field rather than duplicating the threshold client-side.

### 2. Read-time computation — query shape

Inside the existing `after('READ','KgCommunities')` decorator, in a **separate
`try/catch`** from the `topConceptSlugs` block (a coverage failure must not wipe
concepts and vice-versa), batched across the page's rows:

1. **Denominator — tutorial members per community.** One query over
   `KgCommunity` `WHERE communityId IN (…page ids…) AND vertexType='tutorial'`,
   columns `communityId, slug`. Build `Map<communityId, Set<slug>>`.
2. **Coverage — covered slug → owning published missions.** Join
   `CompletionPathItems → path.mission`, filtered to `mission.published = true`
   and the union of member tutorial slugs, returning
   `(tutorial.slug, mission.title, mission.slug)`. CDS QL path navigation; all
   scalar columns (no BLOB locator — the LOB-mixing gotcha does not apply here).
3. **Per community, in Node** (the pure helper):
   - `covered` = members with ≥1 published-mission row.
   - `missionCoveragePct = round(covered / total × 100)`.
   - `orphanTutorialCount = total − covered`.
   - `dominantMission{Title,Slug}` = mission covering the most of this
     community's members (tie-break: title asc).
   - `coverageHigh = missionCoveragePct >= threshold`.

**HANA packet-cap guard** ([[cqn-where-in-hana-packet-cap]]): a 30-row page's
union of member slugs could exceed a safe `.in([...])` bound-param count (one
bound param per element). The coverage join in step 2 fetches **packet-safe** —
chunk the slug `IN` list (≤ ~500 per call, matching the cap used elsewhere) and
merge results in Node, OR fetch `CompletionPathItems` scoped and filter in Node.
The plan picks the concrete variant; designed-in here so it is not patched
later. SQLite unit tests will not exercise the cap — the hybrid test must run at
realistic slug width.

**Threshold** — constant in `admin-service.js`, env-overridable
`KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD` (default **70**).

**Fail-quiet** — the whole coverage block is one `try/catch`; any throw →
`cds.log('kg-community-coverage').warn(...)`, fields left unset, FE renders no
badge. Never a request-time 500 (identical posture to #918/#986).

### 3. UI — LR/OP badges (`app/admin-annotations.cds`)

Mirrors the `isolated` criticality-badge idiom (lines 2529/2565):

- **`annotate AdminService.KgCommunities with { … }`** — labels:
  `missionCoveragePct` "Mission Coverage %", `dominantMissionTitle` "Dominant
  Mission", `orphanTutorialCount` "Orphaned Tutorials".
- **LineItem** (LR) + **FieldGroup#General** (OP): add `missionCoveragePct`
  (with `@UI.Criticality`), `dominantMissionTitle`, `orphanTutorialCount`.
- **Criticality** on `missionCoveragePct` keyed off `coverageHigh`:
  `{ $edmJson: { $If: [ { $Path: 'coverageHigh' }, 1, 3 ] } }` — 1 (red/negative)
  = "high overlap, reconsider"; 3 (green/positive) = "clear to promote". Same
  `$If $Path` idiom as `isolated`.
- **SelectionFields**: add `missionCoveragePct` and `orphanTutorialCount` so
  curators can filter/sort to find high-orphan, low-coverage clusters (the best
  promote candidates).

### 4. UI — interactive promote-time warning

New `app/admin/kgCommunities/webapp/ext/KgCommunityActionsController.js` — a
**plain UI5 module** (loader path `<dotted-name>.js`), **NOT**
`.controller.js` (FE V4 resolves manifest `press` refs as plain modules; the
`.controller.js` suffix 404s — see the header comment in
`ConceptActionsController.js` and memory `feedback_ui5_controller_suffix_collision`).

- `manifest.json`: add `sap.ui.controllerExtensions` for
  `ListReportController` + `ObjectPageController`; rewire the Promote button's
  `press` to `…ext.KgCommunityActionsController.onPromoteToMission`.
- `onPromoteToMission(arg)`:
  1. Resolve the binding context (multi-shape `resolveCtx`, cloned from the
     concepts controller).
  2. Read `coverageHigh`, `missionCoveragePct`, `dominantMissionTitle` from the
     context.
  3. If `coverageHigh` truthy → `MessageBox.warning` with **[Promote anyway]** /
     **[Cancel]**. Copy: _"~{pct}% of this community's tutorials are already in
     **{dominantMissionTitle}**. Consider extending that mission instead of
     creating a new one."_ (i18n keys in `i18n.properties`.)
     - **[Promote anyway]** → invoke the existing unbound
       `promoteCommunityToMission` (FE's standard parameter dialog for
       `communityId/missionSlug/title`, unchanged).
     - **[Cancel]** → abort, no-op.
  4. If `coverageHigh` false/unset → straight through to the normal action, no
     dialog.

**SuperAdmin gating unchanged** — the warning is advisory FE-only; the server
`@requires:'SuperAdmin'` on `promoteCommunityToMission` remains authoritative.

## Error handling / fail-open summary

- Coverage query throws → warn-log, fields unset, no badge, no 500 (#918
  posture). `topConceptSlugs` unaffected (separate try).
- Community with 0 tutorial members → `missionCoveragePct` /
  `orphanTutorialCount` unset (N/A), not 0.
- No published mission covers any member → `dominantMission*` null,
  `missionCoveragePct` 0, `orphanTutorialCount` = total (all orphaned = strong
  promote candidate).
- FE controller: if the action invocation fails, the existing FE error toast
  applies; the nudge itself never blocks a legitimate promote.

## Testing

- **Unit** (`srv/lib/kg-community-coverage.js`, pure): tutorials-only
  denominator; published-only filter (draft mission ≠ coverage); dominant-mission
  selection + deterministic title-asc tie-break; orphan count; 0-tutorial
  community → fields unset (not 0); rounding; `coverageHigh` boundary
  (69/70/71).
- **Unit** decorator fail-quiet: force the coverage query to throw → response
  200, `topConceptSlugs` still populated, coverage fields unset.
- **Hybrid** (`--project hybrid`, real HANA): seed a community whose tutorials
  split across a published mission + orphans; assert `missionCoveragePct`,
  `dominantMissionTitle`, `orphanTutorialCount` round-trip; exercise the
  packet-safe slug fetch at realistic width.
- **CI-safety**: `npx cds deploy --to sqlite::memory:` before commit (virtual
  fields are model surface); `cds build --production` to regen
  `db/last-dev/csn.json` (projection change in `admin-service.cds`). **No
  `.hdbmigrationtable` bump** — no new persisted table.

## Rollout

- Purely additive: virtual fields + read-time compute + FE annotations + one new
  FE controller. No new table, no job, no migration, no dark-launch flag.
- **Threshold** env-overridable: `KG_COMMUNITY_COVERAGE_NUDGE_THRESHOLD`
  (default 70).
- **`srv-qa` cp audit** (CLAUDE.md rule): add `srv/lib/kg-community-coverage.js`
  to `.deploy/mta.yaml`'s `srv-qa` `cp` list — it is a transitive `./` import
  from `srv/admin-service.js`. Missing → QA boot crash at MTA deploy.
- **DEV-only** in v1, consistent with the rest of the #1126 KG-communities work;
  PROD is gated on the #1126 Louvain PROD rollout landing first (no
  `KgCommunity` data in PROD → the LR is empty → nudges render nothing, never a
  500).

## Docs

- One CLAUDE.md top-gotcha entry: threshold env var, published-only + tutorials-
  only semantics, fail-quiet posture, no-job rationale.
- This spec.

## Key files

| File | Change |
|---|---|
| `srv/lib/kg-community-coverage.js` | **new** — pure coverage/orphan helper |
| `srv/admin-service.js` | extend `after('READ','KgCommunities')`; threshold constant/env |
| `srv/admin-service.cds` | + 5 virtual fields on `KgCommunities` projection |
| `app/admin-annotations.cds` | + LineItem/FieldGroup columns, coverage criticality badge, SelectionFields |
| `app/admin/kgCommunities/webapp/ext/KgCommunityActionsController.js` | **new** — promote-time warning |
| `app/admin/kgCommunities/webapp/manifest.json` | + controllerExtensions + Promote `press` rewire |
| `app/admin/kgCommunities/webapp/i18n/i18n.properties` | + nudge copy strings |
| `.deploy/mta.yaml` | `srv-qa` cp list + `srv/lib/kg-community-coverage.js` |
| `test/unit/kg-community-coverage.test.js` | **new** unit tests |
| `test/hybrid/…` | coverage round-trip on real HANA |
| `CLAUDE.md` | top-gotcha entry |
| `docs/superpowers/specs/2026-07-14-1172-kg-community-curator-nudges-design.md` | this spec |

## Acceptance criteria (from #1172)

- [x] Each community shows a mission-coverage % and dominant existing mission
  (if any) in the admin LR → `missionCoveragePct` + `dominantMissionTitle`.
- [x] Clustered-but-orphaned tutorials counted/flagged per community →
  `orphanTutorialCount`.
- [x] Promote flow shows a nudge when coverage is high (threshold documented,
  default 70%) → `coverageHigh` + FE MessageBox.
- [x] Read path fail-quiet: computation throw leaves fields unset, FE renders no
  badge, never a 500.
- [x] SuperAdmin gating on promote unchanged; nudges advisory only.
- [x] Unit + hybrid coverage for the coverage/orphan computation.

## Related

- #1126 (epic), #917 (promote flow + KgCommunities admin), #918 (after-READ
  fail-quiet badge pattern mirrored here), #985/#986 (fingerprint +
  `alreadyPromoted` materialization).
