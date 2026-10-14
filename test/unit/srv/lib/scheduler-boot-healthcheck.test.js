// test/unit/srv/lib/scheduler-boot-healthcheck.test.js
//
// #2762 → #2782: the post-boot scheduler-stall self-check is now ALERT-ONLY.
//
// History: #2762 shipped a self-check that, ~6 min after boot, read two
// high-frequency canary jobs (metrics-rollup */5, kg-ondemand-drain */2) and,
// if BOTH were stale, raised an ALERT and `process.exit(1)`'d to force a CF
// reschedule. In the 2026-10-14 PROD incident that self-restart did NOT durably
// recover the fleet — the real stall is a NULL-lastAttemptTimestamp outbox
// tombstone CAP's lease can't reclaim (see srv/lib/scheduler-reaper.js), which
// a restart cannot clear and whose re-run of CronService.init() churns the
// outbox further. #2782 therefore makes the reaper primary recovery and strips
// the exit/stagger/cooldown/marker machinery from this module: it is now just
// the PURE canary evaluator + enablement gate, consumed by the reaper's
// periodic self-heal tick which raises the alert (alert-only, no exit).
//
// These tests cover the surviving pure surface. The alert-raising + timer
// wiring now lives in scheduler-reaper.test.js.

import { describe, it, expect } from 'vitest';

import {
  evaluateCanaries,
  isHealthCheckEnabled,
  CANARY_JOBS,
  _DEFAULT_GRACE_MS,
} from '../../../../srv/lib/scheduler-boot-healthcheck.js';

describe('#2782 scheduler-boot-healthcheck — evaluateCanaries (pure)', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  const fresh = new Date(now.getTime() - 60_000);          // 1 min ago
  const stale = new Date(now.getTime() - 20 * 60_000);     // 20 min ago

  it('flags a stall when BOTH canaries are stale', () => {
    const rows = CANARY_JOBS.map((jobName) => ({ jobName, lastSuccessAt: stale }));
    expect(evaluateCanaries(rows, now, _DEFAULT_GRACE_MS).stalled).toBe(true);
  });

  it('reports healthy when EITHER canary is fresh (avoids one-job-error false positive)', () => {
    const rows = [
      { jobName: CANARY_JOBS[0], lastSuccessAt: fresh },
      { jobName: CANARY_JOBS[1], lastSuccessAt: stale },
    ];
    expect(evaluateCanaries(rows, now, _DEFAULT_GRACE_MS).stalled).toBe(false);
  });

  it('reports healthy when BOTH canaries are fresh', () => {
    const rows = CANARY_JOBS.map((jobName) => ({ jobName, lastSuccessAt: fresh }));
    expect(evaluateCanaries(rows, now, _DEFAULT_GRACE_MS).stalled).toBe(false);
  });

  it('fail-open: empty rows → healthy (never a false positive from a read miss)', () => {
    expect(evaluateCanaries([], now, _DEFAULT_GRACE_MS).stalled).toBe(false);
  });

  it('fail-open: a canary with null lastSuccessAt is treated as never-run, not stalled', () => {
    const rows = CANARY_JOBS.map((jobName) => ({ jobName, lastSuccessAt: null }));
    expect(evaluateCanaries(rows, now, _DEFAULT_GRACE_MS).stalled).toBe(false);
  });

  it('a boundary-fresh canary (exactly at the grace edge) is NOT stale', () => {
    const edge = new Date(now.getTime() - _DEFAULT_GRACE_MS);
    const rows = CANARY_JOBS.map((jobName) => ({ jobName, lastSuccessAt: edge }));
    expect(evaluateCanaries(rows, now, _DEFAULT_GRACE_MS).stalled).toBe(false);
  });
});

describe('#2782 scheduler-boot-healthcheck — isHealthCheckEnabled (gate)', () => {
  it('enabled by default on CF (CF_INSTANCE_INDEX present)', () => {
    expect(isHealthCheckEnabled({ CF_INSTANCE_INDEX: '0' })).toBe(true);
  });

  it('disabled locally (no CF_INSTANCE_INDEX)', () => {
    expect(isHealthCheckEnabled({})).toBe(false);
  });

  it('explicit SCHEDULER_HEALTHCHECK_ENABLED=false overrides the CF default', () => {
    expect(isHealthCheckEnabled({ CF_INSTANCE_INDEX: '0', SCHEDULER_HEALTHCHECK_ENABLED: 'false' })).toBe(false);
  });

  it('explicit SCHEDULER_HEALTHCHECK_ENABLED=true forces it on locally (for test rigs)', () => {
    expect(isHealthCheckEnabled({ SCHEDULER_HEALTHCHECK_ENABLED: 'true' })).toBe(true);
  });
});
