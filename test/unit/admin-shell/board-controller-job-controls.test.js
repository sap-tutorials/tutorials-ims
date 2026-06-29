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
let formatNextRun;
let formatRelativeTime;

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
  };
  vm.createContext(context);
  vm.runInContext(src, context, { filename: HELPER_PATH });
  if (!captured) throw new Error('job-controls-helpers.js did not register a factory');
  joinJobsWithLastRuns = captured.joinJobsWithLastRuns;
  formatNextRun = captured.formatNextRun;
  formatRelativeTime = captured.formatRelativeTime;
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
