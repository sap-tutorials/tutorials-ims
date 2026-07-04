// srv/cron-service.js
//
// Internal scheduling bus. Owns the scheduler lifecycle:
//   1. registerJobs()          — populates JOB_REGISTRY (32 entries)
//   2. For each job in the registry:
//      - this.on('cron.<jobName>', () => runJobByName(jobName))
//      - this.schedule('cron.<jobName>', {}).every(job.schedule).as(job.jobName)
//
// Feature flag: CAP_SCHEDULING_ENABLED (default 'true'). Set to 'false'
// during Commit 1's DEV soak if node-cron behavior needs to be exclusive.
// Removed cleanly in Commit 4.
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
    // Owned entirely by CronService now — the previous 'served' hook in
    // srv/server.js that called registerJobs() is removed in Commit 2.
    // During Commit 1's dual-engine window, registerJobs() is called by
    // BOTH srv/server.js and CronService.init(). The registry throws on
    // duplicate jobName registration, so we skip if already populated.
    if (_getJobRegistry().size === 0) {
      registerJobs();
    } else {
      LOG.info(`JOB_REGISTRY already populated (${_getJobRegistry().size} entries); skipping registerJobs()`);
    }

    if (process.env.CAP_SCHEDULING_ENABLED === 'false') {
      LOG.warn('CAP_SCHEDULING_ENABLED=false — skipping srv.schedule() wiring; node-cron remains sole engine');
      await super.init();
      return;
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
