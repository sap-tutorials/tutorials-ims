// test/unit/srv/lib/scheduler-boot-healthcheck.test.js
//
// #2762: post-boot scheduler-stall self-check.
//
// A blue-green cutover can leave the shared CAP 10 CronService queue
// processor stalled AFTER the operator resumes the traffic swap — by
// which point the deploy script has already exited. The only reliable
// recovery (per docs/developers/operations/scheduler-troubleshooting.md
// § "All jobs overdue — queue-processor stall") is a rolling restart of
// BOTH srv instances.
//
// This module arms a one-shot self-check ~6 min after boot: if neither
// high-frequency canary job (metrics-rollup */5, kg-ondemand-drain */2)
// has completed within the grace window, the detecting instance raises a
// loud ALERT and exits so CF reschedules it. A per-instance stagger means
// instance 0 exits first and is back (re-seeding the outbox) before
// instance 1's timer fires — the rolling-restart-of-both the runbook
// requires, without a joint outage.
//
// These unit tests exercise the PURE core (truth table, stagger, gate).
// The timer-arming + process.exit path is covered by the behavioural test
// below with injected clock/exit/alert seams — no real timers, no real exit.

import { describe, it, expect, vi } from 'vitest';

import {
  evaluateCanaries,
  staggerDelayMs,
  isHealthCheckEnabled,
  runStallCheckOnce,
  scheduleBootHealthCheck,
  CANARY_JOBS,
  _DEFAULT_GRACE_MS,
  _DEFAULT_STAGGER_MS,
} from '../../../../srv/lib/scheduler-boot-healthcheck.js';

