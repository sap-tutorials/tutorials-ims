# Devtoberfest Confirmed/Completed Status Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Filter the Devtoberfest Schedule/Sessions/Calendar pages (and their points math) to only show planner sessions/activities in status `Confirmed` or `Completed`, consumer-side.

**Architecture:** Add one pure, case-insensitive predicate `isVisibleStatus` in `srv/lib/devtoberfest-feed.js` and apply it inside `assembleFeed` (drops hidden rows from the feed all three pages consume) and `completedActivityPoints` (excludes hidden activities from earned/max points). One route touch adds the `STATUS` column to the my-completions activity read so the predicate has data. No DB `.where()` changes; no Vue island changes.

**Tech Stack:** Node.js (ESM), SAP CAP (`@sap/cds`), Vitest.

## Global Constraints

- Visible status set: `{ Confirmed, Completed }` (case-insensitive, trimmed). All other planner `SessionStatus` values (`Draft`, `Invited`, `Declined`, `Cancelled`, `PendingTutorial`) are hidden. Missing/empty status fails closed (hidden).
- Filtering lives in the pure layer (`srv/lib/devtoberfest-feed.js`) — no `cds`/`db` imports there; keep it unit-testable without HANA.
- Out of scope, do not touch: Vue islands, `srv/devtoberfest-service.cds` OData projections, Arcade/Leaderboard (external `/gameboard/*` backend).
- Spec: `docs/superpowers/specs/2026-08-04-devtoberfest-status-filter-design.md`.

---

## File Structure

- `srv/lib/devtoberfest-feed.js` — add `isVisibleStatus`, apply in `assembleFeed` + `completedActivityPoints`, export the predicate. (pure helpers, no db)
- `srv/routes/devtoberfest-schedule.js` — add `'STATUS'` to the my-completions activity `.columns(...)` (line ~89).
- `test/unit/devtoberfest-feed.test.js` — add filtering cases; update existing fixtures to carry a visible `STATUS`.

---

### Task 1: Add the `isVisibleStatus` predicate and apply it in the feed

**Files:**
- Modify: `srv/lib/devtoberfest-feed.js`
- Test: `test/unit/devtoberfest-feed.test.js`

**Interfaces:**
- Consumes: existing `assembleFeed({ sessions, activities, tracks, editions, activeEditionId })` and `completedActivityPoints(activities, completedSlugSet)`.
- Produces: `isVisibleStatus(row)` → `boolean` (true when `row.STATUS`/`row.status` trims+lowercases to `'confirmed'` or `'completed'`). Exported. `assembleFeed` now drops non-visible sessions/activities before mapping; `completedActivityPoints` skips non-visible activities in both earned and max sums.

- [ ] **Step 1: Update existing test fixtures to carry a visible STATUS**

The current fixtures in `test/unit/devtoberfest-feed.test.js` have no `STATUS`, so they would be filtered out and existing assertions would break. Give them a visible status. Replace the three fixture declarations (lines 5-10) with:

```js
  const tracks = [{ ID: 't1', NAME: 'ABAP', DAYOFWEEK: 'Monday' }];
  const sessions = [{ ID: 's1', TITLE: 'Intro', TRACK_ID: 't1', STATUS: 'Confirmed', WEEK: '1', SCHEDULEDSTART: '2026-10-05T09:00:00.000Z', SCHEDULEDTIMEZONE: 'Europe/Berlin', YOUTUBEURL: 'https://youtu.be/abc', ACTIVITY_ID: 'a1' }];
  const activities = [
    { ID: 'a1', TITLE: 'Do Intro', STATUS: 'Confirmed', WEEK: '1', POINTS: 500, TASKTYPE: 'TUTORIAL', TASKSLUG: 'Intro-Slug', TRACK_ID: 't1' },
    { ID: 'a2', TITLE: 'Puzzle', STATUS: 'Completed', WEEK: '1', POINTS: 300, TASKTYPE: 'PUZZLE', TASKSLUG: 'puz-1', TRACK_ID: 't1' },
  ];
```

