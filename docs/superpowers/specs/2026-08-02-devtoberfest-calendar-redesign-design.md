# Devtoberfest Calendar Redesign — Design

**Date:** 2026-08-02
**Status:** Approved (design), pending spec review
**Author:** Tom (with Claude Code)
**Issue/PR:** TBD (feature branch `worktree-devtoberfest-calendar-redesign`)

## Problem

The page at `/devtoberfest/calendar/` is functional but does not read as a
calendar. It renders a **pivot table**: rows are abstract "Week 1 / Week 2 /
Week 3" numbers, columns are only the weekdays that happen to have data, and
cells hold session cards. There are no real dates, no full-week structure, and
no month context. Tom wants an **Outlook-style calendar**: a month grid where
you can see days at a glance, plus the ability to drill into a single day and a
single week.

## Goals

- A real, date-driven **Month** grid (Outlook month view) as the default.
- A **Week** view and a **Day** view, reachable via a view switcher.
- Colour-code sessions by **track** (Outlook-category style) and keep the
  existing track filter.
- Reuse all existing infrastructure (feed, completion merge, detail drawer,
  edition picker, points banner, YouTube thumbnails, SAP Horizon theming).

## Non-Goals

- No hourly time-grid layout (Week/Day use agenda columns — sessions are sparse,
  so an hourly grid would be mostly empty whitespace).
- No third-party calendar library (bundle weight + theming friction not worth it
  for read-only, sparse data).
- No backend/feed/route/schema changes. No new Hugo layout or route.
- No drag/drop, resize, or event editing (data is read-only).

## Chosen Approach

**Rewrite the existing Vue island in place** — hand-built date core, no library.
The feed already carries real `scheduledDate` (`YYYY-MM-DD`) and `scheduledTime`
values, so a genuine calendar is straightforward. Rejected alternatives:

- **Calendar library (FullCalendar / vue-cal / @schedule-x):** significant bundle
  weight in a Hugo island; fighting library CSS to match Horizon + track colours
  + YouTube-thumb cards; its event-overlap engine buys nothing for sparse
  read-only data.
- **Incrementally improve the current table:** cannot deliver a month grid or
  Day/Week views — fails the core ask.

## Architecture & Scope

Rewrite the contents of `hugo-apps/src/devtoberfest-sessions-calendar/`. **No
changes** to:

- The Hugo layout `hugo/layouts/devtoberfest/calendar.html` (thin mount shell).
- The approuter route or `approuter/xs-app.json`.
- The feed `GET /api/devtoberfest/schedule?edition=<id>` or any backend code.
- The Vite input key `devtoberfest-sessions-calendar` / compiled-bundle wiring.

**Reused as-is** from `hugo-apps/src/devtoberfest-schedule-shared/`:
`feed.ts` (loader), `completion.ts` (merge), `DetailPanel.vue` (click-to-open
drawer), `EditionPicker.vue`, `PointsBanner.vue`, `youtube.ts` (thumbnails),
`types.ts`, `useAuth.ts`, and the SAP Horizon CSS custom properties already used
for theming.

## Components & Files

### New / replaced

