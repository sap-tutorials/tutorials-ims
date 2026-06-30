# Cron Tile Forward Visibility — Design Spec

- **Status:** Draft for review
- **Tracking issue:** [#750](https://github.com/sap-tutorials/tutorials-ims/issues/750)
- **Date:** 2026-06-30
- **Author:** Tom Jung (with Claude)
- **Related:**
  - [#756](https://github.com/sap-tutorials/tutorials-ims/issues/756) — `AdminService.JobControls` singleton with `listJobs()` + `runJob()` and the existing Cron health tile
  - [#746](https://github.com/sap-tutorials/tutorials-ims/issues/746) — `JobLastRun` entity that drives the "Last success / Last error" columns
  - [docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md](./2026-06-29-756-admin-cron-trigger.md)

## Summary

Extend the existing **Cron health** Panel on the admin Board ([app/admin-shell/webapp/view/Board.view.xml:81](../../../app/admin-shell/webapp/view/Board.view.xml#L81)) with two forward-looking improvements:

1. **Chronological sort + "next N runs" per job** — table rows ordered by `nextRunIso` ascending, plus a new column showing the next 3 firings stacked per job.
2. **24-hour timeline ribbon** — a single-row horizontal SVG strip above the table, with one tick per firing in the next 24 hours, color-coded by job category.

Both views consume a single new field, `nextRunsIso: array of String`, added to the existing `AdminService.JobControls.listJobs()` action's return shape. Cron expression enumeration happens server-side via the `cron-parser` library; the client renders both views from the same array.

**No new page, no new route, no new top-level admin nav entry.** Everything lives inside the existing Cron health Panel.

## Goals

1. **Aggregated forward visibility.** The existing tile shows per-job `Next run` as a column but provides no aggregated view ("what's the next 24 hours look like across all 17 jobs in chronological order?"). The timeline ribbon answers that at a glance.
2. **Imminent-job clarity.** The current table is in registration order, so `account-merge-job` sorts first regardless of when it next fires. Chronological sort surfaces what's about to happen.
3. **Per-job preview.** "Next 3 runs" column gives quick visibility into high-frequency jobs (`extract-concepts` hourly, `cleanup` every 15 min, etc.) without forcing operators to mentally expand cron expressions.
4. **Single source of truth.** Both views consume `nextRunsIso` from `listJobs()`. One cron parser on the server, never two parsers drifting.

## Non-Goals

- **A new monitoring page or top-level admin nav entry.** The existing Cron health Panel is the home. The page-vs-tile decision is locked: extension, not replacement.
- **Swimlane multi-row timeline** (option B from Q4 brainstorming) — duplicates table info. Premature.
- **Hour-of-day or weekly heatmap** (option C from Q2 brainstorming) — answers a different question (cadence patterns) than the imminent-firings view. Revisit if the ribbon ever feels insufficient.
- **Live-ticking "NOW" marker.** Updates on tile-load only; no animation. The data refreshes on the existing 5-min polling cadence that `_loadJobControls()` already uses post-trigger.
- **Alerts / notifications** when a job hasn't succeeded in N hours. `JobLastRun.lastErrorAt` already drives the existing "Last error" column. Alerting is its own design.
- **Admin schedule overrides** (changing cron expressions from the UI). `JOB_REGISTRY` is code-only. Runtime overrides would need a separate runtime-settings tile.
- **Per-job detail page** with full historical run timeline. The operations app's `JobExecutionLog` list/detail already covers history.
- **Changes to `AdminService.JobControls.runJob()` or the existing `Run now` button.** Manual-trigger plumbing is untouched.

## Approach

### Backend change

**One additive field** on the existing `listJobs()` action and **one new pure helper** for cron enumeration.

#### Action signature change

[srv/admin-service.cds:266-272](../../../srv/admin-service.cds#L266-L272) — add one field:

```cds
action listJobs() returns array of {
  jobName     : String;
  schedule    : String;
  ttlMs       : Integer;
  description : String;
  nextRunIso  : String;
  nextRunsIso : array of String;   // ← new: ISO timestamps in UTC, oldest to newest, cap min(50, next 24h)
};
```

Old clients ignore the new field. New clients use it.

#### Handler change

[srv/admin-service.js:2161-2180](../../../srv/admin-service.js#L2161-L2180) — extend the existing `this.on('listJobs', 'JobControls', ...)` handler to populate `nextRunsIso`. The current implementation already wraps the cron-parser call in try/catch with `LOG.warn` for resilience against bad `JOB_REGISTRY` schedules — **preserve that guard**:

```js
import { enumerateFiringsWithinWindow, nextRunIsoFrom } from './lib/cron-firings.js';

this.on('listJobs', 'JobControls', async () => {
  const registry = _getJobRegistry();
  const now = new Date();
  const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  return Array.from(registry.values()).map(job => {
    let nextRunsIso = [];
    let nextRunIso = null;
    try {
      nextRunsIso = enumerateFiringsWithinWindow(job.schedule, now, horizon, 50);
      // fires[0] when the next firing is in-window; fallback only when empty
      // (monthly cron like '23 4 1 * *' has zero in-window firings but still
      // has a real next time we want to surface in the Table column).
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

Failure semantics: if a schedule fails to parse, both `nextRunIso` (null) and `nextRunsIso` (`[]`) reflect that, matching the existing #756 contract — the row still renders, just without forward visibility for that job.

#### New helper module

[srv/lib/cron-firings.js](../../../srv/lib/cron-firings.js) (new) — pure functions, testable in isolation. Uses the **same `cron-parser` v5 API** already used by [srv/admin-service.js:34](../../../srv/admin-service.js#L34) — `import { CronExpressionParser } from 'cron-parser'` then `CronExpressionParser.parse(schedule, { tz: 'UTC', currentDate: from })`:

```js
import { CronExpressionParser } from 'cron-parser';

/**
 * Enumerate cron firings within a time window.
 * @param schedule  Cron expression (5-field, matching node-cron).
 * @param from      Window start (exclusive — `from` itself is not a firing).
 * @param to        Window end (inclusive).
 * @param cap       Hard limit on returned timestamps.
 * @returns         ISO timestamp strings (UTC), oldest to newest.
 *
 * NOTE: matches the v5 API used elsewhere in the codebase. `tz: 'UTC'`
 * matches CF's UTC runtime and the existing #756 handler.
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
 * outside the 24h window enumerated by enumerateFiringsWithinWindow().
 */
export function nextRunIsoFrom(schedule, from) {
  return CronExpressionParser.parse(schedule, { tz: 'UTC', currentDate: from })
    .next().toDate().toISOString();
}
```

**Why `cron-parser`, not `node-cron`:** `node-cron` is a scheduler — it fires callbacks but doesn't expose a "give me the next N timestamps" API. `cron-parser` is the canonical Node library for forward enumeration. Already pinned at `cron-parser@5.6.1` in `package.json` (used by the existing #756 handler), so no new dependency.

**Cap rationale (`min(50, next-24h)`)**:
- 24h matches the timeline ribbon's horizon.
- 50 caps the worst-case payload (a `* * * * *` job in a 24h window would produce 1,440 firings — clearly excessive).
- For a `*/5` job (288 firings/24h), the cap shows the first 4.2 hours. Past that, ribbon ticks would have merged into a solid block anyway.
- For a monthly cron, `nextRunsIso` is `[]` if no firing falls in the 24h window. Acceptable; `nextRunIso` still populated via the fallback.

### Frontend changes

All in the existing Cron health Panel — no new view or controller files at the route level, plus two new client helper modules.

#### 3.1 Chronological sort

[app/admin-shell/webapp/controller/Board.controller.js](../../../app/admin-shell/webapp/controller/Board.controller.js) — in the existing `_loadJobControls()`, after `JobControlsHelpers.joinJobsWithLastRuns(aJobs, aLastRuns)`, sort by `nextRunIso` ascending. Null (no upcoming run) sorts to the bottom.

Sort function extracted to a new pure helper at [app/admin-shell/webapp/controller/job-controls-sort.js](../../../app/admin-shell/webapp/controller/job-controls-sort.js) (new file, sibling of the existing `job-controls-helpers.js` — keeps the sort independently unit-testable).

#### 3.2 "Next 3 runs" column

[Board.view.xml:81-105](../../../app/admin-shell/webapp/view/Board.view.xml#L81) — one new `<Column>` in the `<columns>` list and one new `VBox` cell in the `<ColumnListItem>`. Renders first three items of `nextRunsIso` stacked vertically, formatted as relative time ("in 4h 12m") via the existing/extended `formatRelativeFuture` helper.

For jobs whose `nextRunsIso.length < 3`, the missing rows render as empty strings (no layout shift).

#### 3.3 24-hour timeline ribbon

[Board.view.xml](../../../app/admin-shell/webapp/view/Board.view.xml) — new `<core:HTML id="cronTimelineRibbon" content="{jobControls>/timelineHtml}" />` placed inside the Panel, above the Table.

Controller-side, after the listJobs join completes, build the SVG string via the new helper:

```js
var jobs = aJoined; // already sorted
var timelineSvg = CronTimelineHelpers.buildTimelineSvg(jobs, { now: new Date(), widthPx: 800, heightPx: 60 });
oJobControlsModel.setProperty('/timelineHtml', timelineSvg);
```

**Why SVG-via-`<core:HTML>`, not a chart library**: max ~850 `<rect>` elements (17 jobs × 50-firing cap). Trivial for the browser. UI5's `sap.viz.ui5` chart library would add ~200 KB for rectangles on a horizontal axis. Inline SVG is right-sized.

**Ribbon visual specs**:
- Container: full Panel width, 80 px tall (60 px ribbon band + 20 px for time labels above).
- Time scale: linear, `NOW` at x=0, `+24h` at x=widthPx.
- Tick: 3 px wide × 14 px tall, vertically centered.
- "NOW" marker: 2 px vertical line at x=0 in `--sap-brand-color`, with a small "Now" text label.
- Fires-count: top-right corner, "Fires in next 24h: 312" in 11 px text.

**Category color map** (in a new helper [app/admin-shell/webapp/controller/cron-timeline-helpers.js](../../../app/admin-shell/webapp/controller/cron-timeline-helpers.js)):

```js
var CATEGORY_COLORS = {
  fetch:    '#4078b8',  // fetch-{learning-journeys,blog-posts,discovery-missions,videos,api-docs,samples}
  cleanup:  '#888888',  // cleanup, gc-external-content
  kg:       '#9a4dbb',  // extract-concepts, consolidate-concepts, embedding-reconciliation
  retry:    '#d29922',  // ngds-retry, account-merge, mail-retry
  secret:   '#3fb950',  // secret-expiry-check, homepage-link-health
  unknown:  '#888888',  // fallback
};
function categoryForJob(jobName) {
  if (jobName.startsWith('fetch-')) return 'fetch';
  if (jobName.startsWith('cleanup') || jobName === 'gc-external-content') return 'cleanup';
  if (jobName.includes('concept') || jobName.includes('embedding')) return 'kg';
  if (jobName.includes('retry') || jobName.includes('merge')) return 'retry';
  if (jobName.includes('secret') || jobName.includes('health')) return 'secret';
  return 'unknown';
}
```

5 categories + fallback covers all 17 current jobs. Future jobs default to grey until added to the map.

**Hover tooltip**: each `<rect>` has a child `<title>` element. Native browser semantics — no JS event handlers, accessible to screen readers:

```svg
<rect x="123" y="33" width="3" height="14" fill="#4078b8">
  <title>fetch-blog-posts fires at 4:17 PM (in 1h 12m)</title>
</rect>
```

### Pure helper signatures

[srv/lib/cron-firings.js](../../../srv/lib/cron-firings.js):
- `enumerateFiringsWithinWindow(schedule: string, from: Date, to: Date, cap: number): string[]`
- `nextRunIsoFrom(schedule: string, from: Date): string`

[app/admin-shell/webapp/controller/cron-timeline-helpers.js](../../../app/admin-shell/webapp/controller/cron-timeline-helpers.js):
- `buildTimelineSvg(jobs: Array<{jobName: string, nextRunsIso: string[]}>, opts: {now: Date, widthPx: number, heightPx: number}): string`
- `categoryForJob(jobName: string): string`
- Export `CATEGORY_COLORS` as a const

[app/admin-shell/webapp/controller/job-controls-sort.js](../../../app/admin-shell/webapp/controller/job-controls-sort.js) (new file — keeps the sort independently unit-testable):
- `sortJobsByNextRun(jobs: Array): Array` — sorts in place by `nextRunIso` ascending, nulls last.

## Testing strategy

### Unit tests — server-side cron enumeration

[test/unit/cron-firings.test.js](../../../test/unit/cron-firings.test.js) (new):
1. `enumerateFiringsWithinWindow('*/5 * * * *', t, t+60min, 50)` → 12 timestamps, 5 min apart, monotonic.
2. Same with `cap=3` → exactly 3 timestamps.
3. `enumerateFiringsWithinWindow('23 4 1 * *', currentJun30, +24h, 50)` → `[]`.
4. `enumerateFiringsWithinWindow('* * * * *', t, t+24h, 50)` → exactly 50 (cap, not 1440).
5. Window-exclusive lower bound: first firing at exactly `from` is excluded.

Pure helper, no CAP server needed.

### Unit tests — server-side listJobs handler

Extend `test/unit/admin-listJobs.test.js` (or create) with in-memory `cds.test('serve')`:
1. Existing fields still present.
2. `nextRunsIso` is array of ISO timestamps all within next 24h.
3. `nextRunsIso[0] === nextRunIso` for jobs whose next run is within 24h.
4. Monthly cron: `nextRunIso` populated via fallback, `nextRunsIso === []`.
5. `nextRunsIso.length <= 50` always.

### Unit tests — client-side helpers

[app/admin-shell/test/unit/cron-timeline-helpers.test.js](../../../app/admin-shell/test/unit/cron-timeline-helpers.test.js) (new):
1. `categoryForJob('fetch-blog-posts')` → `'fetch'`, with one assertion per category (6 cases incl. fallback).
2. `buildTimelineSvg([], {...})` → SVG contains "Now" marker, "Fires in next 24h: 0" label, zero `<rect>`.
3. Two jobs (fetch + cleanup), 3 firings each → 6 `<rect>` with correct fill colors per category.
4. A firing 12h from now → tick at 50% of widthPx (linear scale).
5. Per-rect `<title>` child contains jobName and a human time.

[app/admin-shell/test/unit/job-controls-sort.test.js](../../../app/admin-shell/test/unit/job-controls-sort.test.js) (new):
1. Mixed array with some `nextRunIso = null` → nulls sort to bottom.
2. Mixed ascending/descending input → ascending output.
3. Equal `nextRunIso` values → stable order preserved.

### Hybrid test

No new hybrid test. `listJobs()` reads from `JOB_REGISTRY` (in-memory) plus `JobLastRun` (HANA). The HANA join is already covered by the existing hybrid coverage. The new `nextRunsIso` field is pure CPU work via cron-parser; no HANA round-trip.

### Manual smoke (post-deploy)

After PR deploys:
1. `/admin-ui/` → Board tab. Cron health Panel present.
2. Table sorted by `nextRunIso` ascending — topmost row's "Next run" is the soonest.
3. "Next 3 runs" column populated for high-frequency jobs.
4. Timeline ribbon renders above the table, ~80 px tall, "Now" marker on the left.
5. Tick density: a `*/5` job's first 4.2 hours shows as dense cluster on the left third.
6. At least 2-3 category colors visible.
7. Hover a tick → native tooltip shows `{jobName} fires at {time}`.
8. "Fires in next 24h: <N>" label in top-right.

## Risks & rollback

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `cron-parser` v5 API surface changes between minor versions | Low | Low | `cron-parser@5.6.1` is already pinned (used by #756 handler). Helper uses the exact same `CronExpressionParser.parse(schedule, { tz: 'UTC' })` pattern — symmetric with the existing call site, so any future v5→v6 upgrade fixes both at once. |
| Bad cron expression in `JOB_REGISTRY` throws inside `listJobs()` | Low | Med | Handler preserves the existing `try/catch` with `LOG.warn` (matches #756). Both `nextRunIso` and `nextRunsIso` default to `null` / `[]` for the offending job — row still renders. |
| `cron-parser` disagrees with `node-cron` on edge cases (DST, last-Sun-of-month) | Low | Low | Schedules in `JOB_REGISTRY` use standard 5-field syntax with no uncommon escapes. CF runs UTC (no DST). |
| Bumping `listJobs()` return shape breaks existing callers | Low | Low | Only one caller: `Board.controller.js _callListJobs()`. UI5 OData binding ignores unknown fields. |
| SVG ribbon renders weirdly on small/large viewports | Med | Low | Default 800 px width; `<core:HTML>` is full Panel width. CSS sets `svg { width: 100%; height: 80px; }`. Geometry is data-driven from `widthPx`. |
| Tick density obscures readability for `*/5` jobs (clusters into solid block) | Low | Low | Intended visual signal — "this hour is busy." Per-job precision still available via "Next 3 runs" column. Hover-tooltip on each tick gives exact times. |
| Browser tooltip hover not keyboard-accessible | Low | Low | SVG `<title>` IS read by screen readers; keyboard focus on `<rect>` would need `tabindex`. Table column already provides keyboard-accessible firing times. |
| 50-firing cap makes high-frequency job appear to "stop" mid-window | Low | Low | Visual ribbon shows what's there. Table column shows next 3 (also bounded). For `*/5`, 50 firings = 4.2 hours of visibility — surfaces the realistic horizon clearly. |

### Rollback

Strict additive change:
1. New `nextRunsIso` field is opt-in; clients that don't read it are unaffected.
2. New `cron-firings.js` helper is a leaf module; no other code imports it yet.
3. Existing `nextRunIso` continues to work identically.
4. `git revert <merge-sha>` on `main` + redeploy restores the pre-PR state. No data state to roll back.

If only one piece misbehaves (e.g., ribbon renders wrong but sort + Next-3-runs work fine), the client can be patched in a follow-up PR without reverting the server change.

## Build sequence

**One PR.**

### PR: `feat(#750): cron tile forward visibility — chronological sort + next 3 runs + 24h timeline ribbon`

**Files changed (~10 files, ~250 lines net):**

| File | Change |
|---|---|
| `srv/lib/cron-firings.js` (new) | Pure helper using cron-parser v5 `CronExpressionParser.parse` API, ~25 lines |
| `srv/admin-service.cds:266-272` | +1 line: `nextRunsIso : array of String` |
| `srv/admin-service.js:2161-2180` | Handler extended to populate `nextRunsIso`. ~15 line delta (preserves try/catch). |
| `app/admin-shell/webapp/controller/cron-timeline-helpers.js` (new) | `buildTimelineSvg()` + `categoryForJob()` + color map. ~80 lines |
| `app/admin-shell/webapp/controller/job-controls-sort.js` (new) | Pure sort function. ~15 lines |
| `app/admin-shell/webapp/controller/Board.controller.js` | Sort in `_loadJobControls()`, compute timelineHtml. ~25 lines delta |
| `app/admin-shell/webapp/view/Board.view.xml:82` | Add `<core:HTML>` ribbon, add `Next 3 runs` column. ~10 lines |
| `test/unit/cron-firings.test.js` (new) | 5 server-side tests, ~60 lines |
| `test/unit/admin-listJobs.test.js` (extend or new) | 5 handler tests, ~80 lines |
| `app/admin-shell/test/unit/cron-timeline-helpers.test.js` (new) | 5 client helper tests, ~70 lines |
| `app/admin-shell/test/unit/job-controls-sort.test.js` (new) | 3 sort tests, ~30 lines |

**Effort estimate:**
- `cron-firings.js` + unit tests: ~30 min
- `listJobs` handler extension + tests: ~30 min
- `cron-timeline-helpers.js` + unit tests: ~60 min (SVG geometry most fiddly)
- `Board.controller.js` + `Board.view.xml` changes + tests: ~45 min
- Smoke-verify on DEV: ~10 min

**Total: ~3 hours active engineering** + ~20 min deploy wall-clock via canonical MTA flow.

## Decisions made during brainstorming

1. **Scope: extension, not replacement.** Existing Cron health tile is the home; no new page, no new admin nav entry. (Q1 outcome.)
2. **Forward visibility additions: A + B** — chronological sort + next-3-runs column AND 24-hour timeline ribbon. Hour-of-day heatmap and swimlane multi-row timeline rejected as premature. (Q2 outcome.)
3. **Cron enumeration: server-side, single source of truth.** `listJobs()` action gains `nextRunsIso: array of String`. Client renders both views from this single field. No client-side cron parsing. (Q3 outcome.)
4. **Timeline visual: single-row ribbon with category-color ticks.** Density 3-px ticks, 80-px tall ribbon, top-right "Fires in next 24h" count label, native SVG `<title>` tooltips. Swimlane multi-row treatment rejected. (Q4 outcome.)
