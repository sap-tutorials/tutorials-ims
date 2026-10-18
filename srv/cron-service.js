// srv/cron-service.js
//
// Internal scheduling bus. Owns the scheduler lifecycle:
//   1. registerJobs()          — populates JOB_REGISTRY (32 entries)
//   2. For each job in the registry:
//      - this.on('cron.<jobName>', () => runJobByName(jobName))
//      - this.schedule('cron.<jobName>', {}).every(job.schedule).as(job.jobName)
//
// Migration spec: docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md
// Issue: #958

import cds from '@sap/cds';
import {
  _getJobRegistry,
  registerJobs,
  runJobByName,
} from './jobs/scheduler.js';
import { reconcileOrphanedRunningJobs } from './lib/pipeline-log-reconciler.js';
import { reapTombstonedOutboxRows, armSchedulerSelfHeal } from './lib/scheduler-reaper.js';

const LOG = cds.log('cron-service');

export default class CronService extends cds.ApplicationService {
  async init() {
    // Owned entirely by CronService now — the srv/server.js call to
    // registerJobs() was removed in Commit 2 of this migration. The
    // size==0 guard remains as belt-and-suspenders against re-entry
    // (registerJob throws on duplicate jobName; the guard prevents that
    // from ever surfacing in test fixtures that reuse the module).
    if (_getJobRegistry().size === 0) {
      registerJobs();
    } else {
      LOG.info(`JOB_REGISTRY already populated (${_getJobRegistry().size} entries); skipping registerJobs()`);
    }

    // Wire one handler + one schedule() call per registered job.
    for (const job of _getJobRegistry().values()) {
      const eventName = `cron.${job.jobName}`;
      this.on(eventName, () => runJobByName(job.jobName));
      await this.schedule(eventName, {})
        .every(job.schedule)
        .as(job.jobName);
    }
    LOG.info(`CronService wired ${_getJobRegistry().size} scheduled jobs via CAP scheduling API`);

    // #1293: boot-time reconciler. A scheduled job that was executing when
    // the srv process last died (deploy restart, crash, `cf stop`) leaves
    // its PipelineLog row stuck at RUNNING — runWithLock's finally never
    // ran. Distinct from the #1021 outbox wedge (that cleans
    // cds.outbox.Messages; this cleans the PipelineLog health-tile row).
    // Fail-open: never throws, so a DB hiccup here can't crash boot.
    // Deferred to the next tick so it never blocks super.init() /
    // schedule registration; a slow reconcile SELECT can't delay serving.
    setImmediate(() => {
      reconcileOrphanedRunningJobs()
        .then(({ closed }) => {
          if (closed > 0) LOG.info(`boot reconcile closed ${closed} orphaned RUNNING scheduled-job row(s) (#1293)`);
        })
        .catch(err => LOG.warn(`boot reconcile failed: ${err.message ?? err}`));
    });

    // #2782: outbox tombstone reaper — the durable fix for the blue-green
    // cutover stall. A SIGTERM mid-tick leaves a cds.outbox.Messages row stuck
    // at status='processing' with lastAttemptTimestamp=NULL and no successor
    // row; CAP's reclaim predicate (status IS NULL OR lastAttemptTimestamp <
    // now-1h) can never match it, so the job silently drops. This replaces the
    // #2762 process.exit self-restart (which couldn't clear these rows and
    // churned the outbox on every bounce). See srv/lib/scheduler-reaper.js.
    //
    // Build the jobName → cron map once so the reaper can age each stuck row
    // against its own schedule (reusing scheduler-wedge.isRowStale).
    const jobSchedules = new Map(
      Array.from(_getJobRegistry().values()).map(j => [j.jobName, j.schedule])
    );

    // (a) One boot-time sweep, deferred so it never blocks super.init() /
    //     schedule registration — clears any tombstone the instance that just
    //     cut over left behind. Fail-open (reaper never throws).
    setImmediate(() => {
      reapTombstonedOutboxRows(jobSchedules)
        .then(({ reaped, inspected }) => {
          if (reaped > 0) LOG.warn(`boot reap cleared ${reaped} outbox tombstone(s) of ${inspected} processing row(s) (#2782)`);
        })
        .catch(err => LOG.warn(`boot reap failed: ${err.message ?? err}`));
    });

    // (b) Periodic self-heal: every ~10 min, re-reap (a tombstone can be
    //     created AFTER this instance booted, so the boot sweep can't catch it),
    //     #2827 re-seed any registered job that has NO outbox queue row at all
    //     (the "missing successor row" stall — a crash mid-tick consumed the row
    //     without re-inserting the next occurrence; nothing for the reaper to
    //     reap), and run the ALERT-ONLY canary stall check. Enabled on CF, off
    //     locally; fail-open; .unref()'d. No process.exit — the reaper/re-seed
    //     are the recovery, the alert is just the signal.
    //     Runbook: docs/developers/operations/scheduler-troubleshooting.md
    //     § "All jobs overdue — queue-processor stall".
    //
    //     reseedJob re-runs the SAME `.every().as()` UPSERT init() uses, so a
    //     dropped job is re-seeded without a reboot. `.as(name)` is an idempotent
    //     singleton UPSERT (deterministic ID) — safe to call even if the row
    //     reappeared since reseedMissingSuccessorRows counted.
    const reseedJob = (jobName, cron) =>
      this.schedule(`cron.${jobName}`, {}).every(cron).as(jobName);
    armSchedulerSelfHeal({ jobSchedules, reseedJob });

    await super.init();
  }
}
