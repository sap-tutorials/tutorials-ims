# Standard Reports in the Admin UI — Reporting Folder (#2138)

**Status:** Design — pending user review
**Issue:** [sap-tutorials/tutorials-ims#2138](https://github.com/sap-tutorials/tutorials-ims/issues/2138)
**Date:** 2026-09-04
**Branch:** `feat/2138-reporting` (based on `origin/DEV`; PR targets `DEV`)

## 1. Problem & Goal

Authors previously used a Power BI "Beta Tutorial Dashboard" to understand how a
group or mission was used. That dashboard is deprecated. We replace it with
**standard, ready-to-use reports** in the Admin UI under the existing **Reporting**
folder, visible to authors (`Tutorial.Author`).

The Power BI dashboard had three pages sharing one cascading filter bar
(**Date → Mission → Group → Tutorial**):

1. **Step Analytics** — a horizontal bar of **Tutorial Starts vs Completions** per
   tutorial within the selected mission/group. Answers *which tutorials are most
   used* and *which have a poor completion rate* (a proxy for a broken quiz/step).
2. **Tutorial Analytics** — tutorial-level completions detail/trend.
3. **Survey** — the tutorial feedback survey: per-question **score distributions**
   (0–10), the NPS question, and a free-text **comments** table.

Author-stated needs (verbatim from the issue):
- Which tutorials within a group/mission were most used.
- Whether a tutorial had a poor completion rate (⇒ possible quiz problem).
- Quickly read the feedback (comments) for a group or mission.
- **Drill at Group, Mission _and_ Tutorial level in a single report** (the granular
  tutorial level was missing from the first design draft — this spec adds it).

### Decisions locked with the user

| Decision | Choice |
|---|---|
| Report packaging | **Separate report entries** (three leaves, mirroring the three Power BI pages). |
| Audience | **Authors** — `Tutorial.Author`, served via `AuthorService` (`/author`). |
| Completion rate | **Completed ÷ Started** (distinct users; see §4). |
| UI platform | **Hybrid** — Engagement + Tutorial Completions as in-shell **Fiori Elements**; Survey as a pre-built **Vue** dashboard in `analytics-explorer`. |
| Survey dimensions | **All 7** — 6 `rating*` dimensions + NPS (fuller than Power BI, which omitted `ratingVisuals`). |

## 2. Why Hybrid (platform rationale)

Two hard constraints from the data/UI investigation:

- **The Survey page needs 6–7 per-score histograms.** A Fiori Elements List Report
  or Analytical List Page renders **exactly one** `UI.Chart`. Six-to-seven
  independent distributions cannot be expressed in an FE template without a
  net-new freestyle UI5 charting page (no such precedent exists anywhere in the
  admin shell — every freestyle admin app is a form/settings/builder, and the only
  chart usage is the shell's KPI `GenericTile` Board).
- **The Vue `analytics-explorer` SPA already does exactly this**: Apache ECharts,
  a multi-chart `DashboardGrid`, a shared `FilterBar`, an OData/SQL query layer,
  and auth — and it is **already** the "Analytics" leaf under the Reporting folder
  (`navigation.json`, external `href` `/analytics-ui/`, `requiredScope`
  `Tutorial.Author`).

The engagement/completions reports, by contrast, map cleanly onto the existing FE
List Report / ALP pattern (`app/admin/analytics` and `app/admin/devtoberfestSignups`
are working templates). So:

- **Report A — Tutorial Engagement** (Step Analytics): FE **Analytical List Page**.
- **Report B — Tutorial Completions** (Tutorial Analytics): FE **List Report**.
- **Report C — Tutorial Survey**: **Vue** page in `analytics-explorer`.

## 3. Architecture Overview

```text
db/views.cds  (4 new read-only views over ims.*)
  ├─ AuthorTutorialEngagement        (pre-aggregated: 1 row per tutorial×mission×group)   → Report A (FE ALP)
  ├─ AuthorTutorialCompletions       (row-per-completion, TUTORIAL grain, + date)          → Report B (FE List Report)
  ├─ AuthorSurveyDistribution        (unpivot: 1 row per tutorialSlug×dimension×score)      → Report C (Vue)
  └─ AuthorTutorialParents           (lookup: tutorialSlug → tutorialTitle/group/mission)   → shared filter/value-help
        (Report C comments reuse the already-exposed AuthorService.TutorialFeedback)

srv/author-service.cds  → project the 4 views @readonly (service is @requires:'Tutorial.Author')

app/author-annotations.cds  (NEW)  → UI/analytical annotations for AuthorTutorialEngagement + AuthorTutorialCompletions

app/admin/tutorial-engagement/webapp/{Component.js,manifest.json}   (FE ALP,  dataSource /author/)   ← auto-discovered
app/admin/tutorial-completions/webapp/{Component.js,manifest.json}  (FE LR,   dataSource /author/)   ← auto-discovered

app/analytics-explorer/  → new "Tutorial Survey" report route/view (ECharts histograms + NPS + comments)

app/admin-shell/webapp/model/navigation.json         → 3 new leaves under the existing "reporting" group
app/admin-shell/webapp/controller/Shell.controller.js → NAV_KEY_TO_ROUTE + NAV_KEY_TO_TITLE for the 2 FE keys
app/admin-shell/scripts/admin-shell-overrides.js      → route-prefix override only if the auto 2-letter prefix collides
```

All four are **computed views** — no persisted entities, so **no**
`@cds.persistence.journal` / migration-table work. No BLOB/LOB columns are
involved (`comment` is `String(2000)` plain text, sanitized on write).

## 4. Data Model (the load-bearing details)

### 4.1 Starts, completions, completion rate

From `TaskRecords` (`db/schema.cds:187`): `taskType` (TUTORIAL/MISSION/GROUP/STEP/…),
`status` (COMPLETED/IN_PROGRESS/SUPERSEDED), `progress`, `completionDate`,
`attemptNumber`, `user`, `taskLegacyId`.

- **Start** = a user has **any** TUTORIAL `TaskRecord` for that tutorial (any status).
  Caveat surfaced in the code: a TUTORIAL row is created lazily on the **first step
  completion** (`srv/developer-service.js:_updateTutorialProgress`), so "start"
  means *made progress on ≥1 step*, not *opened the page* — there is no page-open
  event. This is the best available proxy and matches the Power BI "Starts" measure.
- **Completion** = a `COMPLETED` TUTORIAL record. `uniqueLearners` (distinct users)
  is the primary completion measure; a raw `completions` event count is also shown.
- **Completion rate** = `completedLearners ÷ startedLearners` (both **DISTINCT
  user** counts), as a percentage.

**DISTINCT-user is mandatory, not `COUNT(*)`.** The reset/re-take flow
(`resetTutorialProgress`) leaves a user with multiple rows for one tutorial
(e.g. a `SUPERSEDED` attempt-1 + an `IN_PROGRESS` attempt-2). Counting rows would
double-count. Use:
- `startedLearners  = COUNT(DISTINCT user_ID)` over TUTORIAL rows, any status.
- `completedLearners = COUNT(DISTINCT CASE WHEN status = 'COMPLETED' THEN user_ID END)`.
- `completionRatePct = CAST(completedLearners AS Decimal(5,2)) * 100 / NULLIF(startedLearners, 0)`.

> **HANA/SQLite parity check (plan step):** confirm `COUNT(DISTINCT CASE WHEN … END)`
> behaves identically on HANA (`cds bind --exec`) and SQLite. If HANA rejects the
> conditional-distinct inline, fall back to a two-subquery join (started set ⟕
> completed set) — the pattern already used in `SearchableItems`.

### 4.2 Mission → Group → Tutorial containment (the genuinely new join)

`CompletionAnalytics` (`db/views.cds:173`) populates `missionTitle`/`groupTitle`
**only for MISSION-type TaskRecords** — for a TUTORIAL row those columns are NULL.
So it **cannot** tell us which mission/group a tutorial completion belongs to. The
mission/group→tutorial spine must be built from the **content graph**, mirroring
`NavigatorCatalog` (`db/views.cds:76`):

```
Missions.completionPaths → CompletionPaths.items → CompletionPathItems (taskType='TUTORIAL').tutorial → Tutorials
Missions.group → Groups                                                    ⇒ groupTitle
Missions.title                                                             ⇒ missionTitle
```

- **Tutorials in a mission**: `CompletionPathItems` where `taskType='TUTORIAL'`
  (authoritative), joined via `CompletionPaths` → `Missions`.
- **Group of a mission**: `Missions.group` (a mission belongs to ≤1 group).
- **Tutorials directly under a group** (group without a mission context):
  `GroupPathItems.tutorial`.

Report A/B use the mission spine (Group sits above Mission). A tutorial reused
across missions **fans out** to one row per mission×group — **desirable** for a
Mission/Group/Tutorial cascade filter, but it means tutorial totals must never be
summed across missions without `DISTINCT`.

Decision: **include unpublished** missions'/groups' tutorials? `NavigatorCatalog`
filters `mission.published=true`. For an author report we **keep unpublished**
(authors need to see in-progress content); documented so the join deliberately
omits the `published` filter. *(Open to override in review.)*

### 4.3 The distinct-count vs. date-filter tension

Correct DISTINCT-user counts **do not compose with a date-range slicer** in a
pre-aggregated view (a user active in Jan and Feb is one distinct learner overall
but appears in both monthly buckets; summing over a multi-month selection
over-counts). Power BI avoided this with a row-per-record model + `DISTINCTCOUNT`
measures computed against the filtered set.

Resolution per report:

- **Report A (Engagement)** — pre-aggregated **all-time** (no date slicer). Distinct
  counts are computed once, correctly, in SQL. `firstCompletion`/`lastCompletion`
  give a coarse recency signal. *Date slicing on distinct engagement is a
  documented non-goal for v1* (it is the one Power BI affordance we consciously
  drop, because doing it correctly in FE is not supported).
- **Report B (Completions)** — row-per-completion; the measure is a **completion
  event count** (additive), which **does** compose with a `completionDay` date
  filter. So Report B carries the Date dimension; Report A does not.
- **Report C (Survey)** — client-side aggregation in Vue over the filtered slug set
  ⇒ distinct/date both handled in the browser as needed.

### 4.4 Survey distributions & comments

`TutorialFeedback` (`db/schema.cds:811`): `tutorialSlug`, `submittedAt`,
`wasAuthenticated`, six `rating*` Integers `[0,10]` + `npsScore` Integer `[0,10]`
(nullable — the form's "N/A" sends `null`), `comment : String(2000)` (sanitized).

Dimension ↔ field mapping (labels from `hugo-apps/src/tutorial-feedback/TutorialFeedbackForm.vue`):

| Dimension key | Field | Survey label |
|---|---|---|
| `structure`   | `ratingStructure`   | Well structured |
| `interesting` | `ratingInteresting` | Interesting |
| `useCase`     | `ratingUseCase`     | Helpful for my use case |
| `relevance`   | `ratingRelevance`   | Relevant to my work |
| `duration`    | `ratingDuration`    | Right length |
| `visuals`     | `ratingVisuals`     | Good visuals & code samples |
| `nps`         | `npsScore`          | Likely to recommend to a colleague (NPS) |

`TutorialFeedbackAggregate` (`db/views.cds:427`) gives **averages + promoters/
detractors per slug only** — it **cannot** produce per-score distributions. New
view **`AuthorSurveyDistribution`** unpivots into `(tutorialSlug, dimension, score,
responseCount)` via a `UNION ALL` of 7 blocks:

```sql
SELECT 'structure' AS dimension, ratingStructure AS score, COUNT(*) AS responseCount
  FROM TutorialFeedback WHERE ratingStructure IS NOT NULL
  GROUP BY ratingStructure
UNION ALL … (repeat for the other 6 fields)
```

The Vue page sums `responseCount` per `(dimension, score)` over the filtered slug
set and renders % = score-count ÷ dimension-total.

**Feedback fan-out is multiplicative** (a tutorial in multiple groups × missions).
Therefore mission/group is a **filter that resolves to a distinct slug set**, never
a summed join. `AuthorTutorialParents` supplies `tutorialSlug → {tutorialTitle,
groupTitle, missionTitle}` for the filter dropdowns and slug resolution.

## 5. Report Specifications

### Report A — Tutorial Engagement (FE Analytical List Page)

- **Component**: `app/admin/tutorial-engagement/webapp/` (`sap.fe.templates.AnalyticalListPage`,
  `dataSource.uri: "/author/"`, `contextPath: "/AuthorTutorialEngagement"`).
- **View** `AuthorTutorialEngagement`, grain = 1 row per `(tutorialSlug, missionTitle, groupTitle)`:
  `tutorialSlug, tutorialTitle, missionTitle, groupTitle, startedLearners,
  completedLearners, completions, completionRatePct, firstCompletion, lastCompletion`.
- **Filter bar** (`UI.SelectionFields`): `missionTitle, groupTitle, tutorialTitle`.
- **Chart** (`UI.Chart`, `#Bar`): dimension `tutorialTitle`, measures
  `startedLearners` + `completedLearners` (the starts-vs-completions bar).
- **Table** (`UI.LineItem`): tutorial, started, completed, completions,
  `completionRatePct` with **criticality** (red below a threshold, e.g. <50%).
- `@Aggregation.ApplySupported` + `@Analytics.*` mirror the `CompletionAnalytics`
  block in `app/admin-annotations.cds` (moved to the new `author-annotations.cds`).

### Report B — Tutorial Completions (FE List Report)

- **Component**: `app/admin/tutorial-completions/webapp/` (`sap.fe.templates.ListReport`,
  `dataSource.uri: "/author/"`, `contextPath: "/AuthorTutorialCompletions"`).
- **View** `AuthorTutorialCompletions`, row-per-completion at TUTORIAL grain (status
  IN COMPLETED, plus SUPERSEDED for historical trend — decision below), with the
  content-graph mission/group join and `completionDay : Date`:
  `ID, tutorialSlug, tutorialTitle, missionTitle, groupTitle, completionDate,
  completionDay, completionCount(=1)`.
  *Decision:* include `SUPERSEDED` (matches `CompletionAnalytics`, captures
  re-completion history for a trend line).
- **Filter bar**: `missionTitle, groupTitle, tutorialTitle, completionDate`.
- **Chart** (`#Line` or `#Column`): completions by `completionDay`.
- **Table**: completion events with drill to tutorial/mission/group.

### Report C — Tutorial Survey (Vue in analytics-explorer)

- **Location**: a new **pre-configured report route** in `app/analytics-explorer/`
  (e.g. `#/reports/survey`) — a fixed dashboard, *not* the ad-hoc builder. Reuses
  `ChartRenderer`/ECharts, `FilterBar`, `api/odata.ts`/`api/sql.ts`, `useAuth`.
- **Filter bar**: Mission, Group, Tutorial (populated from `AuthorTutorialParents`),
  Date (client-side filter on `submittedAt`).
- **Charts**: **7 bar charts** — one per dimension (structure, interesting, useCase,
  relevance, duration, visuals, nps) showing **% of responses by score 0–10**, from
  `AuthorSurveyDistribution` aggregated over the filtered slug set. Plus an **NPS
  summary** (avg, promoters, detractors) from `TutorialFeedbackAggregate`.
- **Comments table**: `submittedAt | tutorialTitle | comment` from
  `AuthorService.TutorialFeedback` filtered to the slug set, newest first.
- **Nav wiring**: external `href` leaf under "reporting" (like the existing
  `analyticsExternal` leaf), `requiredScope: "Tutorial.Author"`.
- **Data access**: queries `/author/` (`AuthorService`). If the SQL query path is
  used, the new views must pass the SELECT allowlist
  (`srv/lib/analytics-sql-validator.cjs` / `@analytics.exposed`) — plan step.

## 6. Nav & Shell Wiring

Under the existing `reporting` group in
`app/admin-shell/webapp/model/navigation.json`, add three leaves (all
`requiredScope: "Tutorial.Author"`):

| key | title | kind |
|---|---|---|
| `tutorialEngagement`  | Tutorial Engagement  | in-shell FE route |
| `tutorialCompletions` | Tutorial Completions | in-shell FE route |
| `tutorialSurvey`      | Tutorial Survey      | external `href` `/analytics-ui/#/reports/survey` |

- FE leaves: add keys to `NAV_KEY_TO_ROUTE` + `NAV_KEY_TO_TITLE` in
  `Shell.controller.js`. The FE components auto-register via
  `discover-admin-components.js` (folder `tutorial-engagement` → id ending
  `tutorialEngagement`). Add an `admin-shell-overrides.js` route-prefix entry only
  if the auto 2-letter prefix collides.
- The Survey leaf is an external link (no route map), matching `analyticsExternal`.

## 7. Testing

- **Unit (in-memory SQLite)** — one suite per view. Seed `TaskRecords`,
  `TutorialFeedback`, `GroupPathItems`, `CompletionPathItems`, `CompletionPaths`,
  `Missions`, `Groups`, `Tutorials`, and assert:
  - starts/completions/rate incl. the **SUPERSEDED + IN_PROGRESS attempt** scenario
    (distinct-user correctness);
  - mission/group join correctness + intended fan-out;
  - survey distribution counts (null scores excluded per dimension);
  - completion-rate `NULLIF` division-by-zero guard.
- **`npx cds deploy --to sqlite::memory:`** before committing any `db/**` change.
- **HANA parity** — run the two engagement views via `cds bind --exec` (real HANA)
  to confirm `COUNT(DISTINCT CASE …)` and the ratio cast behave as on SQLite
  (HANA columns are UPPERCASE for raw SQL — N/A here since these are CDS QL views).
- **Vue** — component test for the Survey page's distribution aggregation +
  filter-to-slug logic (analytics-explorer's existing Vitest setup).
- **e2e** — advisory committed spec nudge fires on `app/**` changes; real coverage
  runs in the post-DEV-deploy `e2e` job (served admin routes).

## 8. Risks & Non-goals

- **Non-goal (v1):** date slicing on the Engagement report (distinct-count + date
  don't compose correctly in FE — see §4.3). Date lives on Report B and Report C.
- **HANA conditional-distinct** — verify or fall back to subquery join (§4.1).
- **Cascading value-helps** (Group filtered by selected Mission) have **no in-repo
  precedent**; v1 uses **independent** filters (the data itself narrows results).
  True dependent `ValueListParameterIn` cascading is a possible follow-up.
- **`analytics-explorer` deploy** — it is a separate Vite app copied into the
  approuter at `mbt build`; the Survey report ships only via a full deploy. Confirm
  `/author/` is a JWT-forwarding authenticated approuter route (memory: authenticated
  Vue islands/SPAs need JWT forwarding).
- **No `srv/lib/` changes** ⇒ no `srv-qa` cp-list impact. No new npm deps for the FE
  side; the Vue side reuses ECharts already vendored in `analytics-explorer`.
- **Fan-out** is intentional for mission/group filtering; never sum tutorial totals
  across parents without `DISTINCT`, and never sum survey counts after the
  parent join (aggregate per slug first).

## 9. Out of Scope

- Migrating/importing historical Power BI report definitions.
- Admin (non-author) exposure — these are `Tutorial.Author`-scoped.
- Per-`Step`-entity analytics (the Power BI "Step Analytics" page is
  per-tutorial-within-a-mission, not per-`Steps`-row — confirmed in §4.1/§4.2).
