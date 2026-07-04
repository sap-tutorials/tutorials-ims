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

    await super.init();
  }
}
