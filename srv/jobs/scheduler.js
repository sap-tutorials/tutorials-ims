import cron from 'node-cron';
import { acquireLock, releaseLock } from './job-lock.js';
import { cleanupStepFailures, cleanupUnusedTags, cleanupContentVersions, cleanupPipelineLog, cleanupStuckPublishing, pruneOrphanEmbeddings, pruneAnalyticsHistory, cleanupChangeLog } from './cleanup.js';
import { retryNgds } from './ngds-retry.js';
import { processAccountMerges } from './account-merge-job.js';
import { runReconciliationJob } from './embedding-reconciliation.js';
import { runExtractConcepts } from './extract-concepts-job.js';
import { runConsolidateConcepts } from './consolidate-concepts-job.js';
import { runSecretExpiryCheck } from './secret-expiry-check.js';
import { runHomepageLinkHealth } from './homepage-link-health.js';
import { runGcExternalContent } from './gc-external-content-job.js';
import { computeStaleNotifications, determineRecipients, markNotificationSent, getAdminEmailList, isNotificationsEnabled, resolveTimingKnobs, groupNotificationsByAuthor, determineRecipientsForDigest, digestSubject, renderTutorialList } from '../lib/contributor-notifications.js';
import { sendNotificationEmail, retryFailedEmails } from '../lib/mail-client.js';
import { resolveDisplaySettings } from '../lib/runtime-config/display-settings.js';
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

/**
 * Weekly contributor-notifications cycle. Branches on `knobs.useDigest`:
 *
 * - digest path (default): groups stale tutorials by resolved author, sends
 *   ONE digest email per author with a pre-rendered <ul> of tutorials. The
 *   template is picked by digest.worstLevel (`digest-level-{0..3}`). On a
 *   successful send, every tutorial in the digest is marked sent; on a
 *   failed send, NONE are marked (the 4-hour email-retry cron will pick up
 *   the FailedEmails row).
 * - legacy path (`useDigest=false`): one email per tutorial, recipient
 *   resolved via determineRecipients(), template picked by level number.
 *   Behavior is byte-equivalent to the pre-#622 cron body.
 *
 * Exported so the unit test (test/unit/cron-digest-mode.test.js) can exercise
 * the cron body with mocked dependencies.
 *
 * @param {string} logId  PipelineLog row id; the per-tutorial / per-digest
 *                        outcomes are logged as JobLog items against this row.
 * @returns {Promise<object>}  Summary suitable for formatJobSummary().
 */
export async function runContributorNotificationsCycle(logId) {
  if (!await isNotificationsEnabled()) {
    LOG.info('Contributor notifications disabled via config');
    return { enabled: false };
  }
  const knobs = await resolveTimingKnobs();
  const adminEmails = await getAdminEmailList();
  const notifications = await computeStaleNotifications(knobs);
  const dashboardUrl = (await resolveDisplaySettings()).dashboardUrl;

  if (knobs.useDigest) {
    return await runDigestCycle({ logId, knobs, adminEmails, notifications, dashboardUrl });
  }
  return await runLegacyCycle({ logId, knobs, adminEmails, notifications, dashboardUrl });
}

/**
 * Digest path — one email per author. See runContributorNotificationsCycle.
 */
async function runDigestCycle({ logId, knobs, adminEmails, notifications, dashboardUrl }) {
  const digests = groupNotificationsByAuthor(notifications);
  let sent = 0, skipped = 0, failed = 0;

  for (const d of digests) {
    // No resolvable author → SKIPPED per tutorial, no send.
    if (d.authorEmail == null) {
      for (const t of d.tutorials) {
        skipped++;
        await logJobItem(logId, {
          itemKey: t.slug || t.tutorialId,
          itemKind: 'NOTIFICATION',
          status: 'SKIPPED',
          message: 'No resolvable author for digest'
        });
      }
      continue;
    }

    const { to, cc } = determineRecipientsForDigest(d, adminEmails);
    if (to.length === 0) {
      for (const t of d.tutorials) {
        skipped++;
        await logJobItem(logId, {
          itemKey: t.slug || t.tutorialId,
          itemKind: 'NOTIFICATION',
          status: 'SKIPPED',
          message: 'No recipients resolved for digest'
        });
      }
      continue;
    }

    const tutorialCount = d.tutorials.length;
    const tutorialPlural = tutorialCount === 1 ? '' : 's';
    const result = await sendNotificationEmail({
      to, cc,
      subject: digestSubject(d),
      template: `digest-level-${d.worstLevel}`,
      variables: {
        authorName: d.authorName || 'Tutorial author',
        tutorialCount,
        tutorialPlural,
        tutorialListHtml: renderTutorialList(d.tutorials, dashboardUrl),
        staleDaysThreshold: knobs.staleDays,
        dashboardUrl,
      }
    });

    if (result.success) {
      for (const t of d.tutorials) {
        await markNotificationSent(t.tutorialId);
        sent++;
        await logJobItem(logId, {
          itemKey: t.slug || t.tutorialId,
          itemKind: 'NOTIFICATION',
          status: 'SUCCESS',
          message: `Digest sent to ${to.join(', ')} (level ${d.worstLevel})`
        });
      }
    } else {
      // Send failure → no tutorial in this digest gets advanced. The retry
      // cron + FailedEmails queue picks up the actual email.
      for (const t of d.tutorials) {
        failed++;
        await logJobItem(logId, {
          itemKey: t.slug || t.tutorialId,
          itemKind: 'NOTIFICATION',
          status: 'ERROR',
          message: result.error || 'sendNotificationEmail returned failure'
        });
      }
    }
  }

  LOG.info(`Processed ${digests.length} digests covering ${notifications.length} stale tutorials, sent ${sent} (advanced)`);
  return { digests: digests.length, sent, skipped, failed };
}