describe('#2762 scheduler-boot-healthcheck — evaluateCanaries (pure)', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  const fresh = new Date(now.getTime() - 60_000);          // 1 min ago
  const stale = new Date(now.getTime() - 20 * 60_000);     // 20 min ago

  it('flags a stall when BOTH canaries are stale', () => {
    const rows = CANARY_JOBS.map((jobName) => ({ jobName, lastSuccessAt: stale }));
    const verdict = evaluateCanaries(rows, now, _DEFAULT_GRACE_MS);
    expect(verdict.stalled).toBe(true);
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

  it('fail-open: a canary with null lastSuccessAt is treated as never-run, not stalled on its own', () => {
    // Only ONE canary present and it has never run — the OTHER canary is
    // absent (also never-run). Requiring BOTH to be *demonstrably stale*
    // means a brand-new JobLastRun row set (both null) must NOT self-exit:
    // a freshly-booted instance hasn't had time to fire either job yet.
    const rows = CANARY_JOBS.map((jobName) => ({ jobName, lastSuccessAt: null }));
    expect(evaluateCanaries(rows, now, _DEFAULT_GRACE_MS).stalled).toBe(false);
  });

  it('a boundary-fresh canary (exactly at the grace edge) is NOT stale', () => {
    const edge = new Date(now.getTime() - _DEFAULT_GRACE_MS);
    const rows = CANARY_JOBS.map((jobName) => ({ jobName, lastSuccessAt: edge }));
    // At exactly grace ms old, treat as still-within-window (healthy).
    expect(evaluateCanaries(rows, now, _DEFAULT_GRACE_MS).stalled).toBe(false);
  });
});

describe('#2762 scheduler-boot-healthcheck — staggerDelayMs (pure)', () => {
  it('instance 0 has zero stagger (exits first)', () => {
    expect(staggerDelayMs('0', _DEFAULT_STAGGER_MS)).toBe(0);
  });

  it('instance N is delayed by N × stagger', () => {
    expect(staggerDelayMs('1', _DEFAULT_STAGGER_MS)).toBe(_DEFAULT_STAGGER_MS);
    expect(staggerDelayMs('2', _DEFAULT_STAGGER_MS)).toBe(2 * _DEFAULT_STAGGER_MS);
  });

  it('a non-numeric index falls back to 0 (fail-safe, never NaN)', () => {
    expect(staggerDelayMs(undefined, _DEFAULT_STAGGER_MS)).toBe(0);
    expect(staggerDelayMs('not-a-number', _DEFAULT_STAGGER_MS)).toBe(0);
  });
});

describe('#2762 scheduler-boot-healthcheck — isHealthCheckEnabled (gate)', () => {
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

describe('#2762 scheduler-boot-healthcheck — runStallCheckOnce (remediation)', () => {
  const now = () => new Date('2026-10-14T12:00:00Z');
  const stale = new Date('2026-10-14T11:40:00Z');   // 20 min ago
  const fresh = new Date('2026-10-14T11:59:00Z');   // 1 min ago

  const allStaleRows = () => CANARY_JOBS.map((jobName) => ({ jobName, lastSuccessAt: stale }));
  const allFreshRows = () => CANARY_JOBS.map((jobName) => ({ jobName, lastSuccessAt: fresh }));

  it('on a stall: raises exactly one ALERT then exits(1)', async () => {
    const raiseAlert = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const verdict = await runStallCheckOnce({
      loadRows: async () => allStaleRows(),
      raiseAlert, exit, now, graceMs: _DEFAULT_GRACE_MS,
    });

    expect(verdict.stalled).toBe(true);
    expect(raiseAlert).toHaveBeenCalledTimes(1);
    expect(raiseAlert.mock.calls[0][0]).toMatchObject({
      eventType: 'SchedulerStallDetected',
      severity: 'ERROR',
      category: 'ALERT',
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('raises the alert BEFORE exiting (ordering: remediation never lost to a slow alert)', async () => {
    const order = [];
    const raiseAlert = vi.fn().mockImplementation(async () => { order.push('alert'); });
    const exit = vi.fn().mockImplementation(() => { order.push('exit'); });
    await runStallCheckOnce({
      loadRows: async () => allStaleRows(),
      raiseAlert, exit, now, graceMs: _DEFAULT_GRACE_MS,
    });
    expect(order).toEqual(['alert', 'exit']);
  });

  it('still exits when the alert itself throws (fail-open on alert, not on remediation)', async () => {
    const raiseAlert = vi.fn().mockRejectedValue(new Error('ANS down'));
    const exit = vi.fn();
    await runStallCheckOnce({
      loadRows: async () => allStaleRows(),
      raiseAlert, exit, now, graceMs: _DEFAULT_GRACE_MS,
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('on a healthy queue: NO alert, NO exit', async () => {
    const raiseAlert = vi.fn();
    const exit = vi.fn();
    const verdict = await runStallCheckOnce({
      loadRows: async () => allFreshRows(),
      raiseAlert, exit, now, graceMs: _DEFAULT_GRACE_MS,
    });
    expect(verdict.stalled).toBe(false);
    expect(raiseAlert).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('fail-open: loadRows throwing → NO alert, NO exit (never self-destruct on a read fault)', async () => {
    const raiseAlert = vi.fn();
    const exit = vi.fn();
    const verdict = await runStallCheckOnce({
      loadRows: async () => { throw new Error('HANA unreachable'); },
      raiseAlert, exit, now, graceMs: _DEFAULT_GRACE_MS,
    });
    expect(verdict.stalled).toBe(false);
    expect(raiseAlert).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  // #2762 crash-loop backstop. UPSERT pre-seed has PATCH semantics (cds >=1.28),
  // so a reboot does NOT null lastSuccessAt — a PERSISTENT (non-transient) stall
  // would otherwise re-trip the check every ~6 min forever. A persisted
  // self-restart marker gates the exit: fire once, then alert-only until cooldown.
  it('persistent stall: records a restart marker and exits on the FIRST detection', async () => {
    const recordRestart = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    await runStallCheckOnce({
      loadRows: async () => allStaleRows(),
      raiseAlert: async () => {}, exit, now, graceMs: _DEFAULT_GRACE_MS,
      wasRecentlyRestarted: async () => false,   // no prior restart in cooldown
      recordRestart,
    });
    expect(recordRestart).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('persistent stall within cooldown: alerts but does NOT exit again (breaks the crash-loop)', async () => {
    const raiseAlert = vi.fn().mockResolvedValue(undefined);
    const recordRestart = vi.fn();
    const exit = vi.fn();
    const verdict = await runStallCheckOnce({
      loadRows: async () => allStaleRows(),
      raiseAlert, exit, now, graceMs: _DEFAULT_GRACE_MS,
      wasRecentlyRestarted: async () => true,    // we already self-restarted recently
      recordRestart,
    });
    expect(verdict.stalled).toBe(true);
    expect(raiseAlert).toHaveBeenCalledTimes(1);   // operator still gets told
    expect(recordRestart).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();           // no second exit → no loop
  });

  it('a cooldown-check that throws fails SAFE — proceeds with the restart (transient recovery preferred)', async () => {
    const recordRestart = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    await runStallCheckOnce({
      loadRows: async () => allStaleRows(),
      raiseAlert: async () => {}, exit, now, graceMs: _DEFAULT_GRACE_MS,
      wasRecentlyRestarted: async () => { throw new Error('marker read failed'); },
      recordRestart,
    });
    // A read fault on the marker must NOT suppress recovery of the common
    // (transient) case — exit proceeds.
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('#2762 scheduler-boot-healthcheck — scheduleBootHealthCheck (arming)', () => {
  it('returns null and arms nothing when disabled', () => {
    const setTimeoutFn = vi.fn();
    const handle = scheduleBootHealthCheck({ env: {}, setTimeoutFn });
    expect(handle).toBeNull();
    expect(setTimeoutFn).not.toHaveBeenCalled();
  });

  it('arms a single timer at grace + stagger for the instance when enabled', () => {
    const setTimeoutFn = vi.fn().mockReturnValue({ unref: () => {} });
    scheduleBootHealthCheck({
      env: { CF_INSTANCE_INDEX: '1', SCHEDULER_HEALTHCHECK_ENABLED: 'true' },
      setTimeoutFn,
      raiseAlert: vi.fn(),
      exit: vi.fn(),
      loadRows: async () => [],
    });
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    const delay = setTimeoutFn.mock.calls[0][1];
    expect(delay).toBe(_DEFAULT_GRACE_MS + _DEFAULT_STAGGER_MS); // instance 1 → +1×stagger
  });

  it('instance 0 arms at exactly the grace window (zero stagger)', () => {
    const setTimeoutFn = vi.fn().mockReturnValue({ unref: () => {} });
    scheduleBootHealthCheck({
      env: { CF_INSTANCE_INDEX: '0', SCHEDULER_HEALTHCHECK_ENABLED: 'true' },
      setTimeoutFn,
      raiseAlert: vi.fn(),
      exit: vi.fn(),
      loadRows: async () => [],
    });
    expect(setTimeoutFn.mock.calls[0][1]).toBe(_DEFAULT_GRACE_MS);
  });
});
