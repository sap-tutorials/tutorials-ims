// srv/lib/scheduler-boot-healthcheck.js
//
// #2762: post-boot scheduler-stall self-check + semi-automatic recovery.
//
// ─────────────────────────────────────────────────────────────────────
// Why this exists
// ─────────────────────────────────────────────────────────────────────
// A blue-green deploy of tutorials-srv can leave the shared CAP 10
// CronService queue processor STALLED after the operator resumes the
// traffic swap: the board shows "all jobs overdue, nothing running", yet
// manual Run-now works. Observed in PROD on 2026-10-12 and 2026-10-13.
//
// The failure surfaces ~26 min AFTER cutover — long after deploy-mta.cjs
// has exited (it pauses before the swap and never rejoins). So a CI/deploy
// step cannot catch it; the check has to live INSIDE the running srv.
//
// Per docs/developers/operations/scheduler-troubleshooting.md
// § "All jobs overdue — queue-processor stall", the only reliable fix is a
// rolling `cf restart tutorials-srv` of BOTH instances. On boot,
// CronService.init() re-runs schedule().every().as() for every registered
// job, re-seeding all outbox rows.
//
// ─────────────────────────────────────────────────────────────────────
// What this does (semi-automatic — issue #2762, "process.exit + alert")
// ─────────────────────────────────────────────────────────────────────
// Armed once per boot from CronService.init(). After a grace window
// (default 6 min — covers the metrics-rollup */5 period plus a boot/jitter
// margin), it reads JobLastRun for two high-frequency canary jobs:
//   - metrics-rollup     (*/5)
//   - kg-ondemand-drain  (*/2)
// If NEITHER canary has a success newer than the grace window, the queue is
// stalled: raise a loud ALERT (pointing at the runbook) and process.exit(1)
// so CF reschedules this instance.
//
// Requiring BOTH canaries to be stale avoids a false positive when a single
// job legitimately errors. A never-run canary (lastSuccessAt=null) is NOT
// treated as stale — a freshly booted instance hasn't fired either job yet.
//
// ─────────────────────────────────────────────────────────────────────
// Avoiding a joint outage + crash-loops (the design risks)
// ─────────────────────────────────────────────────────────────────────
// If both instances exited at once we'd get a brief total outage; if a
// restart never clears the stall we'd crash-loop. Three guards:
//   1. Per-instance STAGGER: instance N delays its exit by N × stagger
//      (default 90 s) so instances never exit SIMULTANEOUSLY. On the common
//      2-instance fleet instance 0 is typically back and re-seeding before
//      instance 1 fires; with >2 instances or a slow cold boot the stagger
//      only guarantees non-simultaneity, not continuous capacity.
//   2. ONE-SHOT per process: the check fires once ~grace after boot and
//      never re-arms within a process lifetime.
//   3. CRASH-LOOP BACKSTOP (the real safety net): a persisted self-restart
//      marker (a sentinel JobLastRun row). If this fleet already self-
//      restarted within a cooldown (default 30 min) and the stall persists,
//      we alert (SchedulerStallPersistent) but do NOT exit again — so a
//      structural (non-transient) stall degrades to loud alert-only instead
//      of an endless restart loop. This matters because UPSERT pre-seed has
//      PATCH semantics (cds >= 1.28): a reboot does NOT null lastSuccessAt,
//      so without the marker a persistent stall would re-trip every ~6 min.
//
// Fail-open throughout: any DB/entity/parse error → treat as healthy and
// never exit. A health check must never itself take the process down on a
// transient read fault.

import cds from '@sap/cds';

const LOG = cds.log('scheduler-healthcheck');

// The two highest-frequency jobs — the fastest, loudest signals that the
// shared queue is draining. Both must be stale to declare a stall.
export const CANARY_JOBS = ['metrics-rollup', 'kg-ondemand-drain'];

// 6 min: metrics-rollup fires every 5 min, so a healthy instance has a
// success within 5 min + jitter. 6 min is the smallest window that doesn't
// false-positive on the slower */5 canary right after boot.
export const _DEFAULT_GRACE_MS = 6 * 60 * 1000;

// Per-instance STAGGER between exits (default 90 s). The goal is to avoid
// a SIMULTANEOUS exit of all instances; it does not, on its own, guarantee
// "one instance always serving" — a cold CAP boot re-runs schedule().every()
// .as() for ~60 jobs and can take tens of seconds, so with >2 instances a
// later instance may still exit while an earlier one is re-initialising.
// 90 s is a looser budget than a bare reschedule; the crash-loop backstop
// below is the real safety net, not the stagger.
export const _DEFAULT_STAGGER_MS = 90 * 1000;

