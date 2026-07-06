// Unit tests for the pure helpers extracted from Board.controller.js for #756.
//
// UI5 controllers are not unit-testable outside the OPA5 / qunit harness, so
// the JOIN logic + formatters that drive the Cron health tile's
// listJobs() + JobLastRun extension live in a pure helper module and are
// exercised here. The controller methods are thin wrappers that delegate to
// these helpers; controller-method-in-context coverage lives with OPA5 (out of
// scope for #756).
//
// The helper file is a UI5 `sap.ui.define` module (so the UI5 loader can
// import it from the controller). To exercise it in vitest we read the source
// off disk, stub `sap.ui.define` to capture the factory return, and evaluate
// inside a node vm context. The factory body is pure ES5 — no UI5 framework
// calls inside — so the captured object is the bare helpers we want to test.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HELPER_PATH = path.resolve(
  __dirname,
  '../../../app/admin-shell/webapp/controller/job-controls-helpers.js'
);

let joinJobsWithLastRuns;
let classifyJobStatus;
let formatNextRun;
let formatRelativeTime;
let formatElapsedSince;

beforeAll(() => {
  const src = readFileSync(HELPER_PATH, 'utf8');
  let captured;
  const context = {
    sap: {
      ui: {
        define(_deps, factory) {
          captured = factory();
        },
      },
    },
    Map,
    Object,
    Number,
    String,
    Date,
    Math,
    Array,
    Boolean,
  };
  vm.createContext(context);
  vm.runInContext(src, context, { filename: HELPER_PATH });
  if (!captured) throw new Error('job-controls-helpers.js did not register a factory');
  joinJobsWithLastRuns = captured.joinJobsWithLastRuns;
  classifyJobStatus = captured.classifyJobStatus;
  formatNextRun = captured.formatNextRun;
  formatRelativeTime = captured.formatRelativeTime;
  formatElapsedSince = captured.formatElapsedSince;
});

describe('joinJobsWithLastRuns', () => {
  it('joins listJobs + JobLastRun by jobName; defaults missing rows to null', () => {
    const jobs = [
      { jobName: 'a', schedule: '0 0 * * *', ttlMs: 1000, description: 'job a', nextRunIso: '2026-06-30T00:00:00.000Z' },
      { jobName: 'b', schedule: '0 1 * * *', ttlMs: 1000, description: 'job b', nextRunIso: '2026-06-30T01:00:00.000Z' },
    ];
    const lastRuns = [
      { jobName: 'a', lastSuccessAt: '2026-06-29T12:00:00Z', lastErrorAt: null, lastErrorMessage: null },
    ];
    const out = joinJobsWithLastRuns(jobs, lastRuns);
    expect(out).toHaveLength(2);
    expect(out[0].jobName).toBe('a');
    expect(out[0].lastSuccessAt).toBe('2026-06-29T12:00:00Z');
    expect(out[0].isRunning).toBe(false);
    // b had no JobLastRun row → defaults to null.
    expect(out[1].jobName).toBe('b');
    expect(out[1].lastSuccessAt).toBeNull();
    expect(out[1].lastErrorMessage).toBeNull();
  });

  it('handles empty + null inputs gracefully', () => {
    expect(joinJobsWithLastRuns([], [])).toEqual([]);
    expect(joinJobsWithLastRuns(null, null)).toEqual([]);
    expect(joinJobsWithLastRuns(null, null, null)).toEqual([]);
  });

  // #1023: runningNow flips isRunning true regardless of last-run state.
  it('marks isRunning:true when jobName appears in runningNow', () => {
    const jobs = [{ jobName: 'a', schedule: '0 0 * * *' }];
    const lastRuns = [];
    const runningNow = [{ jobName: 'a', startedAt: '2026-07-06T18:08:46Z' }];
    const out = joinJobsWithLastRuns(jobs, lastRuns, runningNow);
    expect(out[0].isRunning).toBe(true);
    expect(out[0].runningSince).toBe('2026-07-06T18:08:46Z');
    expect(out[0].statusLabel).toBe('RUNNING');
    expect(out[0].statusState).toBe('Information');
  });

  // #1023: the core UX bug — a re-triggered job that had previously failed
  // must not display the old error while running.
  it('RUNNING trumps last-known-failed', () => {
    const jobs = [{ jobName: 'extractConcepts', schedule: '0 3 * * *' }];
    const lastRuns = [{
      jobName: 'extractConcepts',
      lastSuccessAt: '2026-07-01T03:00:00Z',
      lastErrorAt: '2026-07-04T03:00:00Z',
      lastErrorMessage: 'No deploymentId for SAP AI Hub call',
    }];
    const runningNow = [{ jobName: 'extractConcepts', startedAt: '2026-07-06T18:08:46Z' }];
    const out = joinJobsWithLastRuns(jobs, lastRuns, runningNow);
    expect(out[0].isRunning).toBe(true);
    expect(out[0].statusLabel).toBe('RUNNING');
    // last-error fields still carried through — the view surfaces them in
    // separate columns; RUNNING only overrides the Status column.
    expect(out[0].lastErrorMessage).toBe('No deploymentId for SAP AI Hub call');
  });

  it('omits isRunning when runningNow is provided but jobName absent', () => {
    const jobs = [{ jobName: 'a' }, { jobName: 'b' }];
    const runningNow = [{ jobName: 'b', startedAt: '2026-07-06T18:00:00Z' }];
    const out = joinJobsWithLastRuns(jobs, [], runningNow);
    expect(out[0].isRunning).toBe(false);
    expect(out[0].runningSince).toBeNull();
    expect(out[1].isRunning).toBe(true);
    expect(out[1].runningSince).toBe('2026-07-06T18:00:00Z');
  });
});

