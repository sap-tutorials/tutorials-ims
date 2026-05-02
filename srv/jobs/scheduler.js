import cron from 'node-cron';
import { acquireLock, releaseLock } from './job-lock.js';
import { cleanupStepFailures, cleanupUnusedTags, cleanupContentVersions } from './cleanup.js';
import { recordActiveLearners } from './analytics.js';
import { retryNgds } from './ngds-retry.js';
import { processAccountMerges } from './account-merge-job.js';
import { computeStaleNotifications, determineRecipients, markNotificationSent, getAdminEmailList, isNotificationsEnabled } from '../lib/contributor-notifications.js';
import { sendNotificationEmail, retryFailedEmails } from '../lib/mail-client.js';
import { syncTutorialMetadata } from '../lib/tutorial-sync.js';
import cds from '@sap/cds';

const instanceId = process.env.CF_INSTANCE_INDEX || '0';
const LOG = cds.log('scheduler');

async function runWithLock(jobName, durationMs, fn) {
  if (await acquireLock(jobName, instanceId, durationMs)) {
    try {
      await fn();
    } catch (err) {
      LOG.error(`Job ${jobName} failed:`, err.message);
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

  // Weekly Sunday 02:00 — tutorial metadata review
  cron.schedule('0 2 * * 0', () =>
    runWithLock('tutorial-metadata-review', 3600000, async () => {
      const fs = await import('fs');
      const path = await import('path');
      const cachePath = path.join(process.cwd(), '.tutorial-cache', 'metadata.json');
      try {
        const raw = fs.readFileSync(cachePath, 'utf-8');
        await syncTutorialMetadata(JSON.parse(raw));
      } catch { LOG.warn('No metadata cache found for tutorial review sync'); }
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
      const dashboardUrl = process.env.DASHBOARD_URL || 'https://tutorials-approuter.cfapps.us30.hana.ondemand.com/ui/tutorialDashboard';

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
