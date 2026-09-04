# Standard Reports in the Admin UI — Reporting Folder (#2138) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three author-facing "standard reports" (Tutorial Engagement, Tutorial Completions, Tutorial Survey) under the existing Reporting folder of the Admin UI, replacing the deprecated Power BI Beta Tutorial Dashboard, with drill at Group / Mission / Tutorial level.

**Architecture:** Four read-only CDS views over `ims.*` feed the reports. Two reports are in-shell Fiori Elements apps (Analytical List Page + List Report) served from `AuthorService` (`/author/`); the third is a pre-configured Vue page in the existing `analytics-explorer` SPA. No persisted entities, no `srv/lib/` changes, no new npm deps.

**Tech Stack:** SAP CAP (CDS views + `@readonly` projections), Fiori Elements (`sap.fe.templates.AnalyticalListPage` / `ListReport`), the `sap.tnt.ToolPage` admin shell (auto-discovered componentUsages via `generate-manifest.js`), Vue 3 `<script setup>` + UI5 Web Components + ECharts (`analytics-explorer`), Vitest.

**Spec:** [docs/superpowers/specs/2026-09-04-2138-standard-reports-design.md](../specs/2026-09-04-2138-standard-reports-design.md)

## Global Constraints

- **Branch/PR:** work on `feat/2138-reporting` (already checked out, based on `origin/DEV`). PR targets **DEV**. `main` is protected; never merge/push to main.
- **No raw SQL** in runtime handlers — these are declarative CDS views (CQL). Views are the only DB access; the FE/Vue layers read via OData.
- **Auth:** `AuthorService` is `@requires: 'Tutorial.Author'`; do not add entities without keeping that scope. Never use `req.user` without `@requires`.
- **DISTINCT-user counting is mandatory** for started/completed (the reset/re-take flow leaves multiple rows per user+tutorial): `startedLearners = COUNT(DISTINCT user_ID)`, `completedLearners = COUNT(DISTINCT CASE WHEN status='COMPLETED' THEN user_ID END)`.
- **Completion rate:** `CAST(completedLearners AS Decimal(5,2)) * 100 / NULLIF(startedLearners, 0)` (guards divide-by-zero).
- **Fan-out is intentional** for mission/group filtering; never sum tutorial/completion/survey totals across parents without `DISTINCT`.
- **Role-aware API base in the Vue app:** always query via `useAuth().servicePath` (`/author/` for authors, `/admin/analytics/` for admins) + entity name — **never hardcode `/author/`** in the SPA. This is why survey-serving views are projected on **both** `AuthorService` and `AnalyticsService`.
- **HANA columns are UPPERCASE for raw SQL** — N/A here (all access is CQL/OData), but the conditional-DISTINCT must be HANA-verified (Task 5).
- **`npx cds deploy --to sqlite::memory:`** must pass before committing any `db/**` change.
- **Unit tests** run under the `unit` vitest project: `npx vitest run --project unit <path>` from repo root. Bootstrap: `cds.test('serve', '--project', '.', '--in-memory')` at module top-level, `process.env.SUBMISSION_SALT_SECRET = 'test-secret'` set before boot, seed via `cds.entities('com.sap.developers.ims')` + `INSERT.into(...).entries([...])` with `cds.utils.uuid()` keys.
- **Admin-UI changes require a FULL deploy** (`npm run deploy -- --env <env>`, no `--skip-build`/`-m`); the `analytics-explorer` dist ships only on a full `mbt build`. (Deploy is out of this plan's scope but noted for the eventual rollout.)

---

## File Structure

**Created:**
- `db/views.cds` — append 5 view definitions (`TutorialEngagementBase`, `AuthorTutorialParents`, `AuthorTutorialEngagement`, `AuthorTutorialCompletions`, `AuthorSurveyDistribution`).
- `app/author-annotations.cds` — UI/analytical annotations for the two FE views.
- `app/admin/tutorial-engagement/webapp/{Component.js,manifest.json}` — FE Analytical List Page.
- `app/admin/tutorial-completions/webapp/{Component.js,manifest.json}` — FE List Report.
- `app/analytics-explorer/src/views/SurveyReport.vue` — Vue survey dashboard.
- `app/analytics-explorer/src/api/survey.ts` — survey data access + pure aggregation helpers.
- Test files: `srv/__tests__/author-reporting-views.test.js`, `srv/__tests__/author-reporting-service.test.js`, `app/analytics-explorer/src/api/__tests__/survey.test.ts`, `app/analytics-explorer/src/views/__tests__/SurveyReport.test.ts`.

**Modified:**
- `srv/author-service.cds` — project the 4 exposed views `@readonly`.
- `srv/analytics-service.cds` — project `AuthorSurveyDistribution` + `AuthorTutorialParents` (+ verify `TutorialFeedback`/`TutorialFeedbackAggregate`) for the admin path.
- `app/admin-shell/scripts/admin-shell-overrides.js` — add `order` + `prefix` entries for the two new FE folders.
- `app/admin-shell/webapp/model/navigation.json` — 3 new leaves under `reporting`.
- `app/admin-shell/webapp/controller/Shell.controller.js` — `NAV_KEY_TO_ROUTE` + `NAV_KEY_TO_TITLE` for the 2 FE keys.
- `app/admin-shell/webapp/manifest.json` — regenerated by `generate-manifest.js` (do not hand-edit).
- `app/analytics-explorer/src/router.ts` — add the `/reports/survey` route.
- `app/analytics-explorer/src/App.vue` — add a shellbar nav item linking to `#/reports/survey`.

---

## Task 1: Foundation views — `TutorialEngagementBase` + `AuthorTutorialParents`

**Files:**
- Modify: `db/views.cds` (append at end of file)
- Test: `srv/__tests__/author-reporting-views.test.js` (create)

**Interfaces:**
- Produces: `ims.TutorialEngagementBase { tutorialSlug: String, startedLearners: Integer, completedLearners: Integer, completions: Integer, firstCompletion: Timestamp, lastCompletion: Timestamp }` (grain: 1 row per tutorialSlug).
- Produces: `ims.AuthorTutorialParents { tutorialSlug: String, tutorialTitle: String, missionTitle: String, groupTitle: String }` (distinct rows; a tutorial reused across missions/groups yields multiple rows; group-direct tutorials have `missionTitle = null`).

- [ ] **Step 1: Write the failing test**

Create `srv/__tests__/author-reporting-views.test.js`:

```js
// srv/__tests__/author-reporting-views.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

process.env.SUBMISSION_SALT_SECRET = 'test-secret';

cds.test('serve', '--project', '.', '--in-memory');

// Legacy ids used across the reporting-view suite.
const TUT_A = 9001; // slug 'rep-tut-a'
const TUT_B = 9002; // slug 'rep-tut-b'
const MISSION = 8001;
const GROUP = 7001;
const PATH = 6001;

async function seed() {
  const {
    Tutorials, Missions, Groups, CompletionPaths, CompletionPathItems,
    GroupPathItems, TaskRecords, Users
  } = cds.entities('com.sap.developers.ims');

  const userA = cds.utils.uuid();
  const userB = cds.utils.uuid();
  await INSERT.into(Users).entries([{ ID: userA }, { ID: userB }]);

  await INSERT.into(Groups).entries([
    { ID: cds.utils.uuid(), legacyId: GROUP, title: 'Rep Group', slug: 'rep-group', status: 'ACTIVE' }
  ]);
  const groupRow = await SELECT.one.from(Groups).where({ legacyId: GROUP });

  await INSERT.into(Missions).entries([
    { ID: cds.utils.uuid(), legacyId: MISSION, title: 'Rep Mission', slug: 'rep-mission',
      status: 'ACTIVE', published: false, group_ID: groupRow.ID }
  ]);
  const missionRow = await SELECT.one.from(Missions).where({ legacyId: MISSION });

  await INSERT.into(Tutorials).entries([
    { ID: cds.utils.uuid(), legacyId: TUT_A, title: 'Rep Tutorial A', slug: 'rep-tut-a', status: 'ACTIVE' },
    { ID: cds.utils.uuid(), legacyId: TUT_B, title: 'Rep Tutorial B', slug: 'rep-tut-b', status: 'ACTIVE' }
  ]);
  const tutB = await SELECT.one.from(Tutorials).where({ legacyId: TUT_B });

  await INSERT.into(CompletionPaths).entries([
    { ID: cds.utils.uuid(), legacyId: PATH, name: 'Rep Path', slug: 'rep-path', mission_ID: missionRow.ID }
  ]);
  const pathRow = await SELECT.one.from(CompletionPaths).where({ legacyId: PATH });

  // Tutorial A sits inside the mission's completion path.
  await INSERT.into(CompletionPathItems).entries([
    { ID: cds.utils.uuid(), path_ID: pathRow.ID, taskLegacyId: TUT_A, taskType: 'TUTORIAL', itemOrder: 1 }
  ]);
  // Tutorial B is group-direct (no mission).
  await INSERT.into(GroupPathItems).entries([
    { ID: cds.utils.uuid(), group_ID: groupRow.ID, tutorial_ID: tutB.ID, itemOrder: 1 }
  ]);

  // Engagement rows for Tutorial A: userA retook (SUPERSEDED attempt-1 + COMPLETED attempt-2),
  // userB in progress only. Distinct started = 2, distinct completed = 1.
  await INSERT.into(TaskRecords).entries([
    { ID: cds.utils.uuid(), user_ID: userA, taskLegacyId: TUT_A, taskType: 'TUTORIAL',
      status: 'SUPERSEDED', attemptNumber: 1, completionDate: '2026-01-10T00:00:00Z' },
    { ID: cds.utils.uuid(), user_ID: userA, taskLegacyId: TUT_A, taskType: 'TUTORIAL',
      status: 'COMPLETED', attemptNumber: 2, completionDate: '2026-02-15T00:00:00Z' },
    { ID: cds.utils.uuid(), user_ID: userB, taskLegacyId: TUT_A, taskType: 'TUTORIAL',
      status: 'IN_PROGRESS', attemptNumber: 1, completionDate: null }
  ]);
}

async function unseed() {
  const {
    Tutorials, Missions, Groups, CompletionPaths, CompletionPathItems,
    GroupPathItems, TaskRecords
  } = cds.entities('com.sap.developers.ims');
  await DELETE.from(TaskRecords).where({ taskLegacyId: { in: [TUT_A, TUT_B] } });
  await DELETE.from(CompletionPathItems).where({ taskLegacyId: { in: [TUT_A, TUT_B] } });
  await DELETE.from(GroupPathItems);
  await DELETE.from(CompletionPaths).where({ legacyId: PATH });
  await DELETE.from(Missions).where({ legacyId: MISSION });
  await DELETE.from(Groups).where({ legacyId: GROUP });
  await DELETE.from(Tutorials).where({ legacyId: { in: [TUT_A, TUT_B] } });
}

describe('reporting foundation views', () => {
  beforeAll(seed);
  afterAll(unseed);

  it('TutorialEngagementBase counts DISTINCT started/completed learners', async () => {
    const { TutorialEngagementBase } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(TutorialEngagementBase).where({ tutorialSlug: 'rep-tut-a' });
    expect(row).toBeTruthy();
    expect(row.startedLearners).toBe(2);   // userA + userB, deduped across attempts
    expect(row.completedLearners).toBe(1); // only userA completed
    expect(row.completions).toBe(1);       // one COMPLETED row
  });

  it('AuthorTutorialParents maps a mission-attached tutorial to its mission + group', async () => {
    const { AuthorTutorialParents } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AuthorTutorialParents).where({ tutorialSlug: 'rep-tut-a' });
    expect(rows.length).toBe(1);
    expect(rows[0].missionTitle).toBe('Rep Mission');
    expect(rows[0].groupTitle).toBe('Rep Group');
    expect(rows[0].tutorialTitle).toBe('Rep Tutorial A');
  });

  it('AuthorTutorialParents includes group-direct tutorials with null mission', async () => {
    const { AuthorTutorialParents } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AuthorTutorialParents).where({ tutorialSlug: 'rep-tut-b' });
    expect(rows.length).toBe(1);
    expect(rows[0].missionTitle).toBeNull();
    expect(rows[0].groupTitle).toBe('Rep Group');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit srv/__tests__/author-reporting-views.test.js`
Expected: FAIL — `TutorialEngagementBase` / `AuthorTutorialParents` are `undefined` (not yet defined in the model).

- [ ] **Step 3: Append the two views to `db/views.cds`**

At the end of `db/views.cds` add:

```cds
// ---------------------------------------------------------------------------
// Standard reports (#2138) — author-facing reporting views.
// See docs/superpowers/specs/2026-09-04-2138-standard-reports-design.md
// ---------------------------------------------------------------------------

// Per-tutorial engagement, all-time. DISTINCT-user counts are mandatory: the
// reset/re-take flow leaves a user with SUPERSEDED + IN_PROGRESS rows for one
// tutorial, so COUNT(*) would double-count. Grain: 1 row per tutorialSlug.
entity TutorialEngagementBase as
  select from ims.TaskRecords as tr
  inner join ims.Tutorials as tut on tut.legacyId = tr.taskLegacyId
  {
    key tut.slug as tutorialSlug : String,
    count(distinct tr.user.ID)                                                as startedLearners   : Integer,
    count(distinct case when tr.status = 'COMPLETED' then tr.user.ID end)     as completedLearners : Integer,
    sum(case when tr.status = 'COMPLETED' then 1 else 0 end)                  as completions       : Integer,
    min(case when tr.status = 'COMPLETED' then tr.completionDate end)         as firstCompletion   : Timestamp,
    max(case when tr.status = 'COMPLETED' then tr.completionDate end)         as lastCompletion    : Timestamp
  }
  where tr.taskType = 'TUTORIAL'
  group by tut.slug;

// Tutorial -> (mission, group) containment spine, mirroring NavigatorCatalog
// but (a) WITHOUT the mission.published filter (authors need in-progress
// content) and (b) adding a UNION for group-direct tutorials (missionTitle
// NULL). Feeds the Vue survey filter dropdowns and the engagement/completions
// mission/group columns. Distinct via UNION.
view AuthorTutorialParents as
  (
    select from ims.CompletionPathItems as item
    inner join ims.Tutorials      as tut     on tut.legacyId = item.taskLegacyId
    inner join ims.CompletionPaths as path   on path.ID      = item.path.ID
    inner join ims.Missions       as mission on mission.ID   = path.mission.ID
    left  join ims.Groups         as grp     on grp.ID       = mission.group.ID
    {
      tut.slug      as tutorialSlug  : String,
      tut.title     as tutorialTitle : String,
      mission.title as missionTitle  : String,
      grp.title     as groupTitle    : String
    }
    where item.taskType = 'TUTORIAL' and tut.slug is not null
  )
  union
  (
    select from ims.GroupPathItems as gitem
    inner join ims.Tutorials as tut on tut.ID  = gitem.tutorial.ID
    inner join ims.Groups    as grp on grp.ID  = gitem.group.ID
    {
      tut.slug            as tutorialSlug  : String,
      tut.title           as tutorialTitle : String,
      cast(null as String) as missionTitle : String,
      grp.title           as groupTitle    : String
    }
    where tut.slug is not null
  );
```

- [ ] **Step 4: Verify the model compiles against SQLite**

Run: `npx cds deploy --to sqlite::memory:`
Expected: no errors (views resolve). If `union` with `cast(null as String)` is rejected by the compiler, replace `cast(null as String) as missionTitle : String` with `null as missionTitle : String` and re-run.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project unit srv/__tests__/author-reporting-views.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add db/views.cds srv/__tests__/author-reporting-views.test.js
git commit -m "feat(#2138): add TutorialEngagementBase + AuthorTutorialParents reporting views"
```

---

## Task 2: `AuthorTutorialEngagement` view (Report A source)

**Files:**
- Modify: `db/views.cds` (append)
- Test: `srv/__tests__/author-reporting-views.test.js` (extend)

**Interfaces:**
- Consumes: `ims.AuthorTutorialParents`, `ims.TutorialEngagementBase` (Task 1).
- Produces: `ims.AuthorTutorialEngagement { reportKey: String(600) [key], tutorialSlug, tutorialTitle, missionTitle, groupTitle, startedLearners: Integer, completedLearners: Integer, completions: Integer, completionRatePct: Decimal(5,2), firstCompletion: Timestamp, lastCompletion: Timestamp }` (grain: 1 row per tutorialSlug × missionTitle × groupTitle; fan-out intentional).

- [ ] **Step 1: Write the failing test** (append inside the `describe` block in `author-reporting-views.test.js`)

```js
  it('AuthorTutorialEngagement joins counts to the mission/group spine with completion rate', async () => {
    const { AuthorTutorialEngagement } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(AuthorTutorialEngagement).where({ tutorialSlug: 'rep-tut-a' });
    expect(row).toBeTruthy();
    expect(row.missionTitle).toBe('Rep Mission');
    expect(row.groupTitle).toBe('Rep Group');
    expect(row.startedLearners).toBe(2);
    expect(row.completedLearners).toBe(1);
    // 1 / 2 * 100 = 50.00
    expect(Number(row.completionRatePct)).toBeCloseTo(50, 2);
    expect(row.reportKey).toBeTruthy();
  });

  it('AuthorTutorialEngagement completionRatePct is null-safe when startedLearners is 0', async () => {
    // rep-tut-b is group-direct with no TaskRecords -> not in TutorialEngagementBase,
    // so the inner join drops it. Assert it is absent rather than dividing by zero.
    const { AuthorTutorialEngagement } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AuthorTutorialEngagement).where({ tutorialSlug: 'rep-tut-b' });
    expect(rows.length).toBe(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit srv/__tests__/author-reporting-views.test.js`
Expected: FAIL — `AuthorTutorialEngagement` is undefined.

- [ ] **Step 3: Append the view to `db/views.cds`**

```cds
// Report A — Tutorial Engagement (FE Analytical List Page). Pre-aggregated,
// all-time (no date slicer: distinct counts don't compose with a date range).
// Fan-out: 1 row per (tutorialSlug, missionTitle, groupTitle). Synthetic
// reportKey gives the OData entity a stable, unique key across fanned rows.
view AuthorTutorialEngagement as
  select from AuthorTutorialParents as p
  inner join TutorialEngagementBase as e on e.tutorialSlug = p.tutorialSlug
  {
    key (
      p.tutorialSlug || '::' || coalesce(p.missionTitle, '~') || '::' || coalesce(p.groupTitle, '~')
    ) as reportKey : String(600),
    p.tutorialSlug     as tutorialSlug     : String,
    p.tutorialTitle    as tutorialTitle    : String,
    p.missionTitle     as missionTitle     : String,
    p.groupTitle       as groupTitle       : String,
    e.startedLearners  as startedLearners  : Integer,
    e.completedLearners as completedLearners : Integer,
    e.completions      as completions      : Integer,
    cast(e.completedLearners as Decimal(5,2)) * 100 / nullif(e.startedLearners, 0)
                       as completionRatePct : Decimal(5,2),
    e.firstCompletion  as firstCompletion  : Timestamp,
    e.lastCompletion   as lastCompletion   : Timestamp
  };
```

- [ ] **Step 4: Verify compile + run test**

Run: `npx cds deploy --to sqlite::memory:` (expect no errors), then
`npx vitest run --project unit srv/__tests__/author-reporting-views.test.js`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add db/views.cds srv/__tests__/author-reporting-views.test.js
git commit -m "feat(#2138): add AuthorTutorialEngagement view with distinct-user completion rate"
```

---

## Task 3: `AuthorTutorialCompletions` view (Report B source)

**Files:**
- Modify: `db/views.cds` (append)
- Test: `srv/__tests__/author-reporting-views.test.js` (extend)

**Interfaces:**
- Consumes: `ims.AuthorTutorialParents` (Task 1).
- Produces: `ims.AuthorTutorialCompletions { reportKey: String(600) [key], recordId: UUID, tutorialSlug, tutorialTitle, missionTitle, groupTitle, completionDate: Timestamp, completionDay: Date, completionCount: Integer(=1) }` (row-per-completion at TUTORIAL grain, status IN COMPLETED+SUPERSEDED; fanned across parents for filtering).

- [ ] **Step 1: Write the failing test** (append inside the `describe` block)

```js
  it('AuthorTutorialCompletions emits one additive row per completion, carrying mission/group + day', async () => {
    const { AuthorTutorialCompletions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AuthorTutorialCompletions).where({ tutorialSlug: 'rep-tut-a' });
    // rep-tut-a has 2 COMPLETED/SUPERSEDED TaskRecords (attempt-1 SUPERSEDED, attempt-2 COMPLETED),
    // each fanned across its single (mission, group) parent => 2 rows.
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.missionTitle).toBe('Rep Mission');
      expect(r.groupTitle).toBe('Rep Group');
      expect(r.completionCount).toBe(1);
      expect(r.completionDay).toBeTruthy();
      expect(r.reportKey).toBeTruthy();
    }
    // completionDay is a date-only cast of completionDate.
    const days = rows.map(r => String(r.completionDay)).sort();
    expect(days[0]).toContain('2026-01-10');
    expect(days[1]).toContain('2026-02-15');
  });

  it('AuthorTutorialCompletions excludes IN_PROGRESS records', async () => {
    const { AuthorTutorialCompletions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AuthorTutorialCompletions).where({ tutorialSlug: 'rep-tut-a' });
    // The IN_PROGRESS attempt for userB must not appear.
    expect(rows.length).toBe(2);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit srv/__tests__/author-reporting-views.test.js`
Expected: FAIL — `AuthorTutorialCompletions` undefined.

- [ ] **Step 3: Append the view to `db/views.cds`**

```cds
// Report B — Tutorial Completions (FE List Report). Row-per-completion at
// TUTORIAL grain, status IN (COMPLETED, SUPERSEDED) to match CompletionAnalytics
// and capture re-completion history for the trend. completionCount is additive
// (composes with a completionDay date filter). Left-joined to the parents spine
// for mission/group FILTERING; this fans a completion across its parents, so
// the measure must be filtered by mission/group, never summed across all
// parents without DISTINCT (see spec §4.3). Synthetic reportKey stays unique
// across fanned rows.
view AuthorTutorialCompletions as
  select from ims.TaskRecords as tr
  inner join ims.Tutorials as tut on tut.legacyId = tr.taskLegacyId
  left  join AuthorTutorialParents as p on p.tutorialSlug = tut.slug
  {
    key (
      tr.ID || '::' || coalesce(p.missionTitle, '~') || '::' || coalesce(p.groupTitle, '~')
    ) as reportKey : String(600),
    tr.ID          as recordId       : UUID,
    tut.slug       as tutorialSlug    : String,
    tut.title      as tutorialTitle   : String,
    p.missionTitle as missionTitle    : String,
    p.groupTitle   as groupTitle      : String,
    tr.completionDate                 as completionDate : Timestamp,
    cast(tr.completionDate as Date)   as completionDay  : Date,
    1              as completionCount : Integer
  }
  where tr.taskType = 'TUTORIAL' and tr.status in ('COMPLETED', 'SUPERSEDED');
```

- [ ] **Step 4: Verify compile + run test**

Run: `npx cds deploy --to sqlite::memory:`, then
`npx vitest run --project unit srv/__tests__/author-reporting-views.test.js`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add db/views.cds srv/__tests__/author-reporting-views.test.js
git commit -m "feat(#2138): add AuthorTutorialCompletions row-per-completion view"
```

---

## Task 4: `AuthorSurveyDistribution` view (Report C source)

**Files:**
- Modify: `db/views.cds` (append)
- Test: `srv/__tests__/author-reporting-views.test.js` (extend)

**Interfaces:**
- Produces: `ims.AuthorSurveyDistribution { tutorialSlug: String [key], dimension: String(20) [key], score: Integer [key], responseCount: Integer }` — unpivot of the 7 survey fields; null scores excluded per dimension. `dimension` ∈ {`structure`, `interesting`, `useCase`, `relevance`, `duration`, `visuals`, `nps`}.

- [ ] **Step 1: Write the failing test** (append inside the `describe` block; also extend `seed`/`unseed`)

Add to `seed()` (before its closing brace), seeding feedback for `rep-tut-a`:

```js
  const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
  await INSERT.into(TutorialFeedback).entries([
    { ID: cds.utils.uuid(), tutorialSlug: 'rep-tut-a', ratingStructure: 8, ratingInteresting: 8,
      ratingUseCase: 7, ratingRelevance: 9, ratingDuration: 6, ratingVisuals: 8, npsScore: 10,
      comment: 'Great', submittedAt: '2026-02-01T00:00:00Z' },
    { ID: cds.utils.uuid(), tutorialSlug: 'rep-tut-a', ratingStructure: 8, ratingInteresting: 5,
      ratingUseCase: null, ratingRelevance: 4, ratingDuration: 6, ratingVisuals: 3, npsScore: null,
      comment: null, submittedAt: '2026-02-02T00:00:00Z' }
  ]);
```

Add to `unseed()` (before its closing brace):

```js
  const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
  await DELETE.from(TutorialFeedback).where({ tutorialSlug: 'rep-tut-a' });
```

Add the test:

```js
  it('AuthorSurveyDistribution unpivots ratings into (dimension, score, count), excluding nulls', async () => {
    const { AuthorSurveyDistribution } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(AuthorSurveyDistribution).where({ tutorialSlug: 'rep-tut-a' });

    // structure: two responses both score 8 -> single bucket count 2
    const structure = rows.filter(r => r.dimension === 'structure');
    expect(structure.length).toBe(1);
    expect(structure[0].score).toBe(8);
    expect(structure[0].responseCount).toBe(2);

    // useCase: one null excluded -> single bucket (score 7, count 1)
    const useCase = rows.filter(r => r.dimension === 'useCase');
    expect(useCase.length).toBe(1);
    expect(useCase[0].score).toBe(7);
    expect(useCase[0].responseCount).toBe(1);

    // nps: one null excluded -> single bucket (score 10, count 1)
    const nps = rows.filter(r => r.dimension === 'nps');
    expect(nps.length).toBe(1);
    expect(nps[0].score).toBe(10);

    // all 7 dimension keys present among the rows
    const dims = new Set(rows.map(r => r.dimension));
    for (const d of ['structure', 'interesting', 'useCase', 'relevance', 'duration', 'visuals', 'nps']) {
      expect(dims.has(d)).toBe(true);
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit srv/__tests__/author-reporting-views.test.js`
Expected: FAIL — `AuthorSurveyDistribution` undefined.

- [ ] **Step 3: Append the view to `db/views.cds`**

```cds
// Report C — Tutorial Survey (Vue). Unpivots the 7 survey dimensions into
// (tutorialSlug, dimension, score, responseCount). Null scores excluded per
// dimension. The Vue page sums responseCount per (dimension, score) over the
// filtered slug set and renders % = bucket ÷ dimension-total. Composite key
// (tutorialSlug, dimension, score) is unique after the per-leg GROUP BY.
entity AuthorSurveyDistribution as
      (select from ims.TutorialFeedback {
         key tutorialSlug,
         key 'structure' as dimension : String(20),
         key ratingStructure as score : Integer,
         count(*) as responseCount : Integer
       } where ratingStructure is not null group by tutorialSlug, ratingStructure)
  union all
      (select from ims.TutorialFeedback {
         key tutorialSlug,
         key 'interesting' as dimension : String(20),
         key ratingInteresting as score : Integer,
         count(*) as responseCount : Integer
       } where ratingInteresting is not null group by tutorialSlug, ratingInteresting)
  union all
      (select from ims.TutorialFeedback {
         key tutorialSlug,
         key 'useCase' as dimension : String(20),
         key ratingUseCase as score : Integer,
         count(*) as responseCount : Integer
       } where ratingUseCase is not null group by tutorialSlug, ratingUseCase)
  union all
      (select from ims.TutorialFeedback {
         key tutorialSlug,
         key 'relevance' as dimension : String(20),
         key ratingRelevance as score : Integer,
         count(*) as responseCount : Integer
       } where ratingRelevance is not null group by tutorialSlug, ratingRelevance)
  union all
      (select from ims.TutorialFeedback {
         key tutorialSlug,
         key 'duration' as dimension : String(20),
         key ratingDuration as score : Integer,
         count(*) as responseCount : Integer
       } where ratingDuration is not null group by tutorialSlug, ratingDuration)
  union all
      (select from ims.TutorialFeedback {
         key tutorialSlug,
         key 'visuals' as dimension : String(20),
         key ratingVisuals as score : Integer,
         count(*) as responseCount : Integer
       } where ratingVisuals is not null group by tutorialSlug, ratingVisuals)
  union all
      (select from ims.TutorialFeedback {
         key tutorialSlug,
         key 'nps' as dimension : String(20),
         key npsScore as score : Integer,
         count(*) as responseCount : Integer
       } where npsScore is not null group by tutorialSlug, npsScore);
```

- [ ] **Step 4: Verify compile + run test**

Run: `npx cds deploy --to sqlite::memory:`, then
`npx vitest run --project unit srv/__tests__/author-reporting-views.test.js`
Expected: PASS (8 tests total).

**Fallback if the union view fails to compile or key resolution errors:** delete `AuthorSurveyDistribution` from `db/views.cds` and instead have the Vue page bucket client-side over raw `TutorialFeedback` rows (Task 11 already fetches those rows for the comments table). If you take this path, drop the `AuthorSurveyDistribution` projections in Task 5 and set `fetchSurveyDistribution` in Task 11 to compute buckets from the raw rows. Note the change in the task's commit message and the spec.

- [ ] **Step 5: Commit**

```bash
git add db/views.cds srv/__tests__/author-reporting-views.test.js
git commit -m "feat(#2138): add AuthorSurveyDistribution unpivot view (7 dimensions)"
```

---

## Task 5: Service projections + HANA parity

**Files:**
- Modify: `srv/author-service.cds`
- Modify: `srv/analytics-service.cds`
- Test: `srv/__tests__/author-reporting-service.test.js` (create)

**Interfaces:**
- Produces (OData, `/author/`): `AuthorTutorialEngagement`, `AuthorTutorialCompletions`, `AuthorSurveyDistribution`, `AuthorTutorialParents`.
- Produces (OData, `/admin/analytics/`): `AuthorSurveyDistribution`, `AuthorTutorialParents` (so the Vue survey page works for admin-role users, whose `servicePath` is `/admin/analytics/`). `TutorialFeedback` + `TutorialFeedbackAggregate` must also resolve on this path.

- [ ] **Step 1: Write the failing test**

Create `srv/__tests__/author-reporting-service.test.js`:

```js
// srv/__tests__/author-reporting-service.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

process.env.SUBMISSION_SALT_SECRET = 'test-secret';

const { GET, expect: _e } = cds.test('serve', '--project', '.', '--in-memory');

const AUTHOR = { auth: { username: 'author', password: 'author' } };

describe('AuthorService reporting projections', () => {
  it('exposes the four reporting entities on /author with Tutorial.Author auth', async () => {
    for (const entity of [
      'AuthorTutorialEngagement',
      'AuthorTutorialCompletions',
      'AuthorSurveyDistribution',
      'AuthorTutorialParents'
    ]) {
      const res = await GET(`/author/${entity}?$top=1`, AUTHOR);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data.value)).toBe(true);
    }
  });

  it('rejects anonymous access to /author reporting entities', async () => {
    await expect(GET('/author/AuthorTutorialEngagement')).rejects.toMatchObject({
      response: { status: 401 }
    });
  });
});
```

> Auth: the test uses CAP's mocked users. Confirm an `author` mock user with the `Tutorial.Author` role exists in `.cdsrc*`/`package.json` `cds.requires.auth.users`; if the project's existing author-service tests use a different mock username, copy that (grep `srv/__tests__` for an existing `/author/` HTTP test — e.g. `385-pr3-authorservice` referenced in `srv/author-service.cds`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit srv/__tests__/author-reporting-service.test.js`
Expected: FAIL — 404 on the new entities (not projected yet).

- [ ] **Step 3: Add projections to `srv/author-service.cds`**

After the existing `CompletionAnalytics` projection block (near line 26), add:

```cds
  // Standard reports (#2138). Read-only views; no date slicer on engagement
  // (see spec §4.3). Parents/Distribution also projected on AnalyticsService
  // so the Vue survey page resolves them under both /author and /admin/analytics.
  @readonly entity AuthorTutorialEngagement  as projection on ims.AuthorTutorialEngagement;
  @readonly entity AuthorTutorialCompletions as projection on ims.AuthorTutorialCompletions;
  @readonly entity AuthorSurveyDistribution  as projection on ims.AuthorSurveyDistribution;
  @readonly entity AuthorTutorialParents     as projection on ims.AuthorTutorialParents;
```

- [ ] **Step 4: Add projections to `srv/analytics-service.cds`**

Grep the file first for existing `TutorialFeedback` / `TutorialFeedbackAggregate` projections:

Run: `rg -n "TutorialFeedback|AuthorSurveyDistribution|AuthorTutorialParents" srv/analytics-service.cds`

Add whichever of these are missing (inside the `service AnalyticsService { ... }` body):

```cds
  @readonly entity AuthorSurveyDistribution  as projection on ims.AuthorSurveyDistribution;
  @readonly entity AuthorTutorialParents     as projection on ims.AuthorTutorialParents;
  // Only add the next two if they are not already projected on AnalyticsService:
  @readonly entity TutorialFeedback          as projection on ims.TutorialFeedback;
  @readonly entity TutorialFeedbackAggregate as projection on ims.TutorialFeedbackAggregate;
```

- [ ] **Step 5: Verify compile + run test**

Run: `npx cds deploy --to sqlite::memory:` (expect no errors), then
`npx vitest run --project unit srv/__tests__/author-reporting-service.test.js`
Expected: PASS.

- [ ] **Step 6: HANA parity check for conditional-DISTINCT (manual, requires `cf login`)**

Run (needs a bound HANA + `cf login`):

```bash
cds bind --exec -- node -e "const cds=require('@sap/cds'); (async()=>{ await cds.connect.to('db'); const rows = await SELECT.from('com.sap.developers.ims.TutorialEngagementBase').limit(3); console.log(JSON.stringify(rows,null,2)); process.exit(0); })().catch(e=>{console.error(e);process.exit(1)})"
```

Expected: rows return with integer `startedLearners`/`completedLearners` (no HANA error on `COUNT(DISTINCT CASE WHEN … END)`).

**If HANA rejects the inline conditional-distinct**, replace the `completedLearners` expression in `TutorialEngagementBase` with a two-subquery join (started set ⟕ completed set), mirroring the pattern in `SearchableItems` in `db/views.cds`: compute `completedLearners` from a separate grouped sub-select over `TaskRecords` filtered to `status='COMPLETED'`, left-joined on `tutorialSlug`. Re-run Step 5 and this step.

- [ ] **Step 7: Commit**

```bash
git add srv/author-service.cds srv/analytics-service.cds srv/__tests__/author-reporting-service.test.js
git commit -m "feat(#2138): project reporting views on AuthorService + AnalyticsService"
```

---

## Task 6: FE analytical annotations — `app/author-annotations.cds`

**Files:**
- Create: `app/author-annotations.cds`
- Test: verified via `cds compile` (annotations are declarative; no unit test).

**Interfaces:**
- Consumes: `AuthorService.AuthorTutorialEngagement`, `AuthorService.AuthorTutorialCompletions`.
- Produces: `@UI.Chart`, `@UI.LineItem`, `@UI.SelectionFields`, `@Aggregation.ApplySupported`, `@Analytics.*` metadata consumed by the two FE apps.

- [ ] **Step 1: Confirm how `app/*.cds` annotation files are loaded**

Run: `head -20 app/admin-annotations.cds` — copy its `using ... from '../srv/...'` header style. Confirm `app/**/*.cds` is part of the CAP model (it is: `admin-annotations.cds` already annotates `AdminService`).

- [ ] **Step 2: Create `app/author-annotations.cds`**

```cds
using { AuthorService } from '../srv/author-service';

// Report A — Tutorial Engagement (Analytical List Page).
// Starts-vs-completions bar per tutorial, completion-rate criticality in the table.
annotate AuthorService.AuthorTutorialEngagement with @(
  Aggregation.ApplySupported: {
    Transformations: ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'],
    GroupableProperties: [ tutorialTitle, missionTitle, groupTitle ],
    AggregatableProperties: [
      { Property: startedLearners },
      { Property: completedLearners },
      { Property: completions }
    ]
  },
  Analytics.AggregatedProperty #totalStarted: {
    Name: 'totalStarted', AggregationMethod: 'sum',
    AggregatableProperty: startedLearners, ![@Common.Label]: 'Started'
  },
  Analytics.AggregatedProperty #totalCompleted: {
    Name: 'totalCompleted', AggregationMethod: 'sum',
    AggregatableProperty: completedLearners, ![@Common.Label]: 'Completed'
  },
  UI.Chart: {
    ChartType: #Bar,
    Dimensions: [tutorialTitle],
    DynamicMeasures: [
      '@Analytics.AggregatedProperty#totalStarted',
      '@Analytics.AggregatedProperty#totalCompleted'
    ]
  },
  UI.PresentationVariant: {
    Visualizations: ['@UI.Chart', '@UI.LineItem'],
    SortOrder: [{ Property: startedLearners, Descending: true }]
  },
  UI.SelectionFields: [ missionTitle, groupTitle, tutorialTitle ],
  UI.DataPoint #rate: {
    Value: completionRatePct,
    Title: 'Completion Rate %',
    CriticalityCalculation: {
      ImprovementDirection      : #Maximize,
      DeviationRangeLowValue    : 25,
      ToleranceRangeLowValue    : 50
    }
  },
  UI.LineItem: [
    { Value: tutorialTitle },
    { Value: missionTitle },
    { Value: groupTitle },
    { Value: startedLearners,   Label: 'Started' },
    { Value: completedLearners, Label: 'Completed' },
    { Value: completions,       Label: 'Completions' },
    { $Type: 'UI.DataFieldForAnnotation', Target: '@UI.DataPoint#rate', Label: 'Completion Rate %' }
  ]
) {
  reportKey         @UI.Hidden;
  tutorialSlug      @UI.Hidden;
  tutorialTitle     @title: 'Tutorial'   @Analytics.Dimension;
  missionTitle      @title: 'Mission'    @Analytics.Dimension;
  groupTitle        @title: 'Group'      @Analytics.Dimension;
  startedLearners   @title: 'Started'    @Analytics.Measure @Aggregation.default: #SUM;
  completedLearners @title: 'Completed'  @Analytics.Measure @Aggregation.default: #SUM;
  completions       @title: 'Completions' @Analytics.Measure @Aggregation.default: #SUM;
  completionRatePct @title: 'Completion Rate %';
};

// Report B — Tutorial Completions (List Report). Completions over time, filterable
// by mission/group/tutorial/date.
annotate AuthorService.AuthorTutorialCompletions with @(
  Aggregation.ApplySupported: {
    Transformations: ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'],
    GroupableProperties: [ completionDay, tutorialTitle, missionTitle, groupTitle ],
    AggregatableProperties: [ { Property: completionCount } ]
  },
  Analytics.AggregatedProperty #totalCompletions: {
    Name: 'totalCompletions', AggregationMethod: 'sum',
    AggregatableProperty: completionCount, ![@Common.Label]: 'Completions'
  },
  UI.Chart: {
    ChartType: #Column,
    Dimensions: [completionDay],
    DynamicMeasures: ['@Analytics.AggregatedProperty#totalCompletions']
  },
  UI.PresentationVariant: {
    Visualizations: ['@UI.Chart', '@UI.LineItem'],
    SortOrder: [{ Property: completionDate, Descending: true }]
  },
  UI.SelectionFields: [ missionTitle, groupTitle, tutorialTitle, completionDate ],
  UI.LineItem: [
    { Value: completionDate },
    { Value: tutorialTitle },
    { Value: missionTitle },
    { Value: groupTitle },
    { Value: completionCount, Label: 'Completions' }
  ]
) {
  reportKey       @UI.Hidden;
  recordId        @UI.Hidden;
  tutorialSlug    @UI.Hidden;
  tutorialTitle   @title: 'Tutorial'        @Analytics.Dimension;
  missionTitle    @title: 'Mission'         @Analytics.Dimension;
  groupTitle      @title: 'Group'           @Analytics.Dimension;
  completionDate  @title: 'Completion Date' @Analytics.Dimension;
  completionDay   @title: 'Completion Day'  @Analytics.Dimension;
  completionCount @title: 'Completions'     @Analytics.Measure @Aggregation.default: #SUM;
};
```

- [ ] **Step 3: Verify the annotations compile and reach the service metadata**

Run: `npx cds compile srv --to edmx > "$CLAUDE_JOB_DIR/tmp/author-edmx.xml" 2>&1 || npx cds compile srv/author-service.cds --to edmx`
Then confirm the analytical terms are present:
Run: `rg -c "AuthorTutorialEngagement|Aggregation.ApplySupported|UI.Chart" "$CLAUDE_JOB_DIR/tmp/author-edmx.xml"`
Expected: non-zero counts; no compile errors. (If `cds compile srv` is too broad, compile the service file directly.)

- [ ] **Step 4: Re-run the full view + service suites to confirm no regression**

Run: `npx vitest run --project unit srv/__tests__/author-reporting-views.test.js srv/__tests__/author-reporting-service.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/author-annotations.cds
git commit -m "feat(#2138): FE analytical annotations for engagement + completions reports"
```

---

## Task 7: FE component — Tutorial Engagement (Analytical List Page)

**Files:**
- Create: `app/admin/tutorial-engagement/webapp/manifest.json`
- Create: `app/admin/tutorial-engagement/webapp/Component.js`

**Interfaces:**
- Consumes: `AuthorService.AuthorTutorialEngagement` (`/author/`) + its annotations (Task 6).
- Produces: componentUsage `tutorialEngagementComponent`, route/target `tutorialEngagement` (auto-emitted by `generate-manifest.js` in Task 9). `sap.app.id` MUST be `sap.tutorials.admin.tutorialEngagement` (camelCase of folder `tutorial-engagement`), else the discovery script hard-fails the build.

- [ ] **Step 1: Create `app/admin/tutorial-engagement/webapp/Component.js`**

```js
sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";
  return AppComponent.extend("sap.tutorials.admin.tutorialEngagement.Component", {
    metadata: { manifest: "json" }
  });
});
```

- [ ] **Step 2: Create `app/admin/tutorial-engagement/webapp/manifest.json`**

```json
{
  "_version": "1.65.0",
  "sap.app": {
    "id": "sap.tutorials.admin.tutorialEngagement",
    "type": "application",
    "title": "Tutorial Engagement",
    "description": "Starts vs completions per tutorial within a mission/group",
    "applicationVersion": { "version": "0.0.1" },
    "dataSources": {
      "mainService": {
        "uri": "/author/",
        "type": "OData",
        "settings": { "odataVersion": "4.0" }
      }
    },
    "crossNavigation": {
      "inbounds": {
        "TutorialEngagement-analyze": {
          "semanticObject": "TutorialEngagement",
          "action": "analyze",
          "title": "Tutorial Engagement",
          "signature": { "parameters": {}, "additionalParameters": "allowed" }
        }
      }
    }
  },
  "sap.ui5": {
    "dependencies": {
      "minUI5Version": "1.136.0",
      "libs": { "sap.fe.templates": {}, "sap.m": {}, "sap.ui.core": {} }
    },
    "models": {
      "": {
        "dataSource": "mainService",
        "preload": true,
        "settings": {
          "synchronizationMode": "None",
          "operationMode": "Server",
          "autoExpandSelect": true,
          "earlyRequests": true
        }
      }
    },
    "routing": {
      "routes": [
        { "pattern": ":?query:", "name": "TutorialEngagementALP", "target": "TutorialEngagementALP" }
      ],
      "targets": {
        "TutorialEngagementALP": {
          "type": "Component",
          "id": "TutorialEngagementALP",
          "name": "sap.fe.templates.AnalyticalListPage",
          "options": {
            "settings": {
              "contextPath": "/AuthorTutorialEngagement",
              "variantManagement": "Page",
              "initialLoad": "Enabled",
              "hideVisualFilter": true,
              "controlConfiguration": {
                "@com.sap.vocabularies.UI.v1.Chart": { "chartInitiallyExpanded": true },
                "@com.sap.vocabularies.UI.v1.LineItem": {
                  "tableSettings": { "type": "AnalyticalTable" }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 3: Sanity-check the manifest is valid JSON and the id matches the folder**

Run: `jq -e '.["sap.app"].id == "sap.tutorials.admin.tutorialEngagement"' app/admin/tutorial-engagement/webapp/manifest.json`
Expected: `true`.

- [ ] **Step 4: Commit**

```bash
git add app/admin/tutorial-engagement/webapp/Component.js app/admin/tutorial-engagement/webapp/manifest.json
git commit -m "feat(#2138): Tutorial Engagement FE Analytical List Page component"
```

---

## Task 8: FE component — Tutorial Completions (List Report)

**Files:**
- Create: `app/admin/tutorial-completions/webapp/manifest.json`
- Create: `app/admin/tutorial-completions/webapp/Component.js`

**Interfaces:**
- Consumes: `AuthorService.AuthorTutorialCompletions` (`/author/`) + annotations (Task 6).
- Produces: componentUsage `tutorialCompletionsComponent`, route/target `tutorialCompletions` (auto-emitted in Task 9). `sap.app.id` MUST be `sap.tutorials.admin.tutorialCompletions`.

- [ ] **Step 1: Create `app/admin/tutorial-completions/webapp/Component.js`**

```js
sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";
  return AppComponent.extend("sap.tutorials.admin.tutorialCompletions.Component", {
    metadata: { manifest: "json" }
  });
});
```

- [ ] **Step 2: Create `app/admin/tutorial-completions/webapp/manifest.json`**

```json
{
  "_version": "1.65.0",
  "sap.app": {
    "id": "sap.tutorials.admin.tutorialCompletions",
    "type": "application",
    "title": "Tutorial Completions",
    "description": "Tutorial completion events over time by mission/group",
    "applicationVersion": { "version": "0.0.1" },
    "dataSources": {
      "mainService": {
        "uri": "/author/",
        "type": "OData",
        "settings": { "odataVersion": "4.0" }
      }
    },
    "crossNavigation": {
      "inbounds": {
        "TutorialCompletions-display": {
          "semanticObject": "TutorialCompletions",
          "action": "display",
          "title": "Tutorial Completions",
          "signature": { "parameters": {}, "additionalParameters": "allowed" }
        }
      }
    }
  },
  "sap.ui5": {
    "dependencies": {
      "minUI5Version": "1.136.0",
      "libs": { "sap.fe.templates": {} }
    },
    "models": {
      "": {
        "dataSource": "mainService",
        "preload": true,
        "settings": {
          "synchronizationMode": "None",
          "operationMode": "Server",
          "autoExpandSelect": true,
          "earlyRequests": true
        }
      }
    },
    "routing": {
      "routes": [
        { "pattern": ":?query:", "name": "TutorialCompletionsList", "target": "TutorialCompletionsList" }
      ],
      "targets": {
        "TutorialCompletionsList": {
          "type": "Component",
          "id": "TutorialCompletionsList",
          "name": "sap.fe.templates.ListReport",
          "options": {
            "settings": {
              "contextPath": "/AuthorTutorialCompletions",
              "variantManagement": "Page",
              "initialLoad": "Enabled"
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 3: Sanity-check JSON + id**

Run: `jq -e '.["sap.app"].id == "sap.tutorials.admin.tutorialCompletions"' app/admin/tutorial-completions/webapp/manifest.json`
Expected: `true`.

- [ ] **Step 4: Commit**

```bash
git add app/admin/tutorial-completions/webapp/Component.js app/admin/tutorial-completions/webapp/manifest.json
git commit -m "feat(#2138): Tutorial Completions FE List Report component"
```

---

## Task 9: Register the two FE components in the shell manifest

**Files:**
- Modify: `app/admin-shell/scripts/admin-shell-overrides.js`
- Modify (generated): `app/admin-shell/webapp/manifest.json` (via `generate-manifest.js`)

**Interfaces:**
- Consumes: the two component folders (Tasks 7–8).
- Produces: shell routes `tutorialEngagement` + `tutorialCompletions` with prefixes `teg` / `tcp`, resolvable by `getRouter().navTo(...)` (Task 10).

- [ ] **Step 1: Add `order` entries in `admin-shell-overrides.js`**

In the `order` array, insert the two folder names right after `'analytics',`:

```js
    'analytics',
    'tutorial-engagement',
    'tutorial-completions',
```

- [ ] **Step 2: Add `prefix` entries in `admin-shell-overrides.js`**

In the `prefix` map, after `analytics: 'an',` add (2–3 char, must be unique — `te`/`tc`/`tu` avoidance: `tc` = topicClusters is taken, `tu` = tutorials is taken, so use distinct 3-letter prefixes):

```js
    analytics: 'an',
    'tutorial-engagement': 'teg',
    'tutorial-completions': 'tcp',
```

- [ ] **Step 3: Regenerate the shell manifest**

Run: `npm --prefix app/admin-shell run generate-manifest`
Expected: exits 0 (no prefix-collision error). If it reports a collision, pick a different free 3-letter prefix and re-run.

- [ ] **Step 4: Verify the generated manifest contains the new wiring**

Run:
```bash
jq -e '.["sap.ui5"].componentUsages | has("tutorialEngagementComponent") and has("tutorialCompletionsComponent")' app/admin-shell/webapp/manifest.json
jq -e '[.["sap.ui5"].routing.routes[].name] | index("tutorialEngagement") != null and (index("tutorialCompletions") != null)' app/admin-shell/webapp/manifest.json
```
Expected: `true` for both. Also confirm the component registrations resolve to the folders:
```bash
jq -r '.["sap.ui5"].dependencies.components // .["sap.ui5"].componentUsages | keys[]' app/admin-shell/webapp/manifest.json | rg -i 'tutorialEngagement|tutorialCompletions'
```

- [ ] **Step 5: Commit**

```bash
git add app/admin-shell/scripts/admin-shell-overrides.js app/admin-shell/webapp/manifest.json
git commit -m "feat(#2138): register engagement + completions components in admin shell"
```

---

## Task 10: Navigation leaves + Shell controller maps

**Files:**
- Modify: `app/admin-shell/webapp/model/navigation.json`
- Modify: `app/admin-shell/webapp/controller/Shell.controller.js`

**Interfaces:**
- Consumes: shell routes `tutorialEngagement`/`tutorialCompletions` (Task 9); the Vue route `#/reports/survey` (Task 12).
- Produces: three visible leaves under the Reporting folder.

- [ ] **Step 1: Add three leaves to the `reporting` group in `navigation.json`**

Replace the `reporting` group's `items` array with (adds the three new leaves; all `Tutorial.Author`-scoped to match the existing `analyticsExternal` leaf):

```json
      "items": [
        { "key": "analyticsExternal", "title": "Analytics", "href": "/analytics-ui/", "target": "_self", "requiredScope": "Tutorial.Author" },
        { "key": "analytics", "title": "Completion analytics" },
        { "key": "tutorialEngagement", "title": "Tutorial Engagement", "requiredScope": "Tutorial.Author" },
        { "key": "tutorialCompletions", "title": "Tutorial Completions", "requiredScope": "Tutorial.Author" },
        { "key": "tutorialSurvey", "title": "Tutorial Survey", "href": "/analytics-ui/#/reports/survey", "target": "_self", "requiredScope": "Tutorial.Author" },
        { "key": "statistics", "title": "Statistics" },
        { "key": "metrics", "title": "Metrics" },
        { "key": "dataExport", "title": "Data Export" }
      ]
```

- [ ] **Step 2: Add the two FE keys to `NAV_KEY_TO_ROUTE` in `Shell.controller.js`**

After `analytics: "analytics",` add:

```javascript
    analytics: "analytics",
    tutorialEngagement: "tutorialEngagement",
    tutorialCompletions: "tutorialCompletions",
```

(`tutorialSurvey` is an external `href` leaf — it must NOT be added to the route map; `onNavItemSelect` short-circuits on `href`.)

- [ ] **Step 3: Add the two FE titles to `NAV_KEY_TO_TITLE` in `Shell.controller.js`**

After `analytics: "Completion analytics",` add:

```javascript
    analytics: "Completion analytics",
    tutorialEngagement: "Tutorial Engagement",
    tutorialCompletions: "Tutorial Completions",
```

- [ ] **Step 4: Validate JSON + JS**

Run:
```bash
jq -e '[.groups[] | select(.key=="reporting") | .items[].key] | index("tutorialEngagement") != null and (index("tutorialSurvey") != null)' app/admin-shell/webapp/model/navigation.json
node -e "require('./app/admin-shell/webapp/controller/Shell.controller.js')" 2>/dev/null; echo "js-parse-exit=$?"
```
Expected: `true` for the nav check. (The `node -e` require may fail on `sap.ui.define` — acceptable; the goal is a JSON validity check on nav. Instead, verify JS syntax with `npx eslint app/admin-shell/webapp/controller/Shell.controller.js` if eslint is configured, or a `node --check`.)

Better JS syntax check:
Run: `node --check app/admin-shell/webapp/controller/Shell.controller.js`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/admin-shell/webapp/model/navigation.json app/admin-shell/webapp/controller/Shell.controller.js
git commit -m "feat(#2138): add three Reporting-folder leaves + FE route/title maps"
```

---

## Task 11: Vue survey — data access + pure aggregation (`api/survey.ts`)

**Files:**
- Create: `app/analytics-explorer/src/api/survey.ts`
- Test: `app/analytics-explorer/src/api/__tests__/survey.test.ts` (create)

**Interfaces:**
- Consumes: `useAuth().servicePath` (role-aware base), OData entities `AuthorTutorialParents`, `AuthorSurveyDistribution`, `TutorialFeedback`, `TutorialFeedbackAggregate`.
- Produces:
  - `type DistributionRow = { tutorialSlug: string; dimension: string; score: number; responseCount: number }`
  - `type ParentRow = { tutorialSlug: string; tutorialTitle: string; missionTitle: string | null; groupTitle: string | null }`
  - `type CommentRow = { submittedAt: string; tutorialSlug: string; comment: string }`
  - `const SURVEY_DIMENSIONS: readonly string[]` = the 7 keys in display order.
  - `function aggregateDistribution(rows: DistributionRow[]): Record<string, { score: number; count: number; pct: number }[]>` — pure; sums counts per (dimension, score) across the passed rows and computes pct within each dimension. Scores 0–10; buckets present in input only.
  - `async function fetchTutorialParents(): Promise<ParentRow[]>`
  - `async function fetchSurveyDistribution(slugs: string[]): Promise<DistributionRow[]>`
  - `async function fetchSurveyComments(slugs: string[], top?: number): Promise<CommentRow[]>` (newest first)

- [ ] **Step 1: Write the failing test**

Create `app/analytics-explorer/src/api/__tests__/survey.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { aggregateDistribution, SURVEY_DIMENSIONS, type DistributionRow } from '../survey'

describe('aggregateDistribution', () => {
  it('sums response counts per (dimension, score) across slugs and computes pct within a dimension', () => {
    const rows: DistributionRow[] = [
      { tutorialSlug: 'a', dimension: 'structure', score: 8, responseCount: 2 },
      { tutorialSlug: 'b', dimension: 'structure', score: 8, responseCount: 1 },
      { tutorialSlug: 'a', dimension: 'structure', score: 6, responseCount: 1 },
      { tutorialSlug: 'a', dimension: 'nps', score: 10, responseCount: 4 },
    ]
    const agg = aggregateDistribution(rows)
    const structure = agg['structure']
    // score 8 => 2+1 = 3, score 6 => 1 ; total 4
    const s8 = structure.find(b => b.score === 8)!
    const s6 = structure.find(b => b.score === 6)!
    expect(s8.count).toBe(3)
    expect(s6.count).toBe(1)
    expect(s8.pct).toBeCloseTo(75, 5)
    expect(s6.pct).toBeCloseTo(25, 5)
    // nps independent dimension
    expect(agg['nps'][0].count).toBe(4)
    expect(agg['nps'][0].pct).toBeCloseTo(100, 5)
  })

  it('exposes the 7 survey dimensions in display order', () => {
    expect(SURVEY_DIMENSIONS).toEqual([
      'structure', 'interesting', 'useCase', 'relevance', 'duration', 'visuals', 'nps'
    ])
  })

  it('returns an empty object for no rows', () => {
    expect(aggregateDistribution([])).toEqual({})
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit app/analytics-explorer/src/api/__tests__/survey.test.ts`
Expected: FAIL — module `../survey` not found.

- [ ] **Step 3: Create `app/analytics-explorer/src/api/survey.ts`**

```ts
import { useAuth } from '../composables/useAuth'

export interface DistributionRow {
  tutorialSlug: string
  dimension: string
  score: number
  responseCount: number
}

export interface ParentRow {
  tutorialSlug: string
  tutorialTitle: string
  missionTitle: string | null
  groupTitle: string | null
}

export interface CommentRow {
  submittedAt: string
  tutorialSlug: string
  comment: string
}

// Display order for the 7 histograms (6 ratings + NPS).
export const SURVEY_DIMENSIONS = [
  'structure', 'interesting', 'useCase', 'relevance', 'duration', 'visuals', 'nps'
] as const

export interface DistributionBucket { score: number; count: number; pct: number }

// Pure: sum counts per (dimension, score) across all passed rows, then compute
// pct within each dimension. No network — unit-testable in isolation.
export function aggregateDistribution(
  rows: DistributionRow[]
): Record<string, DistributionBucket[]> {
  const byDim: Record<string, Map<number, number>> = {}
  for (const r of rows) {
    if (!byDim[r.dimension]) byDim[r.dimension] = new Map()
    const m = byDim[r.dimension]
    m.set(r.score, (m.get(r.score) ?? 0) + r.responseCount)
  }
  const out: Record<string, DistributionBucket[]> = {}
  for (const [dim, m] of Object.entries(byDim)) {
    const total = [...m.values()].reduce((a, b) => a + b, 0)
    out[dim] = [...m.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([score, count]) => ({ score, count, pct: total ? (count * 100) / total : 0 }))
  }
  return out
}

function odataInFilter(field: string, values: string[]): string {
  // Builds "field eq 'a' or field eq 'b'" (slugs are lowercase canonical, no quotes inside).
  return values.map(v => `${field} eq '${v.replace(/'/g, "''")}'`).join(' or ')
}

async function readValue<T>(path: string): Promise<T[]> {
  const r = await fetch(path, { headers: { Accept: 'application/json' } })
  if (!r.ok) throw new Error(`OData ${r.status} for ${path}`)
  const json = await r.json()
  return (json.value ?? []) as T[]
}

export async function fetchTutorialParents(): Promise<ParentRow[]> {
  const { servicePath } = useAuth()
  const url = `${servicePath.value}AuthorTutorialParents`
    + `?$select=tutorialSlug,tutorialTitle,missionTitle,groupTitle&$top=5000`
  return readValue<ParentRow>(url)
}

export async function fetchSurveyDistribution(slugs: string[]): Promise<DistributionRow[]> {
  if (slugs.length === 0) return []
  const { servicePath } = useAuth()
  const filter = encodeURIComponent(odataInFilter('tutorialSlug', slugs))
  const url = `${servicePath.value}AuthorSurveyDistribution`
    + `?$select=tutorialSlug,dimension,score,responseCount&$filter=${filter}&$top=5000`
  return readValue<DistributionRow>(url)
}

export async function fetchSurveyComments(slugs: string[], top = 200): Promise<CommentRow[]> {
  if (slugs.length === 0) return []
  const { servicePath } = useAuth()
  const filter = encodeURIComponent(`(${odataInFilter('tutorialSlug', slugs)}) and comment ne null`)
  const url = `${servicePath.value}TutorialFeedback`
    + `?$select=submittedAt,tutorialSlug,comment&$filter=${filter}`
    + `&$orderby=submittedAt desc&$top=${top}`
  return readValue<CommentRow>(url)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit app/analytics-explorer/src/api/__tests__/survey.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/src/api/survey.ts app/analytics-explorer/src/api/__tests__/survey.test.ts
git commit -m "feat(#2138): survey data access + pure distribution aggregation"
```

---

## Task 12: Vue survey — `SurveyReport.vue` + route + shell nav link

**Files:**
- Create: `app/analytics-explorer/src/views/SurveyReport.vue`
- Modify: `app/analytics-explorer/src/router.ts`
- Modify: `app/analytics-explorer/src/App.vue`
- Test: `app/analytics-explorer/src/views/__tests__/SurveyReport.test.ts` (create)

**Interfaces:**
- Consumes: `api/survey.ts` (Task 11), `ChartRenderer` (`chartType`/`data: {columns, data}`/`dimensions`/`measures`), `useChartTheme`'s `installChartTheme()`, `TutorialFeedbackAggregate` for the NPS summary.
- Produces: route `{ path: '/reports/survey', component: SurveyReport }` (URL `/analytics-ui/#/reports/survey`).

- [ ] **Step 1: Write the failing component test**

Create `app/analytics-explorer/src/views/__tests__/SurveyReport.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// Stub the API layer so the component test does no network.
vi.mock('../../api/survey', () => ({
  SURVEY_DIMENSIONS: ['structure', 'interesting', 'useCase', 'relevance', 'duration', 'visuals', 'nps'],
  aggregateDistribution: (rows: any[]) => {
    const out: Record<string, any[]> = {}
    for (const r of rows) (out[r.dimension] ||= []).push({ score: r.score, count: r.responseCount, pct: 100 })
    return out
  },
  fetchTutorialParents: vi.fn().mockResolvedValue([
    { tutorialSlug: 'a', tutorialTitle: 'Tut A', missionTitle: 'Mission 1', groupTitle: 'Group 1' }
  ]),
  fetchSurveyDistribution: vi.fn().mockResolvedValue([
    { tutorialSlug: 'a', dimension: 'structure', score: 8, responseCount: 2 }
  ]),
  fetchSurveyComments: vi.fn().mockResolvedValue([
    { submittedAt: '2026-02-01T00:00:00Z', tutorialSlug: 'a', comment: 'Nice tutorial' }
  ]),
}))

// Stub ChartRenderer (ECharts needs a real canvas; we only assert wiring).
vi.mock('../../components/ChartRenderer.vue', () => ({
  default: { name: 'ChartRenderer', props: ['chartType', 'data', 'dimensions', 'measures'], template: '<div class="chart-stub" />' }
}))
vi.mock('../../composables/useChartTheme', () => ({ installChartTheme: vi.fn() }))
vi.mock('../../composables/useAuth', () => ({
  useAuth: () => ({ servicePath: { value: '/author/' }, userRole: { value: 'author' } })
}))

import SurveyReport from '../SurveyReport.vue'

describe('SurveyReport', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders one chart per survey dimension after loading parents + distribution', async () => {
    const w = mount(SurveyReport)
    await flushPromises()
    // 7 dimensions => 7 ChartRenderer stubs
    expect(w.findAll('.chart-stub').length).toBe(7)
  })

  it('renders the comments returned by the API', async () => {
    const w = mount(SurveyReport)
    await flushPromises()
    expect(w.text()).toContain('Nice tutorial')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit app/analytics-explorer/src/views/__tests__/SurveyReport.test.ts`
Expected: FAIL — `../SurveyReport.vue` does not exist.

- [ ] **Step 3: Create `app/analytics-explorer/src/views/SurveyReport.vue`**

```vue
<script setup lang="ts">
import '@ui5/webcomponents/dist/Select.js'
import '@ui5/webcomponents/dist/Option.js'
import '@ui5/webcomponents/dist/Table.js'
import '@ui5/webcomponents/dist/Title.js'
import { ref, computed, onMounted, watch } from 'vue'
import ChartRenderer from '../components/ChartRenderer.vue'
import { installChartTheme } from '../composables/useChartTheme'
import {
  SURVEY_DIMENSIONS, aggregateDistribution,
  fetchTutorialParents, fetchSurveyDistribution, fetchSurveyComments,
  type ParentRow, type CommentRow
} from '../api/survey'

const DIMENSION_LABELS: Record<string, string> = {
  structure: 'Well structured',
  interesting: 'Interesting',
  useCase: 'Helpful for my use case',
  relevance: 'Relevant to my work',
  duration: 'Right length',
  visuals: 'Good visuals & code samples',
  nps: 'Likely to recommend (NPS)',
}

const parents = ref<ParentRow[]>([])
const comments = ref<CommentRow[]>([])
const distByDim = ref<Record<string, { score: number; count: number; pct: number }[]>>({})

const selMission = ref<string>('')
const selGroup = ref<string>('')
const selTutorial = ref<string>('')

const missions = computed(() =>
  [...new Set(parents.value.map(p => p.missionTitle).filter(Boolean) as string[])].sort())
const groups = computed(() =>
  [...new Set(parents.value.map(p => p.groupTitle).filter(Boolean) as string[])].sort())
const tutorials = computed(() =>
  [...new Set(parents.value.map(p => p.tutorialTitle).filter(Boolean))].sort())

// The slug set the current filter resolves to (independent filters; the data
// itself narrows results — see spec §8, no cascading value-help in v1).
const selectedSlugs = computed(() => {
  const rows = parents.value.filter(p =>
    (!selMission.value || p.missionTitle === selMission.value) &&
    (!selGroup.value || p.groupTitle === selGroup.value) &&
    (!selTutorial.value || p.tutorialTitle === selTutorial.value))
  return [...new Set(rows.map(r => r.tutorialSlug))]
})

function chartData(dim: string) {
  const buckets = distByDim.value[dim] ?? []
  return {
    columns: ['score', 'pct'],
    data: buckets.map(b => [String(b.score), Number(b.pct.toFixed(1))]) as (string | number)[][],
  }
}

async function reload() {
  const slugs = selectedSlugs.value
  const [dist, cmts] = await Promise.all([
    fetchSurveyDistribution(slugs),
    fetchSurveyComments(slugs),
  ])
  distByDim.value = aggregateDistribution(dist)
  comments.value = cmts
}

onMounted(async () => {
  installChartTheme()
  parents.value = await fetchTutorialParents()
  await reload()
})

watch([selMission, selGroup, selTutorial], reload)

function onSel(target: 'mission' | 'group' | 'tutorial', e: any) {
  const v = e.detail?.selectedOption?.dataset?.value ?? ''
  if (target === 'mission') selMission.value = v
  else if (target === 'group') selGroup.value = v
  else selTutorial.value = v
}
</script>

<template>
  <div class="survey-report">
    <ui5-title level="H3">Tutorial Survey</ui5-title>

    <div class="filter-bar">
      <ui5-select @change="(e:any)=>onSel('mission', e)">
        <ui5-option :data-value="''" selected>All missions</ui5-option>
        <ui5-option v-for="m in missions" :key="m" :data-value="m">{{ m }}</ui5-option>
      </ui5-select>
      <ui5-select @change="(e:any)=>onSel('group', e)">
        <ui5-option :data-value="''" selected>All groups</ui5-option>
        <ui5-option v-for="g in groups" :key="g" :data-value="g">{{ g }}</ui5-option>
      </ui5-select>
      <ui5-select @change="(e:any)=>onSel('tutorial', e)">
        <ui5-option :data-value="''" selected>All tutorials</ui5-option>
        <ui5-option v-for="t in tutorials" :key="t" :data-value="t">{{ t }}</ui5-option>
      </ui5-select>
    </div>

    <div class="chart-grid">
      <div v-for="dim in SURVEY_DIMENSIONS" :key="dim" class="chart-cell">
        <div class="chart-title">{{ DIMENSION_LABELS[dim] }}</div>
        <ChartRenderer
          chart-type="bar"
          :data="chartData(dim)"
          :dimensions="['score']"
          :measures="['pct']"
        />
      </div>
    </div>

    <ui5-title level="H4">Comments</ui5-title>
    <table class="comments">
      <thead><tr><th>Submitted</th><th>Tutorial</th><th>Comment</th></tr></thead>
      <tbody>
        <tr v-for="(c, i) in comments" :key="i">
          <td>{{ new Date(c.submittedAt).toLocaleDateString() }}</td>
          <td>{{ c.tutorialSlug }}</td>
          <td>{{ c.comment }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.survey-report { padding: 1rem; display: flex; flex-direction: column; gap: 1rem; height: 100%; overflow: auto; }
.filter-bar { display: flex; gap: 0.75rem; flex-wrap: wrap; }
.chart-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 1rem; }
.chart-cell { border: 1px solid var(--sapList_BorderColor, #ddd); border-radius: 6px; padding: 0.5rem; min-height: 340px; }
.chart-title { font-weight: 600; margin-bottom: 0.25rem; }
.comments { width: 100%; border-collapse: collapse; }
.comments th, .comments td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--sapList_BorderColor, #eee); vertical-align: top; }
</style>
```

- [ ] **Step 4: Add the route in `app/analytics-explorer/src/router.ts`**

```ts
import { createRouter, createWebHashHistory } from 'vue-router'
import Analytics from './views/Analytics.vue'
import SurveyReport from './views/SurveyReport.vue'

export const router = createRouter({
  history: createWebHashHistory('/analytics-ui/'),
  routes: [
    { path: '/', component: Analytics },
    { path: '/reports/survey', component: SurveyReport },
  ],
})
```

- [ ] **Step 5: Add a shellbar nav item in `app/analytics-explorer/src/App.vue`**

Add a `<ui5-shellbar-item>` (icon `feedback`, text "Survey") to the existing `<ui5-shellbar>` and route on click. In the `<script setup>`, import the router and add:

```ts
import { useRouter } from 'vue-router'
const router = useRouter()
function goSurvey() { router.push('/reports/survey') }
function goHome() { router.push('/') }
```

In the `<ui5-shellbar>` template, add:

```html
      <ui5-shellbar-item icon="business-objects-experience" text="Explorer" @click="goHome" />
      <ui5-shellbar-item icon="feedback" text="Survey" @click="goSurvey" />
```

(Import `@ui5/webcomponents-fiori/dist/ShellBarItem.js` at the top of `App.vue` if not already imported — grep first: `rg "ShellBarItem" app/analytics-explorer/src/App.vue`.)

- [ ] **Step 6: Run the component test + typecheck**

Run: `npx vitest run --project unit app/analytics-explorer/src/views/__tests__/SurveyReport.test.ts`
Expected: PASS (2 tests).
Run: `npm --prefix app/analytics-explorer run build` (or `npx vue-tsc --noEmit -p app/analytics-explorer`) to confirm the app still type-checks and builds.
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add app/analytics-explorer/src/views/SurveyReport.vue \
        app/analytics-explorer/src/views/__tests__/SurveyReport.test.ts \
        app/analytics-explorer/src/router.ts app/analytics-explorer/src/App.vue
git commit -m "feat(#2138): Tutorial Survey Vue report (7 histograms + comments)"
```

---

## Task 13: Full-suite verification + final commit

**Files:** none (verification only).

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: all pass (including the new `author-reporting-views`, `author-reporting-service`, `survey`, `SurveyReport` suites). Investigate and fix any regression before proceeding.

- [ ] **Step 2: Deploy-compile the full model to SQLite**

Run: `npx cds deploy --to sqlite::memory:`
Expected: no errors.

- [ ] **Step 3: Regenerate the shell manifest once more (idempotency check)**

Run: `npm --prefix app/admin-shell run generate-manifest && git diff --stat app/admin-shell/webapp/manifest.json`
Expected: no further changes (the committed manifest already matches the generator output).

- [ ] **Step 4: Confirm the postbuild guards that touch admin/srv-qa are unaffected**

Run: `npx tsx scripts/check-srv-qa-cp-list.ts` (only relevant if any `srv/lib/` file changed — none did here, so this should pass trivially). Also run `npx tsx scripts/check-public-endpoints.ts` to confirm the new `@requires`-scoped entities did not trip the public-endpoint guard.
Expected: pass.

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "chore(#2138): verification fixes for standard reports"
```

- [ ] **Step 6: Open the PR (targets DEV)**

```bash
git push -u origin feat/2138-reporting
gh pr create --base DEV --title "feat: standard reports in Admin UI Reporting folder (#2138)" \
  --body "Implements #2138 — Tutorial Engagement (FE ALP), Tutorial Completions (FE List Report), and Tutorial Survey (Vue) under the Reporting folder. See docs/superpowers/specs/2026-09-04-2138-standard-reports-design.md."
```

---

## Notes for the executor

- **Fan-out is by design** (Tasks 2–3). The engagement/completions rows multiply across mission/group parents so the cascade filter works; the synthetic `reportKey` keeps OData keys unique. Never present a total summed across parents without DISTINCT.
- **Report A has no date slicer** — deliberate (distinct counts don't compose with a date range). Date lives on Report B (`completionDay`) and Report C (client-side on `submittedAt`, a follow-up enhancement — v1 filters by mission/group/tutorial).
- **HANA parity (Task 5 Step 6)** is the one step that needs `cf login`; if unavailable in the execution environment, flag it as a required pre-merge manual check rather than skipping silently.
- **Survey view fallback (Task 4 Step 4)** — if the union-keyed view won't compile, switch Report C to client-side bucketing over raw `TutorialFeedback` rows and drop the `AuthorSurveyDistribution` projections.
