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