// #2762 crash-loop backstop. UPSERT pre-seed (scheduler.js:preSeedJobLastRun)
// has PATCH semantics (cds >= 1.28) — a reboot does NOT null lastSuccessAt — so
// a PERSISTENT (non-transient) stall would re-trip the 6-min check on every
// reboot and self-exit forever. We persist a self-restart marker (a sentinel
// JobLastRun row) and refuse to self-exit a SECOND time within this cooldown:
// fire once to recover the common transient case, then fall back to
// alert-only (operator finishes via the runbook) so no crash-loop forms.
// 30 min comfortably exceeds a boot + the 6-min grace, so a healthy reboot's
// own fresh canary successes clear the stall long before the cooldown lapses.
export const SELF_RESTART_MARKER = '__scheduler_selfheal__';
export const _DEFAULT_RESTART_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Pure core. Given JobLastRun-shaped rows for the canary jobs, decide
 * whether the queue is stalled.
 *
 * Stalled iff EVERY canary job is demonstrably stale — i.e. present with a
 * non-null lastSuccessAt STRICTLY older than `now - graceMs`. A missing or
 * null-lastSuccessAt canary is "never run", which is NOT evidence of a
 * stall (fail-open), so its absence makes the whole verdict healthy.
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
      // Canary absent → never run → not evidence of a stall. Healthy.
      return { stalled: false, reason: `${jobName} has no JobLastRun row (never run) — treating as healthy` };
    }
    const raw = byName.get(jobName);
    if (raw == null) {
      return { stalled: false, reason: `${jobName} has null lastSuccessAt (never run) — treating as healthy` };
    }
    const ts = raw instanceof Date ? raw : new Date(raw);
    if (isNaN(ts.getTime())) {
      // Unparseable timestamp → can't age it → fail-open healthy.
      return { stalled: false, reason: `${jobName} lastSuccessAt unparseable — treating as healthy` };
    }
    // Strictly older than cutoff is stale; exactly at the edge is fresh.
    if (ts.getTime() < cutoff) {
      staleDetail.push(`${jobName} last success ${ts.toISOString()}`);
    } else {
      // This canary is fresh → queue is draining → healthy, short-circuit.
      return { stalled: false, reason: `${jobName} is fresh (last success ${ts.toISOString()}) — queue draining` };
    }
  }

  return {
    stalled: true,
    reason: `all canaries stale past ${Math.round(graceMs / 60000)}m grace: ${staleDetail.join('; ')}`,
  };
}

/**
 * Per-instance exit delay. instance N waits N × staggerMs so instances
 * never exit simultaneously. Non-numeric index → 0 (fail-safe).
 *
 * @param {string|undefined} instanceIndex  CF_INSTANCE_INDEX
 * @param {number} staggerMs
 * @returns {number}
 */
