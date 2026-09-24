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
let sortJobsByName;
let sortJobs;

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
  sortJobsByName = captured.sortJobsByName;
  sortJobs = captured.sortJobs;
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

describe('sortJobsByName (#2488)', () => {
  it('sorts ascending, case-insensitive, by jobName', () => {
    const input = [
      { jobName: 'zeta' },
      { jobName: 'Alpha' },
      { jobName: 'beta' },
    ];
    const result = sortJobsByName(input);
    expect(result.map(r => r.jobName)).toEqual(['Alpha', 'beta', 'zeta']);
  });

  it('sorts missing/non-string jobName to the bottom, stable', () => {
    const input = [
      { jobName: 'b' },
      { /* no jobName */ },
      { jobName: 'a' },
      { jobName: null },
    ];
    const result = sortJobsByName(input);
    expect(result.map(r => r.jobName)).toEqual(['a', 'b', undefined, null]);
  });

  it('preserves stable order for equal names (case-insensitive tie)', () => {
    const input = [
      { jobName: 'Job', tag: 1 },
      { jobName: 'job', tag: 2 },
      { jobName: 'JOB', tag: 3 },
    ];
    const result = sortJobsByName(input);
    expect(result.map(r => r.tag)).toEqual([1, 2, 3]);
  });

  it('does not mutate the input array', () => {
    const input = [{ jobName: 'b' }, { jobName: 'a' }];
    sortJobsByName(input);
    expect(input.map(r => r.jobName)).toEqual(['b', 'a']);
  });

  it('returns [] for null/undefined input', () => {
    expect(sortJobsByName(null)).toEqual([]);
    expect(sortJobsByName(undefined)).toEqual([]);
  });
});

describe('sortJobs dispatcher (#2488)', () => {
  const jobs = [
    { jobName: 'zeta',  nextRunIso: '2026-07-01T09:00:00.000Z' },
    { jobName: 'alpha', nextRunIso: '2026-07-01T15:00:00.000Z' },
  ];

  it("key 'name' sorts alphabetically", () => {
    expect(sortJobs(jobs, 'name').map(r => r.jobName)).toEqual(['alpha', 'zeta']);
  });

  it("key 'date' sorts chronologically", () => {
    expect(sortJobs(jobs, 'date').map(r => r.jobName)).toEqual(['zeta', 'alpha']);
  });

  it('defaults to date for unknown/missing key', () => {
    expect(sortJobs(jobs).map(r => r.jobName)).toEqual(['zeta', 'alpha']);
    expect(sortJobs(jobs, 'bogus').map(r => r.jobName)).toEqual(['zeta', 'alpha']);
  });
});
