# Devtoberfest Confirmed/Completed Status Filter — Design

**Date:** 2026-08-04
**Status:** Approved (design); pending implementation plan
**Author:** Tom + Claude
**Repo:** `sap-tutorials/tutorials-ims` (local `tutorials-poc`)

## Problem

The public Devtoberfest pages must only surface sessions and activities that an
organizer has advanced to a **Confirmed** or **Completed** state in the
Devtoberfest Planner. Today they surface **every** row regardless of planner
status — including `Draft` (the planner default), `Invited`, `Declined`,
`Cancelled`, and `PendingTutorial`. The `STATUS` column is carried through the
feed but never used as a filter predicate anywhere in this repo.

Verified 2026-08-04 across all five Devtoberfest pages:

- **Schedule, Sessions grid, Calendar** — all fed by a single backend feed
  (`GET /api/devtoberfest/schedule` in `srv/routes/devtoberfest-schedule.js`),
  which reads the cross-container planner facades `external.devtoberfest.Session`
  / `.Activity` filtered **only by `TRACK_ID`**. The pure assembler
  `srv/lib/devtoberfest-feed.js` copies `STATUS` straight through. The Vue
  islands filter client-side only by week/track. No status filter exists.
- **Arcade, Leaderboard** — **out of scope.** These are client-side islands that
  fetch from the external `/gameboard/*` backend (separately-deployed
  `sap-community-gameboard`, proxied via `xs-app.json` → `gameboard-api`
  destination). Their status handling lives in that other repo and cannot be
  changed here.

## Decision

Filter **consumer-side** (in this repo), not provider-side (planner views), for
flexibility — we can adjust the visible-status set without a planner-repo change
or cross-container redeploy.

## Status vocabulary (authoritative)

From the planner repo `D:\projects\devtoberfest-planner\db\schema.cds:12-14`,
both `Session.status` and `Activity.status` use one enum, default `Draft`:

```cds
type SessionStatus : String enum {
  Draft; Invited; Confirmed; Declined; Cancelled; Completed; PendingTutorial;
}
```

**Allowed (visible) set:** `{ Confirmed, Completed }`.
**Hidden:** `Draft`, `Invited`, `Declined`, `Cancelled`, `PendingTutorial` (five states).

Because the planner default is `Draft`, anything an organizer has not explicitly
advanced is excluded — the desired behavior.

## Design

### Single chokepoint: `srv/lib/devtoberfest-feed.js`

Add one pure, exported predicate and apply it in both existing functions. Filtering
lives in the pure (no cds/db) layer so it is trivially unit-testable and one edit
covers all three pages plus the points math.

```js
const VISIBLE_STATUSES = new Set(['confirmed', 'completed']);
function isVisibleStatus(row) {
  const s = (row.STATUS ?? row.status ?? '').trim().toLowerCase();
  return VISIBLE_STATUSES.has(s);
}
```

- **`assembleFeed`** — filter `sessions` and `activities` through `isVisibleStatus`
  before the existing `.map(...)`. All of Schedule, Sessions, and Calendar consume
  this one feed, so all three pages are covered at once.
- **`completedActivityPoints`** — skip non-visible activities so `earnedPoints`
  and `maxPoints` match the visible activity list (points math filtered too).

**Match strictness:** case-insensitive + trimmed compare, defensive against casing
drift through the `String(5000)` facade view (HANA string comparison is
case-sensitive). `Confirmed` / `confirmed` / `CONFIRMED` all pass; empty/missing
`STATUS` is excluded (fails closed — a row with no status is not "confirmed").

Export `isVisibleStatus` (and optionally `VISIBLE_STATUSES`) alongside the existing
exports for direct unit testing.

### One required route touch: `srv/routes/devtoberfest-schedule.js`

The my-completions activity read at **line 89** does not currently select the
`STATUS` column:

```js
await SELECT.from(ext.Activity).columns('ID', 'POINTS', 'TASKSLUG', 'TRACK_ID').where({ TRACK_ID: { in: trackIds } })
```

Add `'STATUS'` to that `.columns(...)` list so `completedActivityPoints` can apply
`isVisibleStatus`. The schedule handler's reads (lines 46, 51) already select
`STATUS` — no change there. **No `.where()` changes** — filtering stays in the
pure layer.

### Untouched

- **Vue islands** (`devtoberfest-schedule`, `devtoberfest-sessions-grid`,
  `devtoberfest-sessions-calendar`) — render whatever the feed returns; no change.
- **OData projections** at `srv/devtoberfest-service.cds` (`Session`/`Activity`
  read-only projections under `@path: '/devtoberfest'`, authenticated) — **known
  non-covered surface.** These are not consumed by the three public pages. An
  authenticated OData client hitting `/devtoberfest/Session` still receives all
  statuses. Deliberately out of scope for this change; noted here so it is not a
  silent gap.

## Data flow (after change)

```
GET /api/devtoberfest/schedule
  → SELECT Session/Activity WHERE TRACK_ID in (...)   [all statuses from DB]
  → assembleFeed({ sessions, activities, ... })
      → filter isVisibleStatus  [Draft/Invited/Declined/Cancelled/PendingTutorial dropped]
      → map + sort
  → feed { sessions:[Confirmed|Completed], activities:[Confirmed|Completed] }

GET /api/devtoberfest/my-completions
  → SELECT Activity (+ STATUS) WHERE TRACK_ID in (...)
  → completedActivityPoints(activities, completedSlugSet)
      → skip !isVisibleStatus  [earned/max computed over visible activities only]
```

## Testing

Extend `test/unit/devtoberfest-feed.test.js` (pure, in-memory — no HANA):

- `assembleFeed` drops sessions with status `Draft`, `Invited`, `Declined`,
  `Cancelled`, `PendingTutorial`; keeps `Confirmed` and `Completed`.
- `assembleFeed` drops activities by the same rule.
- Mixed-case (`CONFIRMED`, `completed`, `  Confirmed  `) pass; empty/missing/`null`
  `STATUS` excluded.
- `completedActivityPoints` sums `earnedPoints`/`maxPoints` over visible activities
  only (a completed-but-Cancelled activity contributes to neither).
- `isVisibleStatus` unit-tested directly for the full enum vocabulary.

Existing feed tests that pass rows **without** a `STATUS` field must be updated to
include `STATUS: 'Confirmed'` (or `Completed`) where they assert rows survive the
feed — otherwise they will now be filtered out.

## Trade-off

Filtering in the pure layer (not the DB `.where`) means HANA returns all rows and
we drop them in Node. For Devtoberfest volume (dozens of rows per edition) this is
negligible and buys trivial unit-testability with no HANA dependency. Pushing the
predicate to `.where()` is a later optimization if volume ever grows.

## Repos touched

- `tutorials-poc` (`sap-tutorials/tutorials-ims`) only. No planner-repo change.

## Files

- `srv/lib/devtoberfest-feed.js` — add `isVisibleStatus`, apply in `assembleFeed`
  + `completedActivityPoints`, export the predicate.
- `srv/routes/devtoberfest-schedule.js` — add `'STATUS'` to the line-89
  `.columns(...)` list.
- `test/unit/devtoberfest-feed.test.js` — new cases + fix existing rows to carry a
  visible `STATUS`.