- **`calendar-core.ts`** (replaces `calendar-grid.ts`) — pure, unit-tested date
  functions, no Vue import:
  - `startOfMonthGrid(date): Date[]` — 42-cell (6×7) Monday-first matrix
    covering the month plus leading/trailing days from adjacent months.
  - `startOfWeek(date): Date` — Monday of the week containing `date`.
  - `weekDays(date): Date[]` — the 7 dates Mon→Sun for that week.
  - `groupByDate(sessions): Map<string, Session[]>` — keyed by `YYYY-MM-DD`,
    each list sorted by `scheduledTime` ascending, nulls last.
  - `iso(date): string` — `YYYY-MM-DD` formatted in **UTC** (matches the feed's
    `scheduledDate` and the current code's UTC date parsing — avoids TZ drift).
  - `addMonths / addWeeks / addDays(date, n): Date` — navigation helpers (UTC).
- **`track-colors.ts`** (new) — deterministic track→colour map. Distinct track
  names sorted alphabetically, each assigned from a fixed Horizon-derived palette
  (chip background + left-border colour); stable modulo fallback for overflow
  beyond the palette length. Exposes `colorFor(trackName): {bg, border}` and a
  `legend()` list of `{trackName, color}`. Assignment is over the **full** track
  set from the feed, so a track keeps its colour when the filter hides others.
- **`MonthGrid.vue`** — presentational month grid. Props: 42 cells, grouped
  sessions, colour map, cursor month, today. Renders up to **3** chips per day
  (time + title, track-coloured) then **"+N more"**. Greys adjacent-month days;
  highlights today. Emits `select(session)` and `openDay(date)`.
- **`WeekAgenda.vue`** — 7 day columns (Mon→Sun). Each column is an agenda list
  of that day's sessions as compact track-coloured cards, sorted by time; empty
  days show "—". Highlights today's column. Emits `select(session)`.
- **`DayAgenda.vue`** — single wide agenda column for one date, using the larger
  YouTube-thumbnail session cards (time, title, track). Emits `select(session)`.
- **`App.vue`** — rewritten controller. State: `viewMode` (`'month' | 'week' |
  'day'`), `cursor: Date`, plus existing `editionId` and `trackFilter`. Renders
  the toolbar (‹ › nav, title, **Today**, track `<select>`, Month/Week/Day
  switcher, `EditionPicker`, `PointsBanner`) and one of the three view
  subcomponents. Owns `DetailPanel` open state.

### Tests (Vitest, existing `hugo-apps` harness)

- Replace `__tests__/calendar-grid.test.ts` with **`calendar-core.test.ts`**:
  month-matrix boundaries (months starting Sunday vs Monday; 28/30/31-day
  months; December→January year wrap), week edges, UTC grouping correctness,
  time-sort with missing `scheduledTime`.
- New **`track-colors.test.ts`**: deterministic assignment, stability when the
  track set is filtered, overflow fallback.
- Component smoke: mount `App.vue` with a fixture feed — assert Month renders 42
  cells, a known busy day shows "+N more", and the view switcher swaps the
  rendered subcomponent.

## Behavior & Data Flow

1. **On mount:** `loadData()` (unchanged) fetches feed + completions in parallel,
   merges the `complete` flag, and keeps `rows.filter(r => r.kind ===
   'session')`. Then set `cursor` to the **first day of the month containing the
   active edition's `startDate`**. Fallbacks in order: earliest session
   `scheduledDate`; then today.
2. **Default view:** Month.
3. **Track filter:** the existing `<select>` (options = distinct `trackName`s).
   Filtering recomputes the grouped map passed to the active view. Colours are
   assigned from the full track set so they stay stable under filtering.
4. **Navigation:** ‹ › steps by month / week / day according to `viewMode`
   (`addMonths/addWeeks/addDays`). **Today** sets `cursor` to today. Switching
   views preserves `cursor` (Month→Week shows the week containing the cursor;
   →Day shows the cursor's day).
5. **Month cell interactions:** clicking a chip opens `DetailPanel` for that
   session; clicking **"+N more"** or the day number switches to **Day** view for
   that date.
6. **Week / Day:** both reuse `DetailPanel` on card click and render the ✓
   complete state (authenticated users) exactly as today.
7. **Empty edition / feed 503:** preserve current fail-soft behaviour — render
   the empty calendar shell with a "no sessions" message; never crash. Sessions
   lacking a `scheduledDate` fall into a clearly labelled "unscheduled" bucket
   rather than silently vanishing.

## Error Handling & Testing

- The pure core is fully unit-tested (see Tests above) — this is where the date
  math risk lives, so it carries the coverage.
- Fail-soft is preserved end to end: loader errors and empty feeds render an
  empty themed calendar, not a stack trace.
- **Manual verification (Tom's #1 rule):** after deploy, load
  `/devtoberfest/calendar/` **through the approuter in a real browser**
  (Playwright with Tom's session) and exercise: all three views, the track
  filter, ‹ › nav, Today, chip→DetailPanel, and "+N more"→Day. Not curl / unit
  tests alone.

## Rollout

- Frontend-only change to a Hugo Vue island. Ships via the normal
  `npm run build:all` → `mbt build` → `cf deploy` path (island bundle is rebuilt
  by Vite during the Hugo build and copied into the approuter). No DB deploy, no
  content rebuild.
- Behind no feature flag — it's a straight replacement of the existing calendar
  island. DEV first, verify, then follows the normal PROD path.

## Open Questions

None outstanding — all design questions resolved during brainstorming
(three views, month-of-event default, colour-code-by-track + filter, 3-chips +
"+N more" month density, agenda-column Week/Day).