/**
 * Legacy path — verbatim from the pre-#622 cron body. One email per tutorial.
 */
async function runLegacyCycle({ logId, knobs, adminEmails, notifications, dashboardUrl }) {
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
      variables: {
        dashboardUrl,
        tutorialTitle: n.title,
        staleDaysThreshold: knobs.staleDays,
        lastReviewedDate: n.reviewedDate,
      }
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

  // Every 5 minutes — mark stuck PUBLISHING manifests as FAILED. This is a
  // janitor/watchdog job (NOT the content-publish event itself — those are
  // CONTENT_PUBLISH rows on Pipeline Log; this row lands on Job Log because
  // pipelineType=SCHEDULED_JOB). Chunked-session threshold 30 min matches
  // the begin/append/commit lock duration; legacy single-shot publishes
  // still reaped on the original 60-min threshold via createdAt. Off-minute
  // (every 5m starting at :03) to avoid the :00/:30 thundering herd. Spec:
  // 2026-05-29-publish-content-hardening.
  cron.schedule('3-58/5 * * * *', () =>
    runWithLock('publish-stuck-manifest-watchdog', 300000, () => cleanupStuckPublishing(30, 60))
  );

  // Hourly at :17 — re-embed tutorial steps whose content drifted (offset to avoid :00 thundering herd; multi-instance safe via lock)
  cron.schedule('17 * * * *', () =>
    runWithLock('embedding-reconciliation', 1800000, (logId) => runReconciliationJob(logId))
  );

  // Daily at 03:15 — prune pipeline log entries older than 30 days
  cron.schedule('15 3 * * *', () =>
    runWithLock('pipeline-log-gc', 600000, () => cleanupPipelineLog(30))
  );

  // Weekly Sunday at 03:23 — prune sap.changelog.Changes rows older than 90 days.
  // Audit history > 90 days is rarely queried; the bulk of admin Change Log
  // table volume on DEV is migration-trigger noise from migrate-from-hana.js
  // runs. Off-minute (:23) to avoid the :15/:30 thundering herd. See
  // docs/developers/operations/migration-from-ims.md §"changelog triggers
  // mitigation" for the design context. Admins can also one-shot purge
  // older noise via AdminService.clearChangeLog (#change-log-cleanup).
  cron.schedule('23 3 * * 0', () =>
    runWithLock('change-log-gc', 600000, () => cleanupChangeLog({ retentionDays: 90 }))
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
    runWithLock('contributor-notifications', 1800000, (logId) => runContributorNotificationsCycle(logId))
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

  // Weekly Sunday at 03:47 — knowledge-graph consolidation (#381 PR 4).
  // Off-minute (:47) and weekly cadence so the merge-on-write path during
  // extraction is the steady-state mechanism; this run mops up cross-batch
  // duplicates, auto-VETOes cycle-causing :requires edges, and rebuilds the
  // SPARQL projection. 30-min TTL matches extractConcepts.
  cron.schedule('47 3 * * 0', () =>
    runWithLock('consolidateConcepts', 30 * 60 * 1000, runConsolidateConcepts)
  );

  // Weekly Sunday at 04:07 — Phase 4 cross-type GC.
  // Prunes content rows past lastSeenAt + 2×TTL when not pinned. Cascade-deletes
  // link entity rows via CDS Compositions on the parent entity, plus an explicit
  // sweep of sibling Associations (e.g. LearningJourneyPrerequisites.prerequisite)
  // in the GC job itself — see srv/jobs/gc-external-content-job.js.
  // Off-minute (:07) avoids the :00 thundering-herd. Lightweight job; 10-min TTL.
  cron.schedule('7 4 * * 0', () =>
    runWithLock('gc-external-content', 10 * 60 * 1000, runGcExternalContent)
  );

  // Phase 2-B (#464): Daily expiry check for tracked secrets.
  // Off-minute (04:11) avoids the :00 thundering-herd spike. 10-minute
  // lock matches similar lightweight jobs; the actual run is a single
  // SELECT + classification, well under a second.
  cron.schedule('11 4 * * *', () =>
    runWithLock('secret-expiry-check', 600000, runSecretExpiryCheck)
  );

  // Daily at 04:00 — nightly link-health check for HomepageShelves entries.
  // Runs after content GC (03:00) but well before peak traffic.
  // Spec §13.1 (#639).
  cron.schedule('0 4 * * *', () =>
    runWithLock('homepage-link-health', 30 * 60 * 1000, runHomepageLinkHealth)
  );

  LOG.info('All scheduled jobs registered');
}
