import cron from 'node-cron';
import { acquireLock, releaseLock } from './job-lock.js';
import { cleanupStepFailures, cleanupUnusedTags, cleanupContentVersions, cleanupPipelineLog, cleanupStuckPublishing, pruneOrphanEmbeddings, pruneAnalyticsHistory } from './cleanup.js';
import { retryNgds } from './ngds-retry.js';
import { processAccountMerges } from './account-merge-job.js';
import { runReconciliationJob } from './embedding-reconciliation.js';
import { runExtractConcepts } from './extract-concepts-job.js';
import { computeStaleNotifications, determineRecipients, markNotificationSent, getAdminEmailList, isNotificationsEnabled } from '../lib/contributor-notifications.js';
import { sendNotificationEmail, retryFailedEmails } from '../lib/mail-client.js';
import { logPipelineStart, logPipelineEnd, logJobItem } from '../lib/pipeline-log.js';
import cds from '@sap/cds';

const instanceId = process.env.CF_INSTANCE_INDEX || '0';
const LOG = cds.log('scheduler');

async function runWithLock(jobName, durationMs, fn) {
  if (await acquireLock(jobName, instanceId, durationMs)) {
    const logId = await logPipelineStart('SCHEDULED_JOB', 'system', { jobName });
    try {
      const result = await fn(logId);
      const summary = formatJobSummary(jobName, result);
      await logPipelineEnd(logId, 'SUCCESS', summary);
    } catch (err) {
      LOG.error(`Job ${jobName} failed:`, err.message);
      await logPipelineEnd(logId, 'FAILED', jobName, err.message);
    } finally {
      await releaseLock(jobName, instanceId);
    }
  }
}

/**
 * Render a job's return value as a single-line summary stored on the
 * PipelineLog row. Numbers become "processed N", objects become a key=value
 * list, strings pass through, and null/undefined falls back to the job name.
 */