// #1023: categorical Status column classification.
describe('classifyJobStatus', () => {
  const NOW = new Date('2026-07-06T20:00:00Z').getTime();

  it('RUNNING trumps everything', () => {
    const s = classifyJobStatus({ isRunning: true, lastErrorAt: '2026-07-04T00:00:00Z' }, NOW);
    expect(s).toEqual({ statusLabel: 'RUNNING', statusState: 'Information' });
  });

  it('NEVER when there is neither success nor error', () => {
    const s = classifyJobStatus({ isRunning: false }, NOW);
    expect(s).toEqual({ statusLabel: 'NEVER', statusState: 'None' });
  });

  it('FAILED when lastErrorAt is more recent than lastSuccessAt', () => {
    const s = classifyJobStatus({
      isRunning: false,
      lastSuccessAt: '2026-07-05T00:00:00Z',
      lastErrorAt: '2026-07-06T00:00:00Z',
    }, NOW);
    expect(s).toEqual({ statusLabel: 'FAILED', statusState: 'Error' });
  });

  it('OK when last success is within 2× interval (daily default)', () => {
    // Successful yesterday, no error; interval defaults to 24h since
    // nextRunsIso has fewer than 2 entries. 20h ago < 48h threshold.
    const s = classifyJobStatus({
      isRunning: false,
      lastSuccessAt: new Date(NOW - 20 * 3600 * 1000).toISOString(),
    }, NOW);
    expect(s).toEqual({ statusLabel: 'OK', statusState: 'Success' });
  });

  it('STALE when last success is older than 2× interval', () => {
    // Successful 3 days ago; interval defaults to 24h → threshold 48h. Stale.
    const s = classifyJobStatus({
      isRunning: false,
      lastSuccessAt: new Date(NOW - 3 * 24 * 3600 * 1000).toISOString(),
    }, NOW);
    expect(s).toEqual({ statusLabel: 'STALE', statusState: 'Warning' });
  });

  it('uses nextRunsIso[1]-nextRunsIso[0] as the interval estimate', () => {
    // Hourly schedule (2 firings in nextRunsIso spaced 1h apart) → threshold 2h.
    // Last success 3h ago → STALE despite being well under a day old.
    const now = NOW;
    const nextRunsIso = [
      new Date(now + 15 * 60000).toISOString(),  // in 15 min
      new Date(now + 75 * 60000).toISOString(),  // in 75 min → 1h interval
    ];
    const s = classifyJobStatus({
      isRunning: false,
      lastSuccessAt: new Date(now - 3 * 3600 * 1000).toISOString(),
      nextRunsIso,
    }, now);
    expect(s.statusLabel).toBe('STALE');
  });
});

describe('formatElapsedSince', () => {
  it('returns "" for null / invalid / future timestamps', () => {
    expect(formatElapsedSince(null)).toBe('');
    expect(formatElapsedSince('not-a-date')).toBe('');
    const future = new Date(Date.now() + 60000).toISOString();
    expect(formatElapsedSince(future)).toBe('');
  });

  it('returns "Ns" for sub-minute durations', () => {
    const iso = new Date(Date.now() - 42000).toISOString();
    expect(formatElapsedSince(iso)).toMatch(/^\d{1,2}s$/);
  });

  it('returns "Nm Ss" for minute-scale durations', () => {
    const iso = new Date(Date.now() - (5 * 60000 + 23000)).toISOString();
    expect(formatElapsedSince(iso)).toMatch(/^5m \d{1,2}s$/);
  });

  it('returns "Nh Nm" for hour-scale durations', () => {
    const iso = new Date(Date.now() - (2 * 3600000 + 15 * 60000)).toISOString();
    expect(formatElapsedSince(iso)).toMatch(/^2h \d{1,2}m$/);
  });
});

describe('formatNextRun', () => {
  it('returns "—" for null or invalid date strings', () => {
    expect(formatNextRun(null)).toBe('—');
    expect(formatNextRun('not a date')).toBe('—');
  });

  it('returns "in N hours" for < 24h away', () => {
    const oneHourFromNow = new Date(Date.now() + 3600000).toISOString();
    const out = formatNextRun(oneHourFromNow);
    expect(out).toMatch(/in 1 hour/);
  });

  it('returns "Day HH:MM UTC" for >= 24h away', () => {
    const fortyEightHoursFromNow = new Date(Date.now() + 48 * 3600000).toISOString();
    const out = formatNextRun(fortyEightHoursFromNow);
    expect(out).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2} UTC$/);
  });

  it('returns "overdue" for past timestamps', () => {
    const past = new Date(Date.now() - 3600000).toISOString();
    expect(formatNextRun(past)).toBe('overdue');
  });
});

describe('formatRelativeTime', () => {
  it('returns "Never" for null or invalid date strings', () => {
    expect(formatRelativeTime(null)).toBe('Never');
    expect(formatRelativeTime('not a date')).toBe('Never');
  });

  it('returns "N minutes ago" for recent timestamps', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toMatch(/5 minutes ago/);
  });

  it('returns "N hours ago" for hour-scale timestamps', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
    expect(formatRelativeTime(twoHoursAgo)).toMatch(/2 hours ago/);
  });
});
