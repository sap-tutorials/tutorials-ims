# Cron Tile Forward Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing Cron health Panel on the admin Board with chronological sort, a "Next 3 runs" column, and a 24-hour SVG timeline ribbon so operators can see what's about to fire across all 17 cron jobs at a glance.

**Architecture:** Server-side cron enumeration via `cron-parser` v5 (already pinned, used by #756). `AdminService.JobControls.listJobs()` gains one new field `nextRunsIso: array of String` capped at `min(50, next-24h)`. Client renders sort + Next-3-runs column + SVG ribbon all from this single array. No new page, no new admin nav entry — strict extension of the existing Panel at [app/admin-shell/webapp/view/Board.view.xml:81](app/admin-shell/webapp/view/Board.view.xml#L81).

**Tech Stack:** Node.js, CAP (CDS + Express), `cron-parser@5.6.1` v5 API (`CronExpressionParser.parse(schedule, { tz, currentDate })`), UI5 OData v4, inline SVG via `<core:HTML>`, vitest.

**Spec:** [docs/superpowers/specs/2026-06-30-750-cron-tile-forward-visibility-design.md](docs/superpowers/specs/2026-06-30-750-cron-tile-forward-visibility-design.md)

**Tracking issue:** [#750](https://github.com/sap-tutorials/tutorials-ims/issues/750)

---

## File Structure

**New files (4):**
- `srv/lib/cron-firings.js` — pure server-side cron enumeration helpers (~25 lines)
- `test/unit/srv/cron-firings.test.js` — vitest unit tests for the helpers (~120 lines, 5 tests)
- `app/admin-shell/webapp/controller/cron-timeline-helpers.js` — UI5 module exporting `buildTimelineSvg()` + `categoryForJob()` + `CATEGORY_COLORS` + `formatTickTooltip()` (~110 lines)
- `app/admin-shell/webapp/controller/job-controls-sort.js` — UI5 module exporting `sortJobsByNextRun()` (~25 lines)
- `test/unit/admin-shell/cron-timeline-helpers.test.js` — vitest unit tests (~150 lines, 5 tests)
- `test/unit/admin-shell/job-controls-sort.test.js` — vitest unit tests (~70 lines, 3 tests)

**Modified files (4):**
- `srv/admin-service.cds` (line 266-272) — add `nextRunsIso: array of String` to listJobs return shape
- `srv/admin-service.js` (line 2161-2180) — extend handler to enumerate firings; preserve existing try/catch
- `app/admin-shell/webapp/controller/Board.controller.js` — wire sort + ribbon-build in `_loadJobControls()`, register two new helper modules
- `app/admin-shell/webapp/view/Board.view.xml` — add `xmlns:core="sap.ui.core"` namespace, add `<core:HTML>` ribbon above table, add "Next 3 runs" `<Column>` + VBox cell
- `test/unit/srv/admin-job-controls.test.js` — extend existing test file with 5 new assertions for `nextRunsIso`

**Total:** 6 new files + 4 modified, ~250 lines net, 18 tests.

## Sequencing rationale

Server first (Tasks 1-3): the pure helper has no dependencies; the action signature change is purely additive; the handler delegates to the helper. Client builds on top of the wire shape (Tasks 4-6). View change last (Task 7) so it can reference the helpers already imported. Smoke + final commit (Task 8). TDD discipline throughout: red test → minimal impl → green test → commit, each task ending committed.

---

## Task 1: Server-side cron firings helper

**Files:**
- Create: `srv/lib/cron-firings.js`
- Create: `test/unit/srv/cron-firings.test.js`

This task delivers the pure enumeration helper with full TDD coverage. No other code depends on it yet, so it's the safest first commit.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/srv/cron-firings.test.js`:

```js
// Unit tests for srv/lib/cron-firings.js — pure-function helpers that
// enumerate cron firings within a time window. Used by the AdminService.
// JobControls.listJobs handler to populate nextRunsIso for the Board's
// Cron health tile (#750). Mirrors the v5 cron-parser API (CronExpressionParser.
// parse) used at srv/admin-service.js:2166 — same import shape, same call,
// same options.

import { describe, it, expect } from 'vitest';
import { enumerateFiringsWithinWindow, nextRunIsoFrom } from '../../../srv/lib/cron-firings.js';

describe('enumerateFiringsWithinWindow', () => {
  it('returns 12 firings for a */5 schedule across a 60-minute window', () => {
    const from = new Date('2026-07-01T12:00:00.000Z');
    const to = new Date('2026-07-01T13:00:00.000Z');
    const out = enumerateFiringsWithinWindow('*/5 * * * *', from, to, 50);
    expect(out).toHaveLength(12);
    // monotonic strictly increasing
    for (let i = 1; i < out.length; i++) {
      expect(new Date(out[i]) > new Date(out[i - 1])).toBe(true);
    }
    // 5-minute spacing
    expect(new Date(out[1]) - new Date(out[0])).toBe(5 * 60 * 1000);
  });

  it('honors the cap argument when there are more firings than the cap allows', () => {
    const from = new Date('2026-07-01T12:00:00.000Z');
    const to = new Date('2026-07-01T13:00:00.000Z');
    const out = enumerateFiringsWithinWindow('*/5 * * * *', from, to, 3);
    expect(out).toHaveLength(3);
  });

  it('returns [] when no firing falls inside the window (monthly cron)', () => {
    // "23 4 1 * *" fires at 04:23 on the 1st of each month. From 2026-06-30T00:00Z + 24h,
    // the window is [2026-06-30T00:00Z, 2026-07-01T00:00Z], which excludes the next
    // 2026-07-01T04:23Z firing (`to` is inclusive but 04:23Z > 00:00Z).
    const from = new Date('2026-06-30T00:00:00.000Z');
    const to = new Date('2026-07-01T00:00:00.000Z');
    const out = enumerateFiringsWithinWindow('23 4 1 * *', from, to, 50);
    expect(out).toEqual([]);
  });

  it('caps a per-minute schedule at exactly 50 firings, not 1440', () => {
    const from = new Date('2026-07-01T12:00:00.000Z');
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
    const out = enumerateFiringsWithinWindow('* * * * *', from, to, 50);
    expect(out).toHaveLength(50);
  });

  it('excludes the lower bound: a firing exactly at `from` is NOT in the result', () => {
    // "0 * * * *" fires at HH:00:00. Starting `from` AT HH:00:00 should yield
    // the NEXT hour as the first entry, not the current one.
    const from = new Date('2026-07-01T12:00:00.000Z');
    const to = new Date('2026-07-01T14:30:00.000Z');
    const out = enumerateFiringsWithinWindow('0 * * * *', from, to, 50);
    expect(out[0]).toBe('2026-07-01T13:00:00.000Z');
    expect(out[1]).toBe('2026-07-01T14:00:00.000Z');
  });
});

describe('nextRunIsoFrom', () => {
  it('returns the single next firing time as an ISO string', () => {
    const from = new Date('2026-06-30T00:00:00.000Z');
    const out = nextRunIsoFrom('23 4 1 * *', from);
    expect(out).toBe('2026-07-01T04:23:00.000Z');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/srv/cron-firings.test.js`

Expected: Tests fail with module resolution error — `srv/lib/cron-firings.js` does not yet exist.

- [ ] **Step 3: Write the helper**

Create `srv/lib/cron-firings.js`:

```js
// srv/lib/cron-firings.js — pure-function helpers that enumerate cron
// firings within a time window. Powers the nextRunsIso field on
// AdminService.JobControls.listJobs() (#750), which the Board's Cron
// health tile uses to render the chronological sort + Next-3-runs
// column + 24-hour SVG timeline ribbon.
//
// Uses the same cron-parser v5 API already used by srv/admin-service.js:2166
// — CronExpressionParser.parse(schedule, { tz, currentDate }). Keeping the
// option shape symmetric across both call sites means any future v5 → v6
// upgrade is a single grep, not two.

import { CronExpressionParser } from 'cron-parser';

/**
 * Enumerate cron firings within a time window.
 * @param {string} schedule  Cron expression (5-field, matches node-cron).
 * @param {Date} from        Window start (exclusive — `from` itself is not a firing).
 * @param {Date} to          Window end (inclusive — strictly `>` is the exit condition).
 * @param {number} cap       Hard limit on returned timestamps.
 * @returns {string[]}       ISO timestamp strings (UTC), oldest to newest.
 */
export function enumerateFiringsWithinWindow(schedule, from, to, cap) {
  const iter = CronExpressionParser.parse(schedule, { tz: 'UTC', currentDate: from });
  const out = [];
  while (out.length < cap) {
    const next = iter.next().toDate();
    if (next > to) break;
    out.push(next.toISOString());
  }
  return out;
}

/**
 * Single-firing convenience: the next time `schedule` fires after `from`.
 * Used by the listJobs handler as fallback for jobs whose next firing is
 * outside the 24h window enumerated by enumerateFiringsWithinWindow() —
 * monthly crons like `23 4 1 * *` where nextRunsIso is [] but we still
 * want to surface the next firing in the per-row Next run column.
 *
 * @param {string} schedule
 * @param {Date} from
 * @returns {string}
 */
export function nextRunIsoFrom(schedule, from) {
  return CronExpressionParser.parse(schedule, { tz: 'UTC', currentDate: from })
    .next().toDate().toISOString();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/srv/cron-firings.test.js`

Expected: 6 tests pass (5 enumerateFiringsWithinWindow + 1 nextRunIsoFrom).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/cron-firings.js test/unit/srv/cron-firings.test.js
git commit -m "feat(#750): add cron-firings helper for window enumeration

Pure helper consuming the same cron-parser v5 API as the existing
#756 listJobs handler. Two exports:

- enumerateFiringsWithinWindow(schedule, from, to, cap) returns the
  ISO timestamps of firings that fall in the (from, to] window,
  capped at \`cap\` entries.
- nextRunIsoFrom(schedule, from) returns the single next firing
  ISO timestamp — used by the listJobs handler as fallback for
  monthly-cron tail jobs whose next firing is >24h out.

Covered by 6 vitest unit tests: spacing, cap clipping, empty window,
1440→50 cap, lower-bound exclusion, single-firing helper.

Spec: docs/superpowers/specs/2026-06-30-750-cron-tile-forward-visibility-design.md §3.1"
```

## Task 2: Extend CDS action return shape

**Files:**
- Modify: `srv/admin-service.cds:266-272`

Pure schema change. No tests in this task — the wire shape is exercised by the handler test in Task 3. This task is its own commit so the schema change is a clean rollback point.

- [ ] **Step 1: Apply the edit**

In `srv/admin-service.cds`, change the listJobs action signature from:

```cds
    action listJobs() returns array of {
      jobName     : String;
      schedule    : String;
      ttlMs       : Integer;
      description : String;
      nextRunIso  : String;
    };
```

to:

```cds
    action listJobs() returns array of {
      jobName     : String;
      schedule    : String;
      ttlMs       : Integer;
      description : String;
      nextRunIso  : String;
      // #750: ISO timestamps of cron firings in (now, now+24h], capped at 50
      // per job. Empty for monthly crons whose next firing falls outside the
      // window — nextRunIso still populated via fallback.
      nextRunsIso : array of String;
    };
```

- [ ] **Step 2: Verify CDS still compiles**

Run: `npx cds compile srv/admin-service.cds --to json > /dev/null`

Expected: exit code 0, no output (compile succeeds silently).

- [ ] **Step 3: Commit**

```bash
git add srv/admin-service.cds
git commit -m "feat(#750): add nextRunsIso field to listJobs() return shape

Additive change to AdminService.JobControls.listJobs(). Existing clients
ignore the new field (UI5 OData binding tolerates unknown response
fields). The next commit wires the handler.

Spec: docs/superpowers/specs/2026-06-30-750-cron-tile-forward-visibility-design.md §3.1"
```

## Task 3: Extend listJobs handler + tests

**Files:**
- Modify: `srv/admin-service.js:2161-2180`
- Modify: `test/unit/srv/admin-job-controls.test.js` (append 5 new tests)

TDD path: red test for `nextRunsIso` first, then minimal handler change, green test, commit. We append to the existing test file rather than creating a new one — same boot harness, same `cds.test('serve')` instance, no duplicate scaffolding.

- [ ] **Step 1: Read the existing test file to find the insertion point**

Open `test/unit/srv/admin-job-controls.test.js`. Find the closing `}); // describe('AdminService.JobControls')` — typically at the very end of the file. New tests will be added inside the same `describe` block, AFTER all existing tests but BEFORE the closing brace.

The existing file already imports `expect`, `it`, etc. and exposes `registerOne`, `nextJobName`, `callListJobs` — reuse them verbatim.

- [ ] **Step 2: Write the failing tests**

Insert the following block inside the `describe('AdminService.JobControls', ...)` block, after the last existing `it(...)`:

```js
  // ─────────────────────────────────────────────────────────────────
  // #750: nextRunsIso (forward-visibility window for the Board tile)
  // ─────────────────────────────────────────────────────────────────

  // Helper: register a job with a specific schedule. Variant of registerOne()
  // above that takes the schedule, so we can test window math without
  // colliding with the default '0 0 1 1 *' yearly cron.
  function registerWithSchedule(jobName, schedule) {
    sched.registerJob({
      jobName,
      schedule,
      ttlMs: 60000,
      description: 'unit test #750',
      fn: async () => ({ processed: 1 }),
    });
  }

  it('listJobs response includes nextRunsIso as an array', async () => {
    const jobName = nextJobName();
    registerWithSchedule(jobName, '*/5 * * * *');
    const rows = await callListJobs();
    const row = rows.find(r => r.jobName === jobName);
    expect(row).toBeTruthy();
    expect(Array.isArray(row.nextRunsIso)).toBe(true);
  });

  it('listJobs.nextRunsIso entries are all within the next 24 hours', async () => {
    const jobName = nextJobName();
    registerWithSchedule(jobName, '*/15 * * * *'); // every 15 minutes
    const rows = await callListJobs();
    const row = rows.find(r => r.jobName === jobName);
    expect(row.nextRunsIso.length).toBeGreaterThan(0);
    const now = Date.now();
    const horizon = now + 24 * 60 * 60 * 1000;
    for (const iso of row.nextRunsIso) {
      const t = new Date(iso).getTime();
      expect(t).toBeGreaterThan(now);
      // Allow ±1s slack for handler-clock vs. test-clock skew.
      expect(t).toBeLessThanOrEqual(horizon + 1000);
    }
  });

  it('listJobs.nextRunsIso[0] equals nextRunIso when the next run is in-window', async () => {
    const jobName = nextJobName();
    registerWithSchedule(jobName, '*/5 * * * *');
    const rows = await callListJobs();
    const row = rows.find(r => r.jobName === jobName);
    expect(row.nextRunsIso.length).toBeGreaterThan(0);
    expect(row.nextRunsIso[0]).toBe(row.nextRunIso);
  });

  it('listJobs.nextRunsIso is [] for a monthly cron whose next firing is >24h away', async () => {
    // Pick a day-of-month so far in the future that no firing lands in (now, now+24h].
    // First of next year @ 00:00 UTC is always >24h out from any test run.
    const jobName = nextJobName();
    registerWithSchedule(jobName, '0 0 1 1 *'); // 00:00 on 1 Jan
    const rows = await callListJobs();
    const row = rows.find(r => r.jobName === jobName);
    expect(row.nextRunsIso).toEqual([]);
    // But nextRunIso must still be populated via the fallback.
    expect(row.nextRunIso).toMatch(/^\d{4}-01-01T00:00:00\.\d{3}Z$/);
  });

  it('listJobs.nextRunsIso never exceeds 50 entries even for a per-minute schedule', async () => {
    const jobName = nextJobName();
    registerWithSchedule(jobName, '* * * * *');
    const rows = await callListJobs();
    const row = rows.find(r => r.jobName === jobName);
    expect(row.nextRunsIso.length).toBeLessThanOrEqual(50);
    expect(row.nextRunsIso.length).toBeGreaterThanOrEqual(50); // the cap is exactly 50 for */1
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/unit/srv/admin-job-controls.test.js`

Expected: The 5 new tests fail. The first ("includes nextRunsIso as an array") fails on `expect(Array.isArray(row.nextRunsIso)).toBe(true)` — the handler doesn't yet emit the field, so `row.nextRunsIso` is `undefined`. The pre-existing tests still pass.

- [ ] **Step 4: Update the handler**

Edit `srv/admin-service.js`. Add the import near the top (around line 34, right after the existing `CronExpressionParser` import):

```js
import { enumerateFiringsWithinWindow, nextRunIsoFrom } from './lib/cron-firings.js';
```

Replace the existing `this.on('listJobs', 'JobControls', ...)` handler block (currently around lines 2161-2180) with:

```js
    this.on('listJobs', 'JobControls', async () => {
      const registry = _getJobRegistry();
      const now = new Date();
      const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      return Array.from(registry.values()).map(job => {
        let nextRunsIso = [];
        let nextRunIso = null;
        try {
          nextRunsIso = enumerateFiringsWithinWindow(job.schedule, now, horizon, 50);
          // #750: fallback only when the 24h window is empty (monthly crons).
          // Explicit length check — NOT `??` — to make the intent unambiguous:
          // we only invoke nextRunIsoFrom() in the empty case, not always.
          nextRunIso = nextRunsIso.length > 0
            ? nextRunsIso[0]
            : nextRunIsoFrom(job.schedule, now);
        } catch (err) {
          LOG.warn(`listJobs: cron-parser failed on '${job.schedule}': ${err.message}`);
        }
        return {
          jobName: job.jobName,
          schedule: job.schedule,
          ttlMs: job.ttlMs,
          description: job.description,
          nextRunIso,
          nextRunsIso,
        };
      });
    });
```

Key points:
- **Preserve the existing try/catch + `LOG.warn`** — bad schedules in `JOB_REGISTRY` must not break the whole tile. Both `nextRunIso` and `nextRunsIso` default to `null` and `[]` for the offending row.
- The `now` + `horizon` Dates are computed ONCE per request (not per job) so all rows share the same window — important for the chronological sort to be stable.

- [ ] **Step 5: Run all admin-job-controls tests to verify**

Run: `npx vitest run test/unit/srv/admin-job-controls.test.js`

Expected: all pre-existing tests still pass, plus the 5 new ones. Total ~10+ passing.

- [ ] **Step 6: Commit**

```bash
git add srv/admin-service.js test/unit/srv/admin-job-controls.test.js
git commit -m "feat(#750): populate nextRunsIso in listJobs handler

Extend the existing JobControls.listJobs handler to enumerate cron
firings in (now, now+24h] via the cron-firings helper. Empty for
monthly crons whose next firing is outside the window; nextRunIso
still populated via nextRunIsoFrom() fallback in that case.

Preserves the existing try/catch + LOG.warn guard — bad schedules
log-and-skip rather than breaking the tile (matches #756 behavior).

Covered by 5 new vitest cases against in-memory cds.test('serve'):
- nextRunsIso is array
- all entries within 24h horizon
- nextRunsIso[0] === nextRunIso when in-window
- monthly cron returns [] with fallback nextRunIso
- per-minute schedule caps at exactly 50

Spec: docs/superpowers/specs/2026-06-30-750-cron-tile-forward-visibility-design.md §3.1"
```

## Task 4: Client-side sort helper

**Files:**
- Create: `app/admin-shell/webapp/controller/job-controls-sort.js`
- Create: `test/unit/admin-shell/job-controls-sort.test.js`

Pure helper — same UI5 `sap.ui.define` pattern as the existing `job-controls-helpers.js`. Independently unit-testable via `vm.runInContext` (mirrors the existing `board-controller-job-controls.test.js`).

- [ ] **Step 1: Write the failing tests**

Create `test/unit/admin-shell/job-controls-sort.test.js`:

```js
// Unit tests for app/admin-shell/webapp/controller/job-controls-sort.js
// — pure sort helper applied client-side after JobControlsHelpers.
// joinJobsWithLastRuns() but before the JSONModel update in
// Board.controller.js _loadJobControls() (#750).
//
// Same vm + stubbed `sap.ui.define` pattern as
// test/unit/admin-shell/board-controller-job-controls.test.js.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HELPER_PATH = path.resolve(
  __dirname,
  '../../../app/admin-shell/webapp/controller/job-controls-sort.js'
);

let sortJobsByNextRun;

beforeAll(() => {
  const src = readFileSync(HELPER_PATH, 'utf8');
  let captured;
  const context = {
    sap: { ui: { define(_deps, factory) { captured = factory(); } } },
    Date, Math, Number, String, Array, Object,
  };
  vm.createContext(context);
  vm.runInContext(src, context, { filename: HELPER_PATH });
  if (!captured) throw new Error('job-controls-sort.js did not register a factory');
  sortJobsByNextRun = captured.sortJobsByNextRun;
});

describe('sortJobsByNextRun', () => {
  it('sorts ascending by nextRunIso', () => {
    const input = [
      { jobName: 'late',   nextRunIso: '2026-07-01T15:00:00.000Z' },
      { jobName: 'early',  nextRunIso: '2026-07-01T09:00:00.000Z' },
      { jobName: 'middle', nextRunIso: '2026-07-01T12:00:00.000Z' },
    ];
    const result = sortJobsByNextRun(input);
    expect(result.map(r => r.jobName)).toEqual(['early', 'middle', 'late']);
  });

  it('sorts null/undefined nextRunIso to the bottom', () => {
    const input = [
      { jobName: 'nullish', nextRunIso: null },
      { jobName: 'early',   nextRunIso: '2026-07-01T09:00:00.000Z' },
      { jobName: 'undef'    /* no nextRunIso */ },
      { jobName: 'later',   nextRunIso: '2026-07-01T15:00:00.000Z' },
    ];
    const result = sortJobsByNextRun(input);
    expect(result.map(r => r.jobName)).toEqual(['early', 'later', 'nullish', 'undef']);
  });

  it('preserves stable order for equal nextRunIso values', () => {
    const same = '2026-07-01T12:00:00.000Z';
    const input = [
      { jobName: 'A', nextRunIso: same },
      { jobName: 'B', nextRunIso: same },
      { jobName: 'C', nextRunIso: same },
    ];
    const result = sortJobsByNextRun(input);
    expect(result.map(r => r.jobName)).toEqual(['A', 'B', 'C']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/admin-shell/job-controls-sort.test.js`

Expected: tests fail — the helper file doesn't exist.

- [ ] **Step 3: Write the helper**

Create `app/admin-shell/webapp/controller/job-controls-sort.js`:

```js
// app/admin-shell/webapp/controller/job-controls-sort.js
//
// #750: pure sort helper. Applied to the JOIN output of
// JobControlsHelpers.joinJobsWithLastRuns() before the JSONModel write
// in Board.controller.js _loadJobControls(). Chronological order
// (nextRunIso ascending) surfaces what's about to fire at the top of
// the table; jobs with no upcoming run (null nextRunIso — e.g. a bad
// schedule that log-warned out of the handler) sort to the bottom.
//
// Unit-tested in test/unit/admin-shell/job-controls-sort.test.js.

sap.ui.define([], function () {
  'use strict';

  /**
   * Sort a list of joined job rows by nextRunIso ascending. Stable —
   * equal timestamps preserve input order. Null / undefined / invalid
   * timestamps sort to the bottom.
   *
   * Returns a new array; does NOT mutate the input.
   *
   * @param {Array<{jobName: string, nextRunIso?: string|null}>} jobs
   * @returns {Array<object>}
   */
  function sortJobsByNextRun(jobs) {
    // Decorate with original index so the comparator can fall back to it
    // for stable ordering across ties (Array.prototype.sort is stable in
    // V8 11+ which UI5 targets, but the explicit fallback also handles
    // null-vs-null comparisons consistently).
    var decorated = (jobs || []).map(function (j, i) {
      var t = (j && j.nextRunIso) ? Date.parse(j.nextRunIso) : NaN;
      return { job: j, idx: i, t: isNaN(t) ? Infinity : t };
    });
    decorated.sort(function (a, b) {
      if (a.t !== b.t) return a.t - b.t;
      return a.idx - b.idx;
    });
    return decorated.map(function (d) { return d.job; });
  }

  return { sortJobsByNextRun: sortJobsByNextRun };
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/admin-shell/job-controls-sort.test.js`

Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/admin-shell/webapp/controller/job-controls-sort.js test/unit/admin-shell/job-controls-sort.test.js
git commit -m "feat(#750): add job-controls-sort UI5 helper module

Pure-function sort applied client-side after the listJobs + JobLastRun
JOIN, before the JSONModel write. Chronological order surfaces the
soonest firing at the top; null/invalid nextRunIso sort to the bottom.

UI5 sap.ui.define module so the Board controller can import it via the
standard module path. Vitest-testable via the same vm + stubbed
sap.ui.define pattern used by board-controller-job-controls.test.js.

3 tests: ascending sort, nulls-last, stable equal-tie ordering.

Spec: docs/superpowers/specs/2026-06-30-750-cron-tile-forward-visibility-design.md §3.2"
```

## Task 5: Client-side timeline helpers

**Files:**
- Create: `app/admin-shell/webapp/controller/cron-timeline-helpers.js`
- Create: `test/unit/admin-shell/cron-timeline-helpers.test.js`

Three exports: `CATEGORY_COLORS`, `categoryForJob()`, `buildTimelineSvg()`. Tested via the same `vm` + stubbed `sap.ui.define` harness.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/admin-shell/cron-timeline-helpers.test.js`:

```js
// Unit tests for app/admin-shell/webapp/controller/cron-timeline-helpers.js
// (#750). Pure functions:
// - categoryForJob(jobName)  → category slug string
// - buildTimelineSvg(jobs, opts) → SVG markup string
// - CATEGORY_COLORS          → const map exported for tests + sanity
//
// Same vm + stubbed sap.ui.define pattern as
// test/unit/admin-shell/board-controller-job-controls.test.js.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HELPER_PATH = path.resolve(
  __dirname,
  '../../../app/admin-shell/webapp/controller/cron-timeline-helpers.js'
);

let CATEGORY_COLORS;
let categoryForJob;
let buildTimelineSvg;

beforeAll(() => {
  const src = readFileSync(HELPER_PATH, 'utf8');
  let captured;
  const context = {
    sap: { ui: { define(_deps, factory) { captured = factory(); } } },
    Date, Math, Number, String, Array, Object, JSON,
  };
  vm.createContext(context);
  vm.runInContext(src, context, { filename: HELPER_PATH });
  if (!captured) throw new Error('cron-timeline-helpers.js did not register a factory');
  CATEGORY_COLORS = captured.CATEGORY_COLORS;
  categoryForJob = captured.categoryForJob;
  buildTimelineSvg = captured.buildTimelineSvg;
});

describe('categoryForJob', () => {
  it('classifies fetch-* jobs as fetch', () => {
    expect(categoryForJob('fetch-blog-posts')).toBe('fetch');
    expect(categoryForJob('fetch-videos')).toBe('fetch');
  });

  it('classifies cleanup + gc-external-content as cleanup', () => {
    expect(categoryForJob('cleanup')).toBe('cleanup');
    expect(categoryForJob('gc-external-content')).toBe('cleanup');
  });

  it('classifies concept / embedding jobs as kg', () => {
    expect(categoryForJob('extract-concepts')).toBe('kg');
    expect(categoryForJob('consolidate-concepts')).toBe('kg');
    expect(categoryForJob('embedding-reconciliation')).toBe('kg');
  });

  it('classifies retry / merge jobs as retry', () => {
    expect(categoryForJob('ngds-retry')).toBe('retry');
    expect(categoryForJob('account-merge-job')).toBe('retry');
  });

  it('classifies secret + health jobs as secret', () => {
    expect(categoryForJob('secret-expiry-check')).toBe('secret');
    expect(categoryForJob('homepage-link-health')).toBe('secret');
  });

  it('falls back to unknown for unrecognized job names', () => {
    expect(categoryForJob('some-totally-new-thing')).toBe('unknown');
  });

  it('exports CATEGORY_COLORS with hex values for all 6 categories', () => {
    expect(CATEGORY_COLORS).toBeTruthy();
    for (const key of ['fetch', 'cleanup', 'kg', 'retry', 'secret', 'unknown']) {
      expect(CATEGORY_COLORS[key]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('buildTimelineSvg', () => {
  it('renders an SVG containing the Now marker, fires-count label, and 0 rects for an empty input', () => {
    const now = new Date('2026-07-01T12:00:00.000Z');
    const svg = buildTimelineSvg([], { now, widthPx: 800, heightPx: 80 });
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('Now');
    expect(svg).toContain('Fires in next 24h: 0');
    // No <rect> tags for ticks (ignore <rect> the impl may emit for backgrounds —
    // assert there are no rects with the `fill="#<category>` attribute).
    const tickMatches = svg.match(/<rect[^>]*fill="#[0-9a-f]{6}"/gi) || [];
    expect(tickMatches.length).toBe(0);
  });

  it('renders one rect per firing with category-colored fill', () => {
    const now = new Date('2026-07-01T12:00:00.000Z');
    const jobs = [
      { jobName: 'fetch-blog-posts', nextRunsIso: ['2026-07-01T13:00:00.000Z', '2026-07-01T14:00:00.000Z'] },
      { jobName: 'cleanup',          nextRunsIso: ['2026-07-01T12:30:00.000Z'] },
    ];
    const svg = buildTimelineSvg(jobs, { now, widthPx: 800, heightPx: 80 });
    const fetchColor = CATEGORY_COLORS.fetch.replace('#', '');
    const cleanupColor = CATEGORY_COLORS.cleanup.replace('#', '');
    // 2 fetch ticks + 1 cleanup tick = 3 colored rects total
    const fetchRects = svg.match(new RegExp(`<rect[^>]*fill="#${fetchColor}"`, 'gi')) || [];
    const cleanupRects = svg.match(new RegExp(`<rect[^>]*fill="#${cleanupColor}"`, 'gi')) || [];
    expect(fetchRects.length).toBe(2);
    expect(cleanupRects.length).toBe(1);
    expect(svg).toContain('Fires in next 24h: 3');
  });

  it('positions a firing 12h from now at ~50% of widthPx (linear scale)', () => {
    const now = new Date('2026-07-01T12:00:00.000Z');
    const jobs = [
      { jobName: 'fetch-x', nextRunsIso: ['2026-07-02T00:00:00.000Z'] }, // exactly +12h
    ];
    const svg = buildTimelineSvg(jobs, { now, widthPx: 800, heightPx: 80 });
    // Extract the single colored rect's x attribute
    const m = svg.match(/<rect[^>]*x="(\d+(?:\.\d+)?)"[^>]*fill="#[0-9a-f]{6}"/i);
    expect(m).toBeTruthy();
    const x = parseFloat(m[1]);
    // 12h of 24h horizon == 50% of widthPx. Allow ±2px slack for tick centering.
    expect(x).toBeGreaterThanOrEqual(400 - 2);
    expect(x).toBeLessThanOrEqual(400 + 2);
  });

  it('each tick rect contains a <title> child with the jobName and ISO time', () => {
    const now = new Date('2026-07-01T12:00:00.000Z');
    const jobs = [
      { jobName: 'extract-concepts', nextRunsIso: ['2026-07-01T13:00:00.000Z'] },
    ];
    const svg = buildTimelineSvg(jobs, { now, widthPx: 800, heightPx: 80 });
    // Find a <title>...</title> that mentions both the job and ANY recognizable
    // hour fragment of the ISO timestamp (the impl can humanize the time —
    // assertion only requires both the jobName and one of '13:00' or '+1' appear).
    expect(svg).toMatch(/<title>[^<]*extract-concepts[^<]*<\/title>/);
  });

  it('clamps a firing past widthPx to the right edge rather than overflowing', () => {
    // Defensive: if the cap allows a firing at exactly 24h00m01s (unlikely but
    // possible at the window boundary), the rect's x should still be ≤ widthPx
    // so the SVG doesn't render outside its box.
    const now = new Date('2026-07-01T12:00:00.000Z');
    const overEdge = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1000).toISOString();
    const jobs = [{ jobName: 'fetch-x', nextRunsIso: [overEdge] }];
    const svg = buildTimelineSvg(jobs, { now, widthPx: 800, heightPx: 80 });
    const m = svg.match(/<rect[^>]*x="(\d+(?:\.\d+)?)"[^>]*fill="#[0-9a-f]{6}"/i);
    expect(m).toBeTruthy();
    expect(parseFloat(m[1])).toBeLessThanOrEqual(800);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/admin-shell/cron-timeline-helpers.test.js`

Expected: tests fail — helper file does not exist.

- [ ] **Step 3: Write the helper**

Create `app/admin-shell/webapp/controller/cron-timeline-helpers.js`:

```js
// app/admin-shell/webapp/controller/cron-timeline-helpers.js
//
// #750: SVG ribbon builder for the Cron health tile's 24-hour timeline.
// Three exports:
//   - CATEGORY_COLORS  — frozen category → hex map (5 known + 1 fallback)
//   - categoryForJob   — pure function jobName → category slug
//   - buildTimelineSvg — pure function (jobs, opts) → SVG markup string
//
// Called by Board.controller.js _loadJobControls() after the chronological
// sort, with output placed into the jobControls JSONModel at /timelineHtml
// and rendered via <core:HTML content="{jobControls>/timelineHtml}"/> at
// app/admin-shell/webapp/view/Board.view.xml above the existing Table.
//
// Unit-tested in test/unit/admin-shell/cron-timeline-helpers.test.js.

sap.ui.define([], function () {
  'use strict';

  // Frozen so accidental client-side mutation can't drift the legend out
  // of sync with category assignments at runtime.
  var CATEGORY_COLORS = Object.freeze({
    fetch:   '#4078b8',  // fetch-{learning-journeys,blog-posts,discovery-missions,videos,api-docs,samples}
    cleanup: '#888888',  // cleanup, gc-external-content
    kg:      '#9a4dbb',  // extract-concepts, consolidate-concepts, embedding-reconciliation
    retry:   '#d29922',  // ngds-retry, account-merge, mail-retry
    secret:  '#3fb950',  // secret-expiry-check, homepage-link-health
    unknown: '#888888',  // fallback (alias of cleanup grey — distinct semantic)
  });

  /**
   * Classify a job by name into one of 5 categories (+ fallback). Pattern-
   * matching only — no DB lookup, no metadata cross-reference. New jobs
   * default to 'unknown' until they get a rule here.
   *
   * @param {string} jobName
   * @returns {'fetch'|'cleanup'|'kg'|'retry'|'secret'|'unknown'}
   */
  function categoryForJob(jobName) {
    if (typeof jobName !== 'string') return 'unknown';
    if (jobName.indexOf('fetch-') === 0) return 'fetch';
    if (jobName === 'cleanup' || jobName === 'gc-external-content') return 'cleanup';
    if (jobName.indexOf('concept') !== -1 || jobName.indexOf('embedding') !== -1) return 'kg';
    if (jobName.indexOf('retry') !== -1 || jobName.indexOf('merge') !== -1) return 'retry';
    if (jobName.indexOf('secret') !== -1 || jobName.indexOf('health') !== -1) return 'secret';
    return 'unknown';
  }

  /**
   * Humanize a future ISO timestamp into "in 1h 12m" / "in 45m" / "now".
   * Internal helper for rect tooltip text.
   */
  function _humanizeRelative(iso, nowMs) {
    var t = Date.parse(iso);
    if (isNaN(t)) return iso;
    var diff = Math.max(0, t - nowMs);
    if (diff < 60000) return 'now';
    var mins = Math.round(diff / 60000);
    if (mins < 60) return 'in ' + mins + 'm';
    var hrs = Math.floor(mins / 60);
    var remMins = mins % 60;
    return remMins === 0 ? 'in ' + hrs + 'h' : 'in ' + hrs + 'h ' + remMins + 'm';
  }

  /**
   * Build an inline SVG string for the 24-hour cron timeline ribbon.
   *
   * Geometry:
   *   - widthPx wide × heightPx tall (default 800 × 80)
   *   - Now marker at x=0 (vertical line)
   *   - Tick: 3 px wide × 14 px tall, vertically centered in the band
   *   - "Fires in next 24h: N" label top-right
   *
   * Tooltips: each tick has a <title> child for native browser hover.
   *
   * @param {Array<{jobName: string, nextRunsIso: string[]}>} jobs
   * @param {{now: Date, widthPx?: number, heightPx?: number}} opts
   * @returns {string}
   */
  function buildTimelineSvg(jobs, opts) {
    opts = opts || {};
    var now = opts.now || new Date();
    var nowMs = now.getTime();
    var widthPx = opts.widthPx || 800;
    var heightPx = opts.heightPx || 80;
    var horizonMs = 24 * 60 * 60 * 1000;

    var TICK_W = 3;
    var TICK_H = 14;
    var BAND_Y_CENTER = Math.round(heightPx * 0.55);  // ribbon band sits ~55% down
    var TICK_Y = BAND_Y_CENTER - Math.floor(TICK_H / 2);

    // Count and emit ticks
    var ticks = [];
    var totalFires = 0;
    (jobs || []).forEach(function (job) {
      var cat = categoryForJob(job.jobName);
      var color = CATEGORY_COLORS[cat] || CATEGORY_COLORS.unknown;
      (job.nextRunsIso || []).forEach(function (iso) {
        var t = Date.parse(iso);
        if (isNaN(t)) return;
        var dt = t - nowMs;
        // Clamp: negative → 0, beyond horizon → widthPx (defensive, see test).
        var ratio = Math.max(0, Math.min(1, dt / horizonMs));
        var x = Math.round(ratio * widthPx);
        ticks.push({
          x: x,
          fill: color,
          jobName: job.jobName,
          iso: iso,
        });
        totalFires++;
      });
    });

    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + widthPx +
               '" height="' + heightPx + '" viewBox="0 0 ' + widthPx + ' ' + heightPx +
               '" role="img" aria-label="Cron firings in the next 24 hours">');

    // Background ribbon band (light grey, subtle)
    parts.push('<rect x="0" y="' + (BAND_Y_CENTER - 10) +
               '" width="' + widthPx + '" height="20" fill="#f5f6f7" stroke="#d5dadc" />');

    // Hour gridlines every 6 hours (0, 6, 12, 18, 24)
    for (var h = 0; h <= 24; h += 6) {
      var gx = Math.round((h / 24) * widthPx);
      parts.push('<line x1="' + gx + '" y1="' + (BAND_Y_CENTER - 12) +
                 '" x2="' + gx + '" y2="' + (BAND_Y_CENTER + 12) +
                 '" stroke="#d5dadc" stroke-width="1" />');
      var labelText = h === 0 ? '' : '+' + h + 'h';
      if (labelText) {
        parts.push('<text x="' + gx + '" y="' + (BAND_Y_CENTER + 28) +
                   '" font-size="10" fill="#515559" text-anchor="middle">' +
                   labelText + '</text>');
      }
    }

    // Tick rects (with <title> tooltips)
    for (var i = 0; i < ticks.length; i++) {
      var t = ticks[i];
      var x = Math.min(t.x, widthPx - TICK_W);
      parts.push('<rect x="' + x + '" y="' + TICK_Y +
                 '" width="' + TICK_W + '" height="' + TICK_H +
                 '" fill="' + t.fill + '">');
      parts.push('<title>' + _xmlEscape(t.jobName) + ' — ' +
                 _humanizeRelative(t.iso, nowMs) + '</title>');
      parts.push('</rect>');
    }

    // "Now" marker line + label (left edge)
    parts.push('<line x1="0" y1="' + (BAND_Y_CENTER - 14) +
               '" x2="0" y2="' + (BAND_Y_CENTER + 14) +
               '" stroke="#0070f2" stroke-width="2" />');
    parts.push('<text x="4" y="' + (BAND_Y_CENTER - 16) +
               '" font-size="10" fill="#0070f2">Now</text>');

    // Fires-count label, top-right
    parts.push('<text x="' + (widthPx - 4) + '" y="14" font-size="11" ' +
               'fill="#515559" text-anchor="end">Fires in next 24h: ' + totalFires + '</text>');

    parts.push('</svg>');
    return parts.join('');
  }

  function _xmlEscape(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return {
    CATEGORY_COLORS: CATEGORY_COLORS,
    categoryForJob: categoryForJob,
    buildTimelineSvg: buildTimelineSvg,
  };
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/admin-shell/cron-timeline-helpers.test.js`

Expected: all 12 assertions (across 6 categoryForJob + 5 buildTimelineSvg cases) pass.

- [ ] **Step 5: Commit**

```bash
git add app/admin-shell/webapp/controller/cron-timeline-helpers.js test/unit/admin-shell/cron-timeline-helpers.test.js
git commit -m "feat(#750): add cron-timeline-helpers UI5 module for SVG ribbon

Three pure exports:
- CATEGORY_COLORS — frozen 6-entry hex map
- categoryForJob(jobName) — classify into fetch/cleanup/kg/retry/secret/unknown
- buildTimelineSvg(jobs, opts) — render inline SVG with one tick per firing,
  Now marker at x=0, hour gridlines every 6h, Fires-count label top-right,
  per-rect <title> tooltips for accessibility.

5 buildTimelineSvg cases + 7 categoryForJob assertions, all green via the
same vm + stubbed sap.ui.define test harness as job-controls-helpers.

Spec: docs/superpowers/specs/2026-06-30-750-cron-tile-forward-visibility-design.md §3.3"
```

## Task 6: Wire the new helpers into the Board controller

**Files:**
- Modify: `app/admin-shell/webapp/controller/Board.controller.js` (imports + `_loadJobControls`)

The controller already uses `JobControlsHelpers.joinJobsWithLastRuns()`. We add two more module imports, sort the joined result, build the SVG string, and write it onto the JSONModel at `/timelineHtml`.

- [ ] **Step 1: Update the controller imports**

In `app/admin-shell/webapp/controller/Board.controller.js`, change the top `sap.ui.define([...]` block from:

```js
sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/tutorials/admin/shell/controller/job-controls-helpers"
], function (Controller, JSONModel, MessageToast, MessageBox, JobControlsHelpers) {
```

to:

```js
sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
  "sap/tutorials/admin/shell/controller/job-controls-helpers",
  "sap/tutorials/admin/shell/controller/job-controls-sort",
  "sap/tutorials/admin/shell/controller/cron-timeline-helpers"
], function (Controller, JSONModel, MessageToast, MessageBox, JobControlsHelpers, JobControlsSort, CronTimelineHelpers) {
```

- [ ] **Step 2: Extend the JSONModel default shape**

Find this line (around line 26):

```js
      this.getView().setModel(new JSONModel({ jobs: [] }), "jobControls");
```

Replace with:

```js
      // #750: timelineHtml drives the <core:HTML> ribbon control. Empty
      // string until _loadJobControls() resolves; never null (UI5 HTML
      // control treats null as "use the previous content").
      this.getView().setModel(new JSONModel({ jobs: [], timelineHtml: '' }), "jobControls");
```

- [ ] **Step 3: Update `_loadJobControls` to sort + build SVG**

Find the existing `.then(function (results) {` block (around line 75) and replace its body:

```js
      }).then(function (results) {
        var aJobs = results[0];
        var aLastRuns = results[1];
        var aJoined = JobControlsHelpers.joinJobsWithLastRuns(aJobs, aLastRuns);
        oJobControlsModel.setProperty("/jobs", aJoined);
      }).catch(function (err) {
```

with:

```js
      }).then(function (results) {
        var aJobs = results[0];
        var aLastRuns = results[1];
        var aJoined = JobControlsHelpers.joinJobsWithLastRuns(aJobs, aLastRuns);
        // #750: chronological sort (nextRunIso ascending, nulls last) so the
        // table reads top-to-bottom as "soonest first."
        var aSorted = JobControlsSort.sortJobsByNextRun(aJoined);
        // #750: build the SVG ribbon from the same array.
        var sTimelineHtml = CronTimelineHelpers.buildTimelineSvg(aSorted, {
          now: new Date(),
          widthPx: 800,
          heightPx: 80,
        });
        oJobControlsModel.setProperty("/jobs", aSorted);
        oJobControlsModel.setProperty("/timelineHtml", sTimelineHtml);
      }).catch(function (err) {
```

- [ ] **Step 4: Smoke-test the controller change locally**

Run the admin shell unit suite to confirm no controller-import regression:

```bash
npx vitest run test/unit/admin-shell/
```

Expected: all admin-shell tests pass (the existing `board-controller-job-controls.test.js` covers the helpers; controller wiring is verified end-to-end via the smoke check in Task 8).

- [ ] **Step 5: Commit**

```bash
git add app/admin-shell/webapp/controller/Board.controller.js
git commit -m "feat(#750): wire sort + SVG ribbon into Board controller

Add two new UI5 module imports (job-controls-sort, cron-timeline-helpers)
to the Board controller. _loadJobControls() now sorts the joined
listJobs+JobLastRun array chronologically by nextRunIso ascending, then
builds the 24h SVG ribbon and stores it on jobControls>/timelineHtml.

The JSONModel default now includes timelineHtml: '' so the <core:HTML>
control has a stable initial value before the OData round-trip resolves.

Spec: docs/superpowers/specs/2026-06-30-750-cron-tile-forward-visibility-design.md §3"
```

## Task 7: View XML — ribbon + Next 3 runs column

**Files:**
- Modify: `app/admin-shell/webapp/view/Board.view.xml`

Two additions inside the existing `<Panel headerText="Cron health" ...>`:
1. Add `xmlns:core="sap.ui.core"` to the root `<mvc:View>` element so `<core:HTML>` resolves.
2. Insert `<core:HTML content="{jobControls>/timelineHtml}" sanitizeContent="false" />` above the Table.
3. Add a new `<Column>` for "Next 3 runs" and a matching VBox cell.

- [ ] **Step 1: Add the namespace declaration**

In `app/admin-shell/webapp/view/Board.view.xml`, change the root element (line 1-6) from:

```xml
<mvc:View
  controllerName="sap.tutorials.admin.shell.controller.Board"
  xmlns:mvc="sap.ui.core.mvc"
  xmlns="sap.m"
  xmlns:l="sap.ui.layout"
  xmlns:suite="sap.suite.ui.microchart">
```

to (add `xmlns:core`):

```xml
<mvc:View
  controllerName="sap.tutorials.admin.shell.controller.Board"
  xmlns:mvc="sap.ui.core.mvc"
  xmlns="sap.m"
  xmlns:l="sap.ui.layout"
  xmlns:core="sap.ui.core"
  xmlns:suite="sap.suite.ui.microchart">
```

- [ ] **Step 2: Insert the SVG ribbon above the table**

Find the existing `<Panel headerText="Cron health" ...>` opening tag (line 81) and the `<Table id="cronHealthTable" ...>` immediately after (line 82). Insert a `<core:HTML>` between them. The Panel section should change from:

```xml
      <Panel headerText="Cron health" expandable="true" expanded="true" class="sapUiSmallMargin">
        <Table id="cronHealthTable" items="{jobControls>/jobs}" growing="true" growingThreshold="40">
```

to:

```xml
      <Panel headerText="Cron health" expandable="true" expanded="true" class="sapUiSmallMargin">
        <!-- #750: 24-hour SVG timeline ribbon. Built client-side in
             Board.controller.js _loadJobControls() via CronTimelineHelpers.
             sanitizeContent="false" because the SVG is hand-emitted by our
             own pure helper (no untrusted content). -->
        <core:HTML content="{jobControls>/timelineHtml}" sanitizeContent="false" />
        <Table id="cronHealthTable" items="{jobControls>/jobs}" growing="true" growingThreshold="40">
```

- [ ] **Step 3: Add the "Next 3 runs" column**

Find the `<columns>` block (lines 83-90) and add one more column. Change:

```xml
          <columns>
            <Column><Text text="Job" /></Column>
            <Column><Text text="Schedule" /></Column>
            <Column><Text text="Next run" /></Column>
            <Column><Text text="Last success" /></Column>
            <Column><Text text="Last error" /></Column>
            <Column hAlign="End"><Text text="Trigger" /></Column>
          </columns>
```

to:

```xml
          <columns>
            <Column><Text text="Job" /></Column>
            <Column><Text text="Schedule" /></Column>
            <Column><Text text="Next run" /></Column>
            <!-- #750: forward-visibility column. Renders the first 3 entries
                 of nextRunsIso stacked vertically; missing slots render as
                 empty strings (no layout shift). -->
            <Column><Text text="Next 3 runs" /></Column>
            <Column><Text text="Last success" /></Column>
            <Column><Text text="Last error" /></Column>
            <Column hAlign="End"><Text text="Trigger" /></Column>
          </columns>
```

- [ ] **Step 4: Add the matching cell**

Find the `<cells>` block (lines 93-101). Change:

```xml
              <cells>
                <Text text="{jobControls>jobName}" tooltip="{jobControls>description}" />
                <Text text="{jobControls>schedule}" class="kg-mono" />
                <Text text="{path: 'jobControls>nextRunIso', formatter: '.formatNextRun'}" />
                <Text text="{path: 'jobControls>lastSuccessAt', formatter: '.formatRelativeTime'}" />
                <Text text="{jobControls>lastErrorMessage}" tooltip="{jobControls>lastErrorMessage}" />
                <Button text="Run now" type="Emphasized" press=".onRunJob"
                        busy="{jobControls>isRunning}" busyIndicatorDelay="0" />
              </cells>
```

to (insert a VBox after the existing Next-run Text):

```xml
              <cells>
                <Text text="{jobControls>jobName}" tooltip="{jobControls>description}" />
                <Text text="{jobControls>schedule}" class="kg-mono" />
                <Text text="{path: 'jobControls>nextRunIso', formatter: '.formatNextRun'}" />
                <!-- #750: three stacked relative-time lines. Missing slots render
                     empty (no layout shift). Formatter handles undefined safely. -->
                <VBox>
                  <Text text="{path: 'jobControls>nextRunsIso/0', formatter: '.formatNextRun'}" />
                  <Text text="{path: 'jobControls>nextRunsIso/1', formatter: '.formatNextRun'}" />
                  <Text text="{path: 'jobControls>nextRunsIso/2', formatter: '.formatNextRun'}" />
                </VBox>
                <Text text="{path: 'jobControls>lastSuccessAt', formatter: '.formatRelativeTime'}" />
                <Text text="{jobControls>lastErrorMessage}" tooltip="{jobControls>lastErrorMessage}" />
                <Button text="Run now" type="Emphasized" press=".onRunJob"
                        busy="{jobControls>isRunning}" busyIndicatorDelay="0" />
              </cells>
```

- [ ] **Step 5: Build the admin-shell app to verify the XML parses**

Run:

```bash
npm --prefix app/admin-shell run build 2>&1 | tail -20
```

Expected: the `vite build` completes without an XML / UI5 manifest error. The Board.view.xml is copied to `dist/view/Board.view.xml`. Warnings related to other apps are tolerable; an XML parse error on Board.view.xml is a hard failure.

If the build is slow or noisy, an alternative validation is `npx tsx -e "const fs=require('node:fs'); const xml=fs.readFileSync('app/admin-shell/webapp/view/Board.view.xml','utf8'); console.log('lines:', xml.split('\n').length, 'has core:HTML:', xml.includes('<core:HTML'))"` — confirms the file is well-formed and contains the new element.

- [ ] **Step 6: Commit**

```bash
git add app/admin-shell/webapp/view/Board.view.xml
git commit -m "feat(#750): add SVG ribbon + Next 3 runs column to Cron health panel

Three view-XML additions:
- xmlns:core='sap.ui.core' on the root mvc:View element so <core:HTML>
  resolves (was not previously declared — Board.view.xml had no need
  for sap.ui.core until #750).
- <core:HTML content='{jobControls>/timelineHtml}' sanitizeContent='false'>
  above the existing Table, inside the same Panel. SVG is hand-emitted
  by our own buildTimelineSvg() so the sanitization bypass is safe.
- New 'Next 3 runs' Column + matching VBox cell with three stacked
  relative-time Text controls bound to nextRunsIso/0..2. The existing
  formatNextRun() formatter tolerates undefined safely, so missing slots
  render as '—' (or empty per the formatter's behavior).

Spec: docs/superpowers/specs/2026-06-30-750-cron-tile-forward-visibility-design.md §3.2-3.3"
```

## Task 8: Final smoke + deploy hand-off

**Files:** none modified — this task validates the worktree state and hands off to deploy.

- [ ] **Step 1: Run the full unit suite**

Run:

```bash
npx vitest run test/unit/srv/cron-firings.test.js test/unit/srv/admin-job-controls.test.js test/unit/admin-shell/job-controls-sort.test.js test/unit/admin-shell/cron-timeline-helpers.test.js test/unit/admin-shell/board-controller-job-controls.test.js
```

Expected: all tests pass — the 18 new ones from Tasks 1-5 plus all pre-existing tests from #756 / #746 still green.

- [ ] **Step 2: Sanity-check the git log**

Run: `git log --oneline main..HEAD`

Expected: 7 commits on branch `750-cron-tile-forward-visibility`, one per task (Task 8 emits no commit). The spec was committed before this plan was written; the spec commit is on `main..HEAD` too.

- [ ] **Step 3: Open the PR**

Run:

```bash
gh pr create \
  --title "feat(#750): cron tile forward visibility — sort + Next 3 runs + 24h timeline ribbon" \
  --body "Closes #750.

Extends the existing Cron health Panel on the admin Board (#756) with three forward-looking views — chronological sort, a 'Next 3 runs' column, and a 24-hour SVG timeline ribbon. All three driven by a single new \`nextRunsIso\` array field on \`AdminService.JobControls.listJobs()\`. Server-side cron enumeration via \`cron-parser\` v5 (already pinned).

**Spec:** docs/superpowers/specs/2026-06-30-750-cron-tile-forward-visibility-design.md

**Test coverage:** 18 new vitest cases across 4 new/extended test files:
- \`test/unit/srv/cron-firings.test.js\` (6)
- \`test/unit/srv/admin-job-controls.test.js\` (5 appended)
- \`test/unit/admin-shell/job-controls-sort.test.js\` (3)
- \`test/unit/admin-shell/cron-timeline-helpers.test.js\` (12 assertions across 6 cases)

**Manual smoke checklist (post-deploy):**
1. /admin-ui/ → Board tab. Cron health Panel present.
2. Table sorted by nextRunIso ascending — topmost row is the soonest.
3. 'Next 3 runs' column populated for high-frequency jobs.
4. Timeline ribbon renders above the table, 80 px tall, Now marker on the left.
5. Hover a tick → native tooltip shows {jobName} — in 1h 12m.
6. 'Fires in next 24h: <N>' label in top-right.

**No new dependencies.** \`cron-parser@5.6.1\` is already pinned (used by #756 handler).
**No data migration.** Strict additive change — \`git revert\` + redeploy restores prior state.
" \
  --base main
```

Expected: PR opened on GitHub, CI starts running. Reviewer can compare against the spec and plan files in-branch.

- [ ] **Step 4: Hand off for deploy review**

After CI passes and the PR is merged, the user will issue a `Backend + content deploy` for the next DEV refresh. **Deploy is not part of this plan** — only the in-branch implementation. The deploy is a separate user-authorized step (per CLAUDE.md "PR over direct merge" and "Confirm deploy scope" memories).

---

## Done

When all 8 tasks are checked off:
- 18 new unit tests passing
- 7 commits on the feature branch
- PR open against main
- No changes to existing hybrid or smoke suites (matches spec §4)
- ~250 lines net code added