export function staggerDelayMs(instanceIndex, staggerMs) {
  const n = Number.parseInt(instanceIndex, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n * staggerMs;
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

function graceMsFromEnv(env = process.env) {
  const v = Number.parseInt(env.SCHEDULER_HEALTHCHECK_GRACE_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : _DEFAULT_GRACE_MS;
}

function staggerMsFromEnv(env = process.env) {
  const v = Number.parseInt(env.SCHEDULER_HEALTHCHECK_STAGGER_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : _DEFAULT_STAGGER_MS;
}

function cooldownMsFromEnv(env = process.env) {
  const v = Number.parseInt(env.SCHEDULER_HEALTHCHECK_COOLDOWN_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : _DEFAULT_RESTART_COOLDOWN_MS;
}

/**
 * Read the canary JobLastRun rows. Fail-open: any error → [] (healthy).
 */
async function loadCanaryRows() {
  try {
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const db = await cds.connect.to('db');
    const rows = await db.run(
      SELECT.from(JobLastRun).columns('jobName', 'lastSuccessAt').where({ jobName: { in: CANARY_JOBS } })
    );
    return rows || [];
  } catch (err) {
    LOG.warn(`loadCanaryRows failed (treating as healthy): ${err.message ?? err}`);
    return [];
  }
}

/**
 * #2762 crash-loop backstop — persistence of the self-restart marker in the
 * existing JobLastRun table (no new entity / migration). The sentinel row's
 * lastSuccessAt is the timestamp of the last self-restart on this fleet.
 *
 * Default `wasRecentlyRestarted`: true iff the sentinel's lastSuccessAt is
 * within `cooldownMs` of now. Throws propagate to the caller, which treats a
 * marker-read fault as "not recently restarted" (fail toward recovery of the
 * common transient case).
 */
async function markerLastRestartAt() {
  const { JobLastRun } = cds.entities('com.sap.developers.ims');
  const db = await cds.connect.to('db');
  const row = await db.run(
    SELECT.one.from(JobLastRun).columns('lastSuccessAt').where({ jobName: SELF_RESTART_MARKER })
  );
  const raw = row?.lastSuccessAt ?? null;
  if (raw == null) return null;
  const ts = raw instanceof Date ? raw : new Date(raw);
  return isNaN(ts.getTime()) ? null : ts;
}

async function defaultWasRecentlyRestarted(now, cooldownMs) {
  const last = await markerLastRestartAt();
  if (last == null) return false;
  return (now.getTime() - last.getTime()) < cooldownMs;
}

async function defaultRecordRestart(now) {
  const { JobLastRun } = cds.entities('com.sap.developers.ims');
  const db = await cds.connect.to('db');
  // UPSERT would leave lastSuccessAt untouched on an existing row (PATCH
  // semantics), so SELECT-then-UPDATE-or-INSERT to actually bump the marker.
  const existing = await db.run(
    SELECT.one.from(JobLastRun).columns('jobName').where({ jobName: SELF_RESTART_MARKER })
  );
  if (existing) {
    await db.run(UPDATE(JobLastRun).set({ lastSuccessAt: now }).where({ jobName: SELF_RESTART_MARKER }));
  } else {
    await db.run(INSERT.into(JobLastRun).entries({ jobName: SELF_RESTART_MARKER, lastSuccessAt: now }));
  }
}

/**
 * Run the stall check once and remediate if stalled. Extracted from the
 * timer body so tests can drive it with injected seams and no real timers.
 *
 * @param {object} deps
 * @param {() => Promise<Array>} deps.loadRows
 * @param {(input:object) => Promise<unknown>} deps.raiseAlert
 * @param {(code:number) => void} deps.exit
 * @param {() => Date} [deps.now]
 * @param {number} deps.graceMs
 * @param {(now:Date, cooldownMs:number) => Promise<boolean>} [deps.wasRecentlyRestarted]
 * @param {(now:Date) => Promise<unknown>} [deps.recordRestart]
 * @param {number} [deps.cooldownMs]
 * @returns {Promise<{stalled:boolean, reason:string}>}
 */
export async function runStallCheckOnce({
  loadRows,
  raiseAlert,
  exit,
  now = () => new Date(),
  graceMs,
  wasRecentlyRestarted = defaultWasRecentlyRestarted,
  recordRestart = defaultRecordRestart,
  cooldownMs = _DEFAULT_RESTART_COOLDOWN_MS,
}) {
  let rows = [];
  try {
    rows = await loadRows();
  } catch (err) {
    LOG.warn(`stall check loadRows threw (treating as healthy): ${err.message ?? err}`);
    return { stalled: false, reason: 'loadRows threw — healthy' };
  }

  const nowTs = now();
  const verdict = evaluateCanaries(rows, nowTs, graceMs);
  if (!verdict.stalled) {
    LOG.info(`scheduler boot health check OK — ${verdict.reason}`);
    return verdict;
  }

  const instanceIndex = process.env.CF_INSTANCE_INDEX ?? '?';

  // Crash-loop backstop: if this fleet already self-restarted within the
  // cooldown, the restart did NOT clear the stall — it's persistent, not the
  // transient blue-green case. Alert (so an operator sees it) but do NOT exit
  // again. A marker-read fault fails toward recovery (proceed with the exit).
  let recentlyRestarted = false;
  try {
    recentlyRestarted = await wasRecentlyRestarted(nowTs, cooldownMs);
  } catch (err) {
    LOG.warn(`restart-cooldown check failed (proceeding with restart): ${err.message ?? err}`);
    recentlyRestarted = false;
  }

  const instanceIndexLabel = instanceIndex;
  if (recentlyRestarted) {
    const body =
      `Scheduler queue processor STILL appears stalled on instance ${instanceIndexLabel} ` +
      `(${verdict.reason}) AFTER a self-restart within the last ${Math.round(cooldownMs / 60000)}m. ` +
      `The auto-restart did NOT clear it — this is a PERSISTENT stall, not a transient cutover artefact. ` +
      `Suppressing further self-restarts to avoid a crash-loop. Investigate and recover manually: ` +
      `disable with SCHEDULER_HEALTHCHECK_ENABLED=false if needed, then do a rolling restart of BOTH instances. ` +
      `Runbook: docs/developers/operations/scheduler-troubleshooting.md § "All jobs overdue — queue-processor stall".`;
    LOG.error(`#2762 PERSISTENT scheduler stall on instance ${instanceIndexLabel} (already self-restarted within cooldown) — alerting WITHOUT exit`);
    try {
      await raiseAlert({
        eventType: 'SchedulerStallPersistent',
        severity: 'ERROR',
        category: 'ALERT',
        subject: `Scheduler stall PERSISTS after auto-restart on instance ${instanceIndexLabel} — manual recovery needed`,
        body,
        resource: { resourceName: 'cron-service-queue', resourceType: 'scheduler' },
      });
    } catch (err) {
      LOG.warn(`persistent-stall alert failed: ${err.message ?? err}`);
    }
    return verdict;
  }

  const body =
    `Scheduler queue processor appears STALLED after boot on instance ${instanceIndexLabel} ` +
    `(${verdict.reason}). This instance is self-restarting to re-seed the outbox. ` +
    `If the board still shows all jobs overdue, perform a rolling restart of BOTH instances: ` +
    `cf restart-app-instance tutorials-srv 0 (wait healthy) then 1. ` +
    `Runbook: docs/developers/operations/scheduler-troubleshooting.md § "All jobs overdue — queue-processor stall".`;

  LOG.error(`#2762 scheduler stall detected on instance ${instanceIndexLabel}: ${verdict.reason} — raising alert and exiting`);

  // Record the self-restart marker BEFORE exiting so the cooldown is in effect
  // for the next boot (the exit is immediate — a post-exit write would be lost).
  try {
    await recordRestart(nowTs);
  } catch (err) {
    LOG.warn(`recordRestart failed (self-restart proceeds, cooldown may not persist): ${err.message ?? err}`);
  }

  // Alert next (fail-open), THEN exit — so a slow/failing alert can't leave
  // the stall un-remediated. Await best-effort with its own guard.
  try {
    await raiseAlert({
      eventType: 'SchedulerStallDetected',
      severity: 'ERROR',
      category: 'ALERT',
      subject: `Scheduler stall after deploy — self-restarting instance ${instanceIndexLabel}`,
      body,
      resource: { resourceName: 'cron-service-queue', resourceType: 'scheduler' },
    });
  } catch (err) {
    LOG.warn(`stall-detected alert failed (exiting anyway): ${err.message ?? err}`);
  }

  exit(1);
  return verdict;
}

/**
 * Arm the one-shot self-check from CronService.init(). No-op (returns null)
 * when disabled. Returns the timer handle (unref'd) when armed, so a test
 * harness or shutdown path can clear it.
 *
 * @param {object} [opts]
 * @param {Record<string,string|undefined>} [opts.env=process.env]
 * @param {(input:object)=>Promise<unknown>} [opts.raiseAlert]
 * @param {(code:number)=>void} [opts.exit]
 * @param {(fn:Function, ms:number)=>any} [opts.setTimeoutFn=setTimeout]
 * @param {()=>Promise<Array>} [opts.loadRows=loadCanaryRows]
 * @returns {any|null} timer handle, or null when disabled
 */
export function scheduleBootHealthCheck(opts = {}) {
  const env = opts.env ?? process.env;
  if (!isHealthCheckEnabled(env)) {
    LOG.info('scheduler boot health check disabled (not on CF / explicitly off)');
    return null;
  }

  const graceMs = graceMsFromEnv(env);
  const staggerMs = staggerMsFromEnv(env);
  const cooldownMs = cooldownMsFromEnv(env);
  const delay = graceMs + staggerDelayMs(env.CF_INSTANCE_INDEX, staggerMs);
  const setTimeoutFn = opts.setTimeoutFn ?? setTimeout;

  const raiseAlert = opts.raiseAlert ?? (async (input) => {
    const alerting = await import('./alerting.js');
    return alerting.raise(input);
  });
  const exit = opts.exit ?? ((code) => process.exit(code));
  const loadRows = opts.loadRows ?? loadCanaryRows;

  LOG.info(
    `scheduler boot health check armed: fires in ${Math.round(delay / 1000)}s ` +
    `(grace ${Math.round(graceMs / 60000)}m + stagger for instance ${env.CF_INSTANCE_INDEX ?? '?'})`
  );

  const handle = setTimeoutFn(() => {
    runStallCheckOnce({ loadRows, raiseAlert, exit, graceMs, cooldownMs })
      .catch((err) => LOG.warn(`scheduler boot health check threw (ignored): ${err.message ?? err}`));
  }, delay);

  // Never keep the event loop alive for this timer.
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}