Also add `STATUS: 'Confirmed'` to the two inline session rows in the "sessions sort by week" test (currently lines 41-42):

```js
    const s2 = { ID: 's2', TITLE: 'Later', TRACK_ID: 't1', STATUS: 'Confirmed', WEEK: '1', SCHEDULEDSTART: '2026-10-05T11:00:00.000Z' };
    const s1 = { ID: 's1', TITLE: 'Earlier', TRACK_ID: 't1', STATUS: 'Confirmed', WEEK: '1', SCHEDULEDSTART: '2026-10-05T09:00:00.000Z' };
```

- [ ] **Step 2: Write the failing tests**

Add this `describe` block to `test/unit/devtoberfest-feed.test.js` (import `isVisibleStatus` — update the top import line to `import { assembleFeed, completedActivityPoints, normalizeSlugSet, isVisibleStatus } from '../../srv/lib/devtoberfest-feed.js';`):

```js
  describe('status filtering (Confirmed/Completed only)', () => {
    const tracks = [{ ID: 't1', NAME: 'ABAP' }];
    const mkSession = (id, status) => ({ ID: id, TITLE: id, TRACK_ID: 't1', STATUS: status, WEEK: '1' });
    const mkActivity = (id, status, points = 100, slug = id) => ({ ID: id, TITLE: id, TRACK_ID: 't1', STATUS: status, WEEK: '1', POINTS: points, TASKSLUG: slug });

    it('isVisibleStatus accepts only Confirmed/Completed, case-insensitively', () => {
      for (const s of ['Confirmed', 'confirmed', 'CONFIRMED', '  Confirmed  ', 'Completed', 'completed']) {
        expect(isVisibleStatus({ STATUS: s })).toBe(true);
      }
      for (const s of ['Draft', 'Invited', 'Declined', 'Cancelled', 'PendingTutorial', '', null, undefined]) {
        expect(isVisibleStatus({ STATUS: s })).toBe(false);
      }
    });

    it('assembleFeed drops hidden-status sessions and activities', () => {
      const sessions = [mkSession('sV', 'Confirmed'), mkSession('sD', 'Draft'), mkSession('sX', 'Cancelled'), mkSession('sC', 'Completed')];
      const acts = [mkActivity('aV', 'Confirmed'), mkActivity('aI', 'Invited'), mkActivity('aP', 'PendingTutorial'), mkActivity('aC', 'Completed')];
      const out = assembleFeed({ sessions, activities: acts, tracks, editions: [], activeEditionId: null });
      expect(out.sessions.map((s) => s.id).sort()).toEqual(['sC', 'sV']);
      expect(out.activities.map((a) => a.id).sort()).toEqual(['aC', 'aV']);
    });

    it('completedActivityPoints ignores hidden-status activities in earned and max', () => {
      const acts = [
        mkActivity('aV', 'Confirmed', 500, 'done-slug'),
        mkActivity('aHidden', 'Draft', 999, 'done-slug'),
      ];
      const set = normalizeSlugSet([{ slug: 'done-slug' }]);
      const r = completedActivityPoints(acts, set);
      expect(r.earnedPoints).toBe(500);
      expect(r.maxPoints).toBe(500);
      expect(r.completedActivityIds).toEqual(['aV']);
    });
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/unit/devtoberfest-feed.test.js`
Expected: FAIL — `isVisibleStatus is not a function` / hidden rows still present / maxPoints 1499 instead of 500.

- [ ] **Step 4: Implement `isVisibleStatus` and apply it**

In `srv/lib/devtoberfest-feed.js`, add near the top (after the file header comment, before `normalizeSlugSet`):

