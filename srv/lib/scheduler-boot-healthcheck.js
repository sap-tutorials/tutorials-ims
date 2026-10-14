// srv/lib/scheduler-boot-healthcheck.js
//
// #2762 → #2782: PURE canary-stall evaluator + enablement gate.
//
// ─────────────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────────────
// #2762 shipped a post-boot self-check that, ~6 min after boot, read two
// high-frequency canary jobs and, if BOTH were stale, raised an ALERT and
// `process.exit(1)`'d to force a CF reschedule. The 2026-10-14 PROD incident
// (#2782) showed that self-restart does NOT durably recover the fleet: the
// real stall is a NULL-lastAttemptTimestamp outbox tombstone CAP's 1h lease
// cannot reclaim (see srv/lib/scheduler-reaper.js for the full root cause). A
// restart can't clear that row, and re-running CronService.init() churns the
// outbox (deterministic-ID UPSERTs) on every bounce.
//
// #2782 makes the outbox reaper the primary recovery and reduces this module
// to its still-useful pure parts: the canary truth table and the enablement
// gate. The periodic timer that consumes them — and raises the (now ALERT-ONLY,
// no-exit) SchedulerStallDetected alert — lives in scheduler-reaper.js
// (armSchedulerSelfHeal). The exit / per-instance stagger / crash-loop cooldown
// / self-restart marker machinery is gone.

// The two highest-frequency jobs — the fastest, loudest signals that the
// shared queue is draining. Both must be stale to declare a stall.
export const CANARY_JOBS = ['metrics-rollup', 'kg-ondemand-drain'];

// 6 min: metrics-rollup fires every 5 min, so a healthy instance has a success
// within 5 min + jitter. 6 min is the smallest window that doesn't
// false-positive on the slower */5 canary.
export const _DEFAULT_GRACE_MS = 6 * 60 * 1000;

/**
 * Pure core. Given JobLastRun-shaped rows for the canary jobs, decide whether
 * the queue looks stalled.
 *
 * Stalled iff EVERY canary job is demonstrably stale — present with a non-null
 * lastSuccessAt STRICTLY older than `now - graceMs`. A missing or null-
 * lastSuccessAt canary is "never run", which is NOT evidence of a stall
 * (fail-open), so its absence makes the whole verdict healthy. Requiring BOTH
 * canaries to be stale avoids a false positive when a single job legitimately
 * errors.
 *
 * @param {Array<{jobName:string,lastSuccessAt:Date|string|null}>} rows
 * @param {Date} now
 * @param {number} graceMs
 * @returns {{stalled:boolean, reason:string}}
 */
export function evaluateCanaries(rows, now, graceMs) {
  const byName = new Map();
  for (const r of rows || []) {
    if (r && typeof r.jobName === 'string') byName.set(r.jobName, r.lastSuccessAt);
  }

  const cutoff = now.getTime() - graceMs;
  const staleDetail = [];

  for (const jobName of CANARY_JOBS) {
    if (!byName.has(jobName)) {
      return { stalled: false, reason: `${jobName} has no JobLastRun row (never run) — treating as healthy` };
    }
    const raw = byName.get(jobName);
    if (raw == null) {
      return { stalled: false, reason: `${jobName} has null lastSuccessAt (never run) — treating as healthy` };
    }
    const ts = raw instanceof Date ? raw : new Date(raw);
    if (isNaN(ts.getTime())) {
      return { stalled: false, reason: `${jobName} lastSuccessAt unparseable — treating as healthy` };
    }
    // Strictly older than cutoff is stale; exactly at the edge is fresh.
    if (ts.getTime() < cutoff) {
      staleDetail.push(`${jobName} last success ${ts.toISOString()}`);
    } else {
      return { stalled: false, reason: `${jobName} is fresh (last success ${ts.toISOString()}) — queue draining` };
    }
  }

  return {
    stalled: true,
    reason: `all canaries stale past ${Math.round(graceMs / 60000)}m grace: ${staleDetail.join('; ')}`,
  };
}

/**
 * Enablement gate. On by default on CF (CF_INSTANCE_INDEX present), off
 * locally. SCHEDULER_HEALTHCHECK_ENABLED=true|false explicitly overrides.
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {boolean}
 */
export function isHealthCheckEnabled(env = process.env) {
  const explicit = env.SCHEDULER_HEALTHCHECK_ENABLED;
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return env.CF_INSTANCE_INDEX != null;
}
