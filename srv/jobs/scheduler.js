import cron from 'node-cron';
import { acquireLock, releaseLock } from './job-lock.js';
import { cleanupStepFailures, cleanupUnusedTags, cleanupContentVersions, cleanupPipelineLog, cleanupStuckPublishing, pruneOrphanEmbeddings } from './cleanup.js';
import { recordActiveLearners } from './analytics.js';
import { retryNgds } from './ngds-retry.js';
import { processAccountMerges } from './account-merge-job.js';
import { runReconciliationJob } from './embedding-reconciliation.js';
import { computeStaleNotifications, determineRecipients, markNotificationSent, getAdminEmailList, isNotificationsEnabled } from '../lib/contributor-notifications.js';
import { sendNotificationEmail, retryFailedEmails } from '../lib/mail-client.js';
import { logPipelineStart, logPipelineEnd } from '../lib/pipeline-log.js';
import cds from '@sap/cds';

const instanceId = process.env.CF_INSTANCE_INDEX || '0';
const LOG = cds.log('scheduler');

async function runWithLock(jobName, durationMs, fn) {
  if (await acquireLock(jobName, instanceId, durationMs)) {
    const logId = await logPipelineStart('SCHEDULED_JOB', 'system', { jobName });
    try {
      await fn();
      await logPipelineEnd(logId, 'SUCCESS', jobName);
    } catch (err) {
      LOG.error(`Job ${jobName} failed:`, err.message);
      await logPipelineEnd(logId, 'FAILED', jobName, err.message);
    } finally {
      await releaseLock(jobName, instanceId);
    }
  }
}

export function registerJobs() {
  LOG.info(`Registering scheduled jobs on instance ${instanceId}`);

  // Daily at 00:00 — cleanup step failures
  cron.schedule('0 0 * * *', () =>
    runWithLock('cleanup-step-failures', 3600000, () => cleanupStepFailures(90))
  );

  // Daily at 00:15 — active learner analytics
  cron.schedule('15 0 * * *', () =>
    runWithLock('active-learner-analytics', 1800000, recordActiveLearners)
  );

  // Every 2 hours — NGDS retry
  cron.schedule('0 */2 * * *', () =>
    runWithLock('ngds-retry', 1800000, retryNgds)
  );

  // Daily at 01:00 — account merge batch
  cron.schedule('0 1 * * *', () =>
    runWithLock('account-merge-batch', 7200000, processAccountMerges)
  );

  // Jan 2 and Jul 2 at 00:00 — tag cleanup
  cron.schedule('0 0 2 1,7 *', () =>
    runWithLock('tag-cleanup', 3600000, cleanupUnusedTags)
  );

  // Daily at 03:00 — prune old content versions (keep last 3, older than 7 days)
  cron.schedule('0 3 * * *', () =>
    runWithLock('content-gc', 600000, () => cleanupContentVersions(3, 7))
  );

  // Every hour — mark stuck PUBLISHING manifests as FAILED (older than 60 min)
  cron.schedule('30 * * * *', () =>
    runWithLock('content-publishing-sweep', 300000, () => cleanupStuckPublishing(60))
  );

  // Hourly at :17 — re-embed tutorial steps whose content drifted (offset to avoid :00 thundering herd; multi-instance safe via lock)
  cron.schedule('17 * * * *', () =>
    runWithLock('embedding-reconciliation', 1800000, runReconciliationJob)
  );

  // Daily at 03:15 — prune pipeline log entries older than 30 days
  cron.schedule('15 3 * * *', () =>
    runWithLock('pipeline-log-gc', 600000, () => cleanupPipelineLog(30))
  );

  // Daily at 03:30 — prune embeddings for tutorials no longer in the active manifest
  cron.schedule('30 3 * * *', () =>
    runWithLock('embedding-orphan-prune', 300000, pruneOrphanEmbeddings)
  );

  // Weekly Sunday 02:00 — tutorial metadata review
  cron.schedule('0 2 * * 0', () =>
    runWithLock('tutorial-metadata-review', 3600000, async () => {
      // Tutorial review sync — self-healing backfill of missing TutorialMeta.
      // Publish handles the happy path; this catches drift.
      try {
        const { backfillMissingTutorialMeta } = await import('../lib/tutorial-meta-init.js');
        const { created } = await backfillMissingTutorialMeta();
        if (created > 0) LOG.info(`tutorial-meta scheduler: backfilled ${created} rows`);
      } catch (e) {
        LOG.error('tutorial-meta scheduler failed:', e.message);
      }
    })
  );

  // Weekly Monday 09:00 — contributor notifications
  cron.schedule('0 9 * * 1', () =>
    runWithLock('contributor-notifications', 1800000, async () => {
      if (!await isNotificationsEnabled()) {
        LOG.info('Contributor notifications disabled via config');
        return;
      }
      const adminEmails = await getAdminEmailList();
      const notifications = await computeStaleNotifications(180);
      const dashboardUrl = process.env.DASHBOARD_URL || 'https://tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/ui/tutorialDashboard';

      let sent = 0;
      for (const n of notifications) {
        const { to, cc } = determineRecipients(n, adminEmails);
        if (to.length === 0) continue;
        const result = await sendNotificationEmail({
          to, cc,
          subject: n.title,
          level: n.notificationLevel,
          variables: { dashboardUrl }
        });
        if (result.success) {
          await markNotificationSent(n.tutorialId);
          sent++;
        }
      }
      LOG.info(`Processed ${notifications.length} stale tutorials, sent ${sent} emails`);
    })
  );

  // Every 4 hours — email retry
  cron.schedule('0 */4 * * *', () =>
    runWithLock('email-retry', 900000, retryFailedEmails)
  );

  LOG.info('All scheduled jobs registered');
}