export function formatJobSummary(jobName, result) {
  if (result == null) return jobName;
  if (typeof result === 'string') return result.slice(0, 2000);
  if (typeof result === 'number') return `${jobName}: processed ${result}`;
  if (typeof result === 'object') {
    const parts = Object.entries(result)
      .filter(([, v]) => v != null && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'))
      .map(([k, v]) => `${k}=${v}`);
    return parts.length ? `${jobName}: ${parts.join(', ')}` : jobName;
  }
  return jobName;
}

export function registerJobs() {
  LOG.info(`Registering scheduled jobs on instance ${instanceId}`);

  // Daily at 00:00 — cleanup step failures
  cron.schedule('0 0 * * *', () =>
    runWithLock('cleanup-step-failures', 3600000, () => cleanupStepFailures(90))
  );

  // Every 2 hours — NGDS retry
  cron.schedule('0 */2 * * *', () =>
    runWithLock('ngds-retry', 1800000, (logId) => retryNgds(logId))
  );

  // Daily at 01:00 — account merge batch
  cron.schedule('0 1 * * *', () =>
    runWithLock('account-merge-batch', 7200000, (logId) => processAccountMerges(logId))
  );

  // Jan 2 and Jul 2 at 00:00 — tag cleanup
  cron.schedule('0 0 2 1,7 *', () =>
    runWithLock('tag-cleanup', 3600000, cleanupUnusedTags)
  );

  // Daily at 03:00 — prune old content versions (keep last 3, older than 7 days)
  cron.schedule('0 3 * * *', () =>
    runWithLock('content-gc', 600000, () => cleanupContentVersions(3, 7))
  );

  // Every 5 minutes — mark stuck PUBLISHING manifests as FAILED. Chunked-session
  // threshold 30 min matches the begin/append/commit lock duration; legacy
  // single-shot publishes still reaped on the original 60-min threshold via
  // createdAt. Off-minute (every 5m starting at :03) to avoid the :00/:30
  // thundering herd. Spec: 2026-05-29-publish-content-hardening.
  cron.schedule('3-58/5 * * * *', () =>
    runWithLock('content-publishing-sweep', 300000, () => cleanupStuckPublishing(30, 60))
  );

  // Hourly at :17 — re-embed tutorial steps whose content drifted (offset to avoid :00 thundering herd; multi-instance safe via lock)
  cron.schedule('17 * * * *', () =>
    runWithLock('embedding-reconciliation', 1800000, (logId) => runReconciliationJob(logId))
  );

  // Daily at 03:15 — prune pipeline log entries older than 30 days
  cron.schedule('15 3 * * *', () =>
    runWithLock('pipeline-log-gc', 600000, () => cleanupPipelineLog(30))
  );

  // Daily at 03:30 — prune embeddings for tutorials no longer in the active manifest
  cron.schedule('30 3 * * *', () =>
    runWithLock('embedding-orphan-prune', 300000, pruneOrphanEmbeddings)
  );

  // Daily at 03:45 — prune analytics history to last 200 entries per user.
  // Off-minute (:45) to keep cleanup window staggered; admin-only feature
  // with low write volume so single daily pass is plenty.
  cron.schedule('45 3 * * *', () =>
    runWithLock('analytics-history-prune', 600000, () => pruneAnalyticsHistory(200))
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
        LOG.error('tutorial-meta scheduler failed:', e);
      }
    })
  );

  // Weekly Monday 09:00 — contributor notifications
  cron.schedule('0 9 * * 1', () =>
    runWithLock('contributor-notifications', 1800000, async (logId) => {
      if (!await isNotificationsEnabled()) {
        LOG.info('Contributor notifications disabled via config');
        return { enabled: false };
      }
      const adminEmails = await getAdminEmailList();
      const notifications = await computeStaleNotifications(180);
      const dashboardUrl = process.env.DASHBOARD_URL || 'https://tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/ui/tutorialDashboard';

      let sent = 0, skipped = 0, failed = 0;
      for (const n of notifications) {
        const { to, cc } = determineRecipients(n, adminEmails);
        if (to.length === 0) {
          skipped++;
          await logJobItem(logId, {
            itemKey: n.tutorialSlug || n.tutorialId,
            itemKind: 'NOTIFICATION',
            status: 'SKIPPED',
            message: 'No recipients resolved'
          });
          continue;
        }
        const result = await sendNotificationEmail({
          to, cc,
          subject: n.title,
          level: n.notificationLevel,
          variables: { dashboardUrl }
        });
        if (result.success) {
          await markNotificationSent(n.tutorialId);
          sent++;
          await logJobItem(logId, {
            itemKey: n.tutorialSlug || n.tutorialId,
            itemKind: 'NOTIFICATION',
            status: 'SUCCESS',
            message: `Sent to ${to.join(', ')}`
          });
        } else {
          failed++;
          await logJobItem(logId, {
            itemKey: n.tutorialSlug || n.tutorialId,
            itemKind: 'NOTIFICATION',
            status: 'ERROR',
            message: result.error || 'sendNotificationEmail returned failure'
          });
        }
      }
      LOG.info(`Processed ${notifications.length} stale tutorials, sent ${sent} emails`);
      return { stale: notifications.length, sent, skipped, failed };
    })
  );

  // Every 4 hours — email retry
  cron.schedule('0 */4 * * *', () =>
    runWithLock('email-retry', 900000, retryFailedEmails)
  );

  // Daily at 02:13 — knowledge-graph concept extraction (#381 PR 3).
  // Off-minute (:13) to avoid the :00/:30 thundering herd. 30-min TTL covers
  // a full pass of ~1400 tutorials at ~1s/tutorial cache-hit + ~3s/tutorial
  // LLM call up to KG_EXTRACT_BUILD_CAP (default 200/tick).
  cron.schedule('13 2 * * *', () =>
    runWithLock('extractConcepts', 30 * 60 * 1000, runExtractConcepts)
  );

  LOG.info('All scheduled jobs registered');
}