```js
const VISIBLE_STATUSES = new Set(['confirmed', 'completed']);

// A planner Session/Activity is publicly visible only when its status is
// Confirmed or Completed. Trimmed + case-insensitive (facade STATUS is free-text
// String(5000)). Missing/empty status fails closed (hidden).
function isVisibleStatus(row) {
  const s = (row?.STATUS ?? row?.status ?? '').trim().toLowerCase();
  return VISIBLE_STATUSES.has(s);
}
```

In `assembleFeed`, add `.filter(isVisibleStatus)` before the existing `.map(...)` on both `sessions` and `activities`:

```js
    sessions: sessions
      .filter(isVisibleStatus)
      .map((s) => ({
```

```js
    activities: activities
      .filter(isVisibleStatus)
      .map((a) => ({
```

In `completedActivityPoints`, skip hidden activities at the top of the loop body:

```js
  for (const a of activities) {
    if (!isVisibleStatus(a)) continue;
    const pts = a.POINTS || a.points || 0;
```

Add `isVisibleStatus` to the export at the bottom:

```js
export { assembleFeed, completedActivityPoints, normalizeSlugSet, isVisibleStatus };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/devtoberfest-feed.test.js`
Expected: PASS (all cases, including the pre-existing fixture-based tests now carrying `STATUS`).

- [ ] **Step 6: Commit**

```bash
git add srv/lib/devtoberfest-feed.js test/unit/devtoberfest-feed.test.js
git commit -m "feat(devtoberfest): filter feed + points to Confirmed/Completed status"
```

---

### Task 2: Select STATUS in the my-completions activity read

**Files:**
- Modify: `srv/routes/devtoberfest-schedule.js` (the `.columns(...)` at ~line 89)

**Interfaces:**
- Consumes: `completedActivityPoints` (Task 1), which now calls `isVisibleStatus(a)` — requires each activity row to carry `STATUS`.
- Produces: no signature change; the my-completions activity rows now include `STATUS`, so points exclude hidden activities consistently with the feed.

- [ ] **Step 1: Add `'STATUS'` to the columns list**

In `srv/routes/devtoberfest-schedule.js`, in `myCompletionsHandler`, change the activity read (line ~89) from:

```js
          activities = trackIds.length
            ? await SELECT.from(ext.Activity).columns('ID', 'POINTS', 'TASKSLUG', 'TRACK_ID').where({ TRACK_ID: { in: trackIds } })
            : [];
```

to:

```js
          activities = trackIds.length
            ? await SELECT.from(ext.Activity).columns('ID', 'POINTS', 'TASKSLUG', 'TRACK_ID', 'STATUS').where({ TRACK_ID: { in: trackIds } })
            : [];
```

- [ ] **Step 2: Verify the full unit suite still passes**

Run: `npm test`
Expected: PASS. (No route-level unit test exercises this line against a DB; the change is a column addition. The Task 1 predicate is what enforces behavior.)

- [ ] **Step 3: Commit**

```bash
git add srv/routes/devtoberfest-schedule.js
git commit -m "feat(devtoberfest): read STATUS in my-completions so points honor status filter"
```

---

## Self-Review

**Spec coverage:**
- Visible set `{Confirmed, Completed}`, case-insensitive, fail-closed → Task 1, `isVisibleStatus`. ✓
- Filter in `assembleFeed` (covers all 3 pages) → Task 1 Step 4. ✓
- Filter points math (`completedActivityPoints`) → Task 1 Step 4. ✓
- Route touch: add `STATUS` to line-89 columns → Task 2. ✓
- Schedule handler reads (lines 46, 51) already select `STATUS` → no task needed (verified). ✓
- Existing tests updated to carry visible `STATUS` → Task 1 Step 1. ✓
- Islands / OData projection / Arcade / Leaderboard untouched → Global Constraints. ✓

**Placeholder scan:** No TBD/TODO/vague steps; all code shown verbatim. ✓

**Type consistency:** `isVisibleStatus(row)` used identically in `assembleFeed`, `completedActivityPoints`, and tests; export list matches import in test. ✓

---

## Execution Handoff

Two execution options — see below.
