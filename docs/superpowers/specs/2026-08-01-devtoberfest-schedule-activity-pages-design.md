# Devtoberfest Schedule & Activity Pages — Design

**Date:** 2026-08-01
**Status:** Approved (design); pending implementation plan
**Author:** Tom + Claude
**Repo:** `sap-tutorials/tutorials-ims` (local `tutorials-poc`)

## Problem

Past Devtoberfest years published the weekly **schedule** (educational sessions) and the
**activity list** (point-earning validation tutorials/puzzles) as hand-written SAP Community
blog posts (e.g. [Week 4, 2025](https://community.sap.com/t5/devtoberfest-blog-posts/devtoberfest-2025-what-is-happening-week-4/ba-p/14245705)),
plus a separate community **events page** with list + calendar views. This is manual and
goes stale. We already own the underlying data. This feature makes it **dynamic**, drawn
directly from the Devtoberfest data model, on developers.sap.com.

## Goals

- One unified, filterable/sortable **table** listing both educational **sessions** and
  **activities**.
- A **sessions grid** (cards, timed events) with YouTube thumbnails and links.
- A **sessions calendar** (week × weekday) for the timed sessions.
- For logged-in users: show **completed vs not-completed** and **earned points** (activity
  points), consistent with the gameboard score.
- Cover the **active edition** by default with the ability to browse **past editions**.

## Non-goals (YAGNI)

- No session attendance/watch tracking (no data model exists for it; completion is derived
  from the linked Activity's Task).
- No editing/admin here — session/activity authoring stays in the `devtoberfest-planner`.
- No new points model — points are owned by the planner (`Activity.points`).
- No ICS/calendar export in v1.

## Background: where the data lives (research findings)

The authoritative schedule/activity data is owned by the **`devtoberfest-planner`** project
and published as cross-container HANA views. The **gameboard scoring backend** is a separate
future app (`sap-community-gameboard`); this feature does **not** depend on it — it reads the
same source views and the local `TaskRecords`.

| Concern | Entity / View | Owner | Key fields |
|---|---|---|---|
| Educational session | `Session` / `DTF_SESSION_V1` | planner | `sessionCode`, `track`, `title`, `abstract`, `status`, `sessionLength`, `week` (enum '1'–'4'…), `scheduledDate`, `scheduledTime`, `youtubeURL`, `communityEventURL`, `speakers`, `activity` (0..1) |
| Point-earning activity | `Activity` / `DTF_ACTIVITY_V1` | planner | `title`, `track`, `status`, `week`, `points`, `task`→Tutorial/Puzzle, `taskType`, `taskSlug`, `taskTitle`, `sessions` |
| Underlying task | `Tutorials` / `Puzzles` (via `TASK_VALUE_HELP_V1`) | tutorials-ims | slug, title, taskType |
| Completions | `TaskRecords` | tutorials-ims | `user`, `taskLegacyId`, `taskType`, `status`, `completionDate` |
| Edition (cycle) | `Edition` | planner | `year`, `name`, `startDate`, `endDate`, `isCurrent` |
| Active-event/config | `DevtoberfestConfig`, `Events` | tutorials-ims | `isActive`, `currentEvent`, `edition` |

**Session → Activity → Task chain:** `Session.activity` → `Activity` (points, week) →
`Activity.task` → `TASK_VALUE_HELP_V1` → Tutorial | Puzzle (discriminated by `taskType`).

**Known gaps this feature must close (confirmed during research):**

1. The tutorials-poc `Session` proxy in `db/external/devtoberfest.cds` is **stale** — it still
   carries the pre-refactor `TUTORIALSLUG/TUTORIALTITLE/TUTORIAL_ID` columns, lacks
   `ACTIVITY_ID`, and there is **no `Activity` facade at all**. It must be refreshed to match
   the deployed `DTF_SESSION_V1` / `DTF_ACTIVITY_V1` contracts.
2. `DevtoberfestService` is `@requires:'authenticated-user'` and its `@path:'/devtoberfest'`
   OData service is **not routed** through the approuter. A **public** read surface is needed.

### Decisions (from brainstorming)

- **Data source:** live from planner views (refresh proxies + public projection). *Not* a
  local snapshot/cache, *not* build-time static JSON.
- **Pages:** three separate pages/routes — unified table, sessions grid, sessions calendar.
- **Calendar layout:** week × weekday grid, **derived entirely from data** (weeks and weekdays
  present in the session set) — Devtoberfest is 4 weeks this year but has varied and has had
  **non-contiguous** weeks; no hardcoded week count or weekday span.
- **Completion:** derived via the linked **Activity/Task** completion (a session is "complete"
  when its Activity's Task is complete). No independent session-attendance state.
- **Points:** per-item points **plus** a logged-in "your earned points" total (Σ points of
  completed activities) and max available.
- **Edition scope:** active edition by default; past editions selectable.
- **Row detail:** click-to-open **detail panel** (side drawer), not hover tooltip (touch-safe).

## Architecture

Built in **tutorials-poc** as Vue 3 islands + Hugo pages, following the existing
`hugo/layouts/devtoberfest/*` + `hugo-apps/src/{gameboard,arcade,selfie,devtoberfest}` island
pattern. Islands are bundled by Vite (`hugo-apps/vite.config.ts` `rollupOptions.input`) into
`hugo/static/js/<island>.js`, served same-origin by the approuter.

### Backend (CAP) — plumbing first

1. **Refresh cross-container proxies** (`db/external/devtoberfest.cds`):
   - Fix the `Session` facade to match current `DTF_SESSION_V1` (remove `TUTORIAL_*`, add
     `ACTIVITY_ID` + `edition` key).
   - Add a new **`Activity` facade** over `DTF_ACTIVITY_V1` (`POINTS`, `WEEK`, `TASKTYPE`,
     `TASKSLUG`, `TASKTITLE`, `TASK_ID`, `TRACK_ID`, `STATUS`, sessions link).
   - Facade element casing UPPERCASE-safe for underscore columns (cross-container gotcha:
     `USER_ID` not `userId`).
   - Requires same HANA-instance cross-container wiring (grants/synonyms/`.hdiconfig`) already
     present for the existing proxy; verify against the deployed views.

2. **Public read surface** — a public projection/feed (either an unauthenticated projection on
   a public service or an Express route mirroring `srv/routes/devtoberfest-public.js`) exposing,
   for a given `edition` (default = active):
   - sessions (with track, week, schedule, youtube/community links, linked activity id),
   - activities (with points, week, taskType, taskSlug, linked task),
   - the list of selectable editions.
   `authenticationType: none`. Read-only.

3. **My-completions endpoint** (authenticated, self-scoped) — reuse existing
   `getMyCompletions()` / slug-resolution to return the set of completed task **slugs** (and
   completion dates) for the edition window. The island merges by slug and sums points.

4. **Approuter (`approuter/xs-app.json`)**:
   - Public route for the feed **before** the catch-all.
   - `xsuaa` route (with `forwardAuthToken: true` destination) for the completions endpoint.
   - Update `test/unit/check-public-endpoints.test.ts` / `scripts/check-public-endpoints.ts`
     so the new public endpoint has a matching anonymous route and isn't shadowed.

### Frontend — three pages / islands

Shared `hugo-apps/src/devtoberfest-schedule-shared/` module: feed fetch (`{value:[]}` envelope
unwrap), edition picker, completion-merge + points-total helper, detail-panel component, types.
Auth detection via `document.documentElement.dataset.authenticated` / the `auth-resolved`
event dispatched by `header.html`.

**Shared UI on all three pages:** edition picker (defaults to active); logged-in
completion/points banner (earned / max / count complete); click-to-open **detail panel** with
the underlying item's abstract, speakers, track, week, date/time, taskType, points, and all
links; anonymous "Sign in to track your progress" prompt.

**Page 1 — Unified Schedule table** — route `/devtoberfest/schedule/`, island
`devtoberfest-schedule`. One themed HTML `<table>` (the `hugo-apps/src/me/AllCompletions.vue`
pattern). Rows = sessions **and** activities, distinguished by a `Type` column. Columns:
Type · Title · Track · Week · Day/Date·Time · Points · Links · Status (✓ when complete;
logged-in only). Filters: week, type, track + free-text; sortable headers; filter state synced
to URL hash (`advocates/composables/urlSync.ts` pattern). Session rows link to their Activity;
activity rows link to their Task. Row click → detail panel.

**Page 2 — Sessions Grid** — route `/devtoberfest/sessions/`, island
`devtoberfest-sessions-grid`. Sessions only, as cards (reusing `EventsBand.vue` card + format
chips). Card: **YouTube thumbnail** derived from `youtubeURL`
(`https://img.youtube.com/vi/<id>/hqdefault.jpg`, graceful placeholder when absent/invalid),
title, track badge, speakers, date/time, links (YouTube + community event + linked activity),
completion tick. Same week/track/type filters + edition picker. Card click → detail panel.

**Page 3 — Sessions Calendar** — route `/devtoberfest/calendar/`, island
`devtoberfest-sessions-calendar`. **Week × weekday grid, derived from data:** rows = distinct
`week` values present in the session set (sorted; empty weeks omitted), columns = the weekdays
that actually have sessions (derived from `scheduledDate`; supports weekend sessions and
non-contiguous weeks). Each cell = that day's session cards (compact: thumbnail, title, time,
completion tick). Cell card click → detail panel. Same edition picker + filters. **No
hardcoded week count or weekday span.**

### Data flow

Island load → fetch public feed (`?edition=` default active) → if authenticated, fetch
my-completions → merge by slug → render. Earned points = Σ `Activity.points` where the linked
task slug ∈ my completed set (case-insensitive, counted once per activity — matches gameboard
`computeScore`).

## Error handling & edge cases

- **Anonymous:** schedule always renders (public feed); completion column + points banner
  hidden, replaced by a sign-in prompt. Completions fetch fails **soft** to "not logged in" —
  no 401 surfaced on the read path.
- Missing/invalid `youtubeURL` → placeholder thumbnail, no broken image.
- Session with no linked Activity → renders; no points, no task link.
- Activity whose task is retired/unpublished → shows title/points; task link disabled.
- Empty edition → friendly `ui5-illustrated-message` empty state.
- Feed / cross-container error → per-island error state with retry; never a blank screen.
- `<noscript>` fallback in each Hugo layout.

## Testing

- **Backend unit:** public feed shape + edition filter + anonymous access; completions
  endpoint self-scoped (IDOR-safe); refreshed-proxy shape.
- **Backend hybrid:** proxies actually read the deployed `DTF_SESSION_V1` / `DTF_ACTIVITY_V1`
  (guards cross-container UPPERCASE/facade gotchas); requires `cds bind` + cf login.
- **Public-endpoint guard:** update `check-public-endpoints` test for the new anonymous route.
- **Island unit (Vitest):** filter/sort, completion merge, points total, empty/error/anonymous
  states, calendar derivation from **non-contiguous weeks + weekend sessions**, thumbnail
  fallback.
- **e2e (committed `test/e2e/` Playwright spec):** three pages against deployed DEV, anonymous
  and logged-in — per the project's e2e-coverage rule for `hugo-apps/**` changes.

## Open questions / risks

- **Cross-container instance:** the refreshed proxies only work if the planner and tutorials-ims
  HDI containers are in the **same HANA Cloud instance** (verify hosts via cf service keys, not
  `cds bind`). If not co-located, the "live from planner views" decision needs revisiting.
- **Edition key propagation:** `DTF_SESSION_V1` / `DTF_ACTIVITY_V1` must carry (or be joinable
  to) an edition identifier for the past-edition archive; confirm the published views expose it,
  else the planner views need a small addition.
- **Completion window for past editions:** "completed" for a past edition should reflect
  completions within that edition's date window (consistent with gameboard date-window scoring).
