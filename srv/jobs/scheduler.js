// srv/jobs/scheduler.js
//
// Central registration + dispatch for every scheduled job in the app.
//
// The scheduler has two invocation paths and JOB_REGISTRY is the single
// source of truth for both:
//   1. CAP scheduled ticks — srv/cron-service.js reads JOB_REGISTRY at
//      init() and calls `this.schedule('cron.<name>', {}).every(expr)
//      .as(jobName)`. Its `on('cron.<name>')` handler invokes
//      `runJobByName(name)`. Per-instance status-column singleton
//      locking replaces the previous node-cron + JobLocks scheme (#958).
//   2. Admin manual triggers — `AdminService.JobControls.runJob(jobName)`
//      dispatches to `runJobByName(name, {manualTrigger, user})` (#756).
//
// Both routes end up in `runWithLock`, which:
//   - Emits PipelineLog start/end rows (visible on the admin Job Log tile).
//   - Records JobLastRun outcome (visible on the Cron health tile).
//   - For `manualTrigger:true`, emits SecurityEvent audit events (spec §9).
//
// #958: The pre-CAP-10 chassis also acquired/released a DB-backed lock
// (JobLocks) keyed on jobName + instanceId to prevent duplicate scheduled
// ticks across CF instances. CAP 10's `.as(name)` status-column singleton
// locking replaces that mechanism, so runWithLock no longer touches
// JobLocks. Manual triggers colliding with an in-flight scheduled run
// now both run to completion; last-write-wins on JobLastRun.
//
// Convention: schedules use OFF-MINUTES (e.g. :07, :13, :23, :43) rather
// than the :00/:30 thundering herd — this project has ~24 scheduled jobs
// and the DB doesn't need them all firing at the same instant. New jobs
// should pick a minute not already in use in registerJobs() below.
//
// #756 spec: docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md
// #958 spec: docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md

import { cleanupStepFailures, cleanupUnusedTags, cleanupContentVersions, cleanupPipelineLog, cleanupStuckPublishing, pruneOrphanEmbeddings, pruneAnalyticsHistory, cleanupChangeLog, cleanupMetricSnapshots, cleanupPublishTimings } from './cleanup.js';
import { runMetricsRollup } from './metrics-rollup-job.js';
import { retryNgds } from './ngds-retry.js';
import { processAccountMerges } from './account-merge-job.js';
import { runReconciliationJob } from './embedding-reconciliation.js';
import { runConceptEmbeddingBackfill } from './concept-embedding-backfill.js';
import { runExtractConcepts } from './extract-concepts-job.js';
import { runConsolidateConcepts } from './consolidate-concepts-job.js';
import { runSecretExpiryCheck } from './secret-expiry-check.js';
import { runHomepageLinkHealth } from './homepage-link-health.js';
import { runGcExternalContent } from './gc-external-content-job.js';
import { runFetchLearningJourneys } from './fetch-learning-journeys-job.js';
import { runFetchBlogPosts } from './fetch-blog-posts-job.js';
import { runMaterializeCoCompletions } from './materialize-co-completions.js';
import { runKgPageRank } from './kg-pagerank-job.js';
import { runKgCommunities } from './kg-communities-job.js';
import { runKgWcc } from './kg-wcc-job.js';
import { runOnDemandDrain } from './kg-ondemand-job.js';
import { computeStaleNotifications, determineRecipients, markNotificationSent, getAdminEmailList, isNotificationsEnabled, resolveTimingKnobs, groupNotificationsByAuthor, determineRecipientsForDigest, digestSubject, renderTutorialList } from '../lib/contributor-notifications.js';
import { sendNotificationEmail, retryFailedEmails } from '../lib/mail-client.js';
import { resolveDisplaySettings } from '../lib/runtime-config/display-settings.js';
import { logPipelineStart, logPipelineEnd, logJobItem } from '../lib/pipeline-log.js';
import cds from '@sap/cds';

const instanceId = process.env.CF_INSTANCE_INDEX || '0';
const LOG = cds.log('scheduler');

// #756: JOB_REGISTRY is the single source of truth for all scheduled jobs.
// Both CronService (in srv/cron-service.js) and the
// AdminService.JobControls.runJob() handler read from this map.
//
// Spec: docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md §4.1
const JOB_REGISTRY = new Map();

/**
 * @typedef {Object} JobDef
 * @property {string} jobName
 * @property {string} schedule         cron expression — e.g. '23 4 1 * *'
 * @property {number} ttlMs            lock duration in milliseconds
 * @property {string} description      human-readable, shown in admin tile
 * @property {Function} fn             async () => Promise<unknown> | async (logId) => Promise<unknown>
 */

/**
 * Register a job in the JOB_REGISTRY. CronService.init() reads the
 * registry at boot and calls srv.schedule() per entry.
 * Both invocation paths (scheduled and manual) read from the registry.
 */
export function registerJob({ jobName, schedule, ttlMs, description, fn }) {
  if (JOB_REGISTRY.has(jobName)) {
    throw new Error(`Duplicate jobName: ${jobName}`);
  }
  JOB_REGISTRY.set(jobName, { jobName, schedule, ttlMs, description, fn });
  // #958: cron.schedule() removed; CronService owns scheduling via
  // srv.schedule('cron.<name>', {}).every(schedule).as(jobName).
}

/**
 * Runner used by BOTH scheduled cron invocations AND manual admin triggers.
 * Looks up the job in JOB_REGISTRY and delegates to runWithLock.
 *
 * @param {string} jobName
 * @param {{manualTrigger?: boolean, user?: string}} [opts]
 * @returns {Promise<{skipped: boolean, outcome?: string, result?: unknown, errorMessage?: string, reason?: string}>}
 */
export async function runJobByName(jobName, opts = {}) {
  const job = JOB_REGISTRY.get(jobName);
  if (!job) throw new Error(`Unknown jobName: ${jobName}`);
  // #747 (Phase 4.6): thread opts through to the cron fn as a second
  // positional arg, while preserving logId as the first. The 4 logId
  // crons declared `(logId) => fn(logId)` ignore the second arg silently
  // (arrow-function arity is fixed at declaration). Zero-arg crons
  // declared `() => fn()` ignore both. Phase 4.6's runFetchSamples
  // consumes `opts` as its second positional.
  return runWithLock(job.jobName, job.ttlMs, (logId) => job.fn(logId, opts), opts);
}

// Test seams (production code MUST NOT use these).
export function _getJobRegistry() { return JOB_REGISTRY; }
export function _resetJobRegistry() { JOB_REGISTRY.clear(); }
export function _setJobFn(jobName, mockFn) {
  const existing = JOB_REGISTRY.get(jobName);
  if (!existing) throw new Error(`Cannot mock unknown job: ${jobName}`);
  JOB_REGISTRY.set(jobName, { ...existing, fn: mockFn });
}

/**
 * Runs a cron job's fn (or a manual admin trigger) under the standard
 * chassis: PipelineLog start row, invoke fn(logId), PipelineLog end row
 * (SUCCESS or FAILED), then JobLastRun UPSERT in `finally`. On manual
 * triggers (opts.manualTrigger=true), emits a completion SecurityEvent
 * audit event from the `finally` block (spec §9).
 *
 * Return shape: {skipped: false, outcome: 'success'|'error', result,
 * errorMessage} — `skipped` is always false since #958 retired the
 * lock-held short-circuit; retained in the shape for backward-compat
 * with existing callers that destructure it.
 *
 * durationMs is unused (CAP owns duration semantics now) but retained
 * in the signature for registerJob call-site stability.
 *
 * Backward-compat: the pre-#756 3-arg signature works because opts
 * defaults to {}. `manualTrigger` and `user` opts are passed through
 * from AdminService.JobControls.runJob.
 *
 * Spec: docs/superpowers/specs/2026-07-04-958-cap10-scheduler-migration-design.md
 */
async function runWithLock(jobName, durationMs, fn, opts = {}) {
  // #958: node-cron + JobLocks retired. CAP 10's .as(name) status-column
  // singleton semantics prevent concurrent scheduled ticks across CF
  // instances. Manual triggers (setImmediate path from admin actions)
  // bypass the outbox entirely — a manual-vs-scheduled collision runs
  // both to completion; last-write-wins on JobLastRun. Documented
  // behavior change from the pre-#958 lock-held short-circuit.
  //
  // durationMs is retained in the signature for call-site stability
  // (registerJob passes it through) but is unused inside this function.
  void durationMs;

  let outcome = 'success';
  let errorMessage = null;
  let result = null;
  const startedAt = new Date();
  const logId = await logPipelineStart('SCHEDULED_JOB', 'system', { jobName });
  try {
    result = await fn(logId);
    const summary = formatJobSummary(jobName, result);
    await logPipelineEnd(logId, 'SUCCESS', summary);
  } catch (err) {
    outcome = 'error';
    errorMessage = err.message ?? String(err);
    LOG.error(`Job ${jobName} failed:`, errorMessage);
    await logPipelineEnd(logId, 'FAILED', jobName, errorMessage);
  } finally {
    try {
      await recordJobLastRun(jobName, outcome, errorMessage);
    } catch (err) {
      LOG.warn(`recordJobLastRun ${jobName} failed: ${err.message}`);
    }
    if (opts.manualTrigger) {
      await emitJobAuditSafely({
        jobName,
        user: opts.user,
        outcome,
        durationMs: Date.now() - startedAt.getTime(),
      });
    }
  }
  return { skipped: false, outcome, result, errorMessage };
}

/**
 * Lazy + safe audit emission. Imports from admin-service.js only when
 * needed (avoids circular import scheduler.js <-> admin-service.js).
 * Swallows all errors — audit emission must never fail the cron.
 */
async function emitJobAuditSafely(opts) {
  try {
    const mod = await import('../admin-service.js');
    if (typeof mod.emitJobAudit === 'function') {
      await mod.emitJobAudit(opts);
    }
  } catch (err) {
    LOG.warn(`emitJobAudit failed: ${err.message}`);
  }
}

/**
 * Phase 4.5 (#746): record per-cron last-run state for the admin UI tile.
 * Sibling to runWithLock; called by individual cron bodies after each cycle.
 * Surfaced via AdminService.JobLastRun on the Cron health admin tile.
 *
 * Phase 4.1-4.4 cron retrofit is OUT OF SCOPE — only fetch-api-docs writes
 * JobLastRun rows in this PR (Phase 4.5 spec §4.6).
 */
async function recordJobLastRun(jobName, outcome, errorMessage = null) {
  try {
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const now = new Date();
    const fields = outcome === 'success'
      ? { lastSuccessAt: now, lastErrorAt: null, lastErrorMessage: null }
      : { lastErrorAt: now, lastErrorMessage: errorMessage ?? 'unspecified error' };

    const existing = await SELECT.one.from(JobLastRun).columns('jobName').where({ jobName });
    if (existing) {
      await UPDATE(JobLastRun).set(fields).where({ jobName });
    } else {
      await INSERT.into(JobLastRun).entries({ jobName, ...fields });
    }
  } catch (err) {
    LOG.warn(`recordJobLastRun(${jobName}) failed: ${err.message}`);
  }
}

/**
 * Idempotent UPSERT of one JobLastRun row per registered job.
 *
 * Called at the END of registerJobs() so all jobs are visible on the
 * admin Cron health tile from day 1 — even before any cron has fired.
 *
 * Race-safe for multi-instance CF deploys: UPSERT translates to
 * INSERT...ON CONFLICT DO NOTHING semantics on HANA via CDS QL. Two
 * instances racing to seed both succeed without primary-key violation.
 *
 * Best-effort — if HANA is briefly unreachable at boot, warn-log and
 * return. The admin tile will show 0 rows until the first cron actually
 * fires and writes a JobLastRun row via the chassis path.
 *
 * Spec: docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md §4.4
 */
export async function preSeedJobLastRun() {
  try {
    const { JobLastRun } = cds.entities('com.sap.developers.ims');
    const knownJobs = Array.from(JOB_REGISTRY.keys());
    if (knownJobs.length === 0) return;
    await UPSERT.into(JobLastRun).entries(knownJobs.map(jobName => ({ jobName })));
    LOG.info(`pre-seeded ${knownJobs.length} JobLastRun rows (idempotent)`);
  } catch (err) {
    LOG.warn(`JobLastRun pre-seed failed: ${err.message}`);
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
  registerJob({
    jobName: 'cleanup-step-failures',
    schedule: '0 0 * * *',
    ttlMs: 3600000,
    description: 'Delete StepFailures older than 90 days',
    fn: () => cleanupStepFailures(90),
  });

  // Every 2 hours — NGDS retry
  registerJob({
    jobName: 'ngds-retry',
    schedule: '0 */2 * * *',
    ttlMs: 1800000,
    description: 'Retry NGDS failed messages',
    fn: (logId) => retryNgds(logId),
  });

  // Daily at 01:00 — account merge batch
  registerJob({
    jobName: 'account-merge-batch',
    schedule: '0 1 * * *',
    ttlMs: 7200000,
    description: 'Process pending account merges',
    fn: (logId) => processAccountMerges(logId),
  });

  // Jan 2 and Jul 2 at 00:00 — tag cleanup
  registerJob({
    jobName: 'tag-cleanup',
    schedule: '0 0 2 1,7 *',
    ttlMs: 3600000,
    description: 'Prune unused Tag rows (semi-annual)',
    fn: cleanupUnusedTags,
  });

  // Daily at 03:00 — prune old content versions (keep last 3, older than 7 days)
  registerJob({
    jobName: 'content-gc',
    schedule: '0 3 * * *',
    ttlMs: 600000,
    description: 'Prune old ContentManifest versions',
    fn: () => cleanupContentVersions(3, 7),
  });

  // Every 5 minutes — mark stuck PUBLISHING manifests as FAILED. This is a
  // janitor/watchdog job (NOT the content-publish event itself — those are
  // CONTENT_PUBLISH rows on Pipeline Log; this row lands on Job Log because
  // pipelineType=SCHEDULED_JOB). Chunked-session threshold 30 min matches
  // the begin/append/commit lock duration; legacy single-shot publishes
  // still reaped on the original 60-min threshold via createdAt. Off-minute
  // (every 5m starting at :03) to avoid the :00/:30 thundering herd. Spec:
  // 2026-05-29-publish-content-hardening.
  registerJob({
    jobName: 'publish-stuck-manifest-watchdog',
    schedule: '3-58/5 * * * *',
    ttlMs: 300000,
    description: 'Mark stuck PUBLISHING manifests as FAILED',
    fn: () => cleanupStuckPublishing(30, 60),
  });

  // Hourly at :17 — re-embed tutorial steps whose content drifted (offset to avoid :00 thundering herd; multi-instance safe via lock)
  registerJob({
    jobName: 'embedding-reconciliation',
    schedule: '17 * * * *',
    ttlMs: 1800000,
    description: 'Re-embed tutorial steps whose content drifted',
    fn: (logId) => runReconciliationJob(logId),
  });

  // #943 — Hourly at :17, KG-side concept backfill. Distinct from
  // embedding-reconciliation above (that job targets TutorialEmbedding /
  // HANA Vector(1536); this job targets Concepts.embedding / raw BLOB
  // Float32 LE). Distributed-lock keyed on 'concept-embedding-backfill'
  // so both jobs coexist on the same minute without stepping on each
  // other. On a fresh DB the backfill is a no-op.
  registerJob({
    jobName: 'concept-embedding-backfill',
    schedule: '17 * * * *',
    ttlMs: 1800000,
    description: 'Backfill Concepts.embedding for ACTIVE/published rows missing an embedding',
    fn: () => runConceptEmbeddingBackfill(),
  });

  // Daily at 03:15 — prune pipeline log entries older than 30 days
  registerJob({
    jobName: 'pipeline-log-gc',
    schedule: '15 3 * * *',
    ttlMs: 600000,
    description: 'Prune PipelineLog rows older than 30 days',
    fn: () => cleanupPipelineLog(30),
  });

  // Weekly Sunday at 03:23 — prune sap.changelog.Changes rows older than 90 days.
  // Audit history > 90 days is rarely queried; the bulk of admin Change Log
  // table volume on DEV is migration-trigger noise from migrate-from-hana.js
  // runs. Off-minute (:23) to avoid the :15/:30 thundering herd. See
  // docs/developers/operations/migration-from-ims.md §"changelog triggers
  // mitigation" for the design context. Admins can also one-shot purge
  // older noise via AdminService.clearChangeLog (#change-log-cleanup).
  registerJob({
    jobName: 'change-log-gc',
    schedule: '23 3 * * 0',
    ttlMs: 600000,
    description: 'Prune sap.changelog.Changes rows older than 90 days',
    fn: () => cleanupChangeLog({ retentionDays: 90 }),
  });

  // Daily at 03:30 — prune embeddings for tutorials no longer in the active manifest
  registerJob({
    jobName: 'embedding-orphan-prune',
    schedule: '30 3 * * *',
    ttlMs: 300000,
    description: 'Prune embeddings for tutorials not in active manifest',
    fn: pruneOrphanEmbeddings,
  });

  // Daily at 03:45 — prune analytics history to last 200 entries per user.
  // Off-minute (:45) to keep cleanup window staggered; admin-only feature
  // with low write volume so single daily pass is plenty.
  registerJob({
    jobName: 'analytics-history-prune',
    schedule: '45 3 * * *',
    ttlMs: 600000,
    description: 'Prune analytics history to last 200 entries per user',
    fn: () => pruneAnalyticsHistory(200),
  });

  // Daily 04:33 UTC — rebuild the CoCompletions materialized table.
  // Runtime hot path (neighborhood handler) reads this table with a
  // single indexed lookup instead of paying a ~60s TaskRecords scan on
  // cold start. See srv/lib/co-completion.js and
  // srv/jobs/materialize-co-completions.js.
  registerJob({
    jobName: 'materialize-co-completions',
    schedule: '33 4 * * *',
    ttlMs: 900000,
    description: 'Rebuild CoCompletions table for fast neighborhood lookups',
    fn: () => runMaterializeCoCompletions(),
  });

  // Daily 03:53 UTC — recompute PageRank over the KG property graph
  // and materialize per-concept + per-tutorial scores into the sidecar
  // tables read by rankNeighborhood() when KG_PAGERANK_ENABLED === 'true'.
  // Off-minute (:53) — the neighboring 03:xx slots are already taken
  // (:00, :15, :23, :30, :45); :53 keeps us out of the 03:xx cluster.
  // ttlMs 10 min — expected wall-clock at 17k vertices / 40k edges is
  // sub-2s (compute) + sub-1s (write); the 10-min ceiling is loud
  // headroom in case the graph 10x's overnight. Fail-open: job errors
  // never break request-time reads (ranker catches loadRankMaps() throws).
  // Spec: docs/superpowers/specs/2026-07-04-916-kg-pagerank-design.md
  // Issue: #916
  registerJob({
    jobName: 'kg-pagerank',
    schedule: '53 3 * * *',
    ttlMs: 600000,
    description: 'Nightly PageRank over KG_PG_WORKSPACE — populates ConceptRank/TutorialRank sidecars (#916)',
    fn: () => runKgPageRank(),
  });

  // Daily 03:57 UTC — Louvain community detection over KG_PG_WORKSPACE.
  // Runs 4 minutes after kg-pagerank (:53) so both algorithms see the
  // same nightly snapshot of the graph. Off-minute per the "avoid :00
  // and :30" convention. ttlMs 10 min — expected wall-clock is sub-3s
  // (compute) + sub-1s (write); 10 min is loud headroom.
  //
  // Fail-open: errors propagate to PipelineLog FAILED but never break
  // request-time reads (admin tile renders an empty state).
  //
  // Spec: docs/superpowers/specs/2026-07-04-917-kg-community-detection-design.md
  // Issue: #917
  registerJob({
    jobName: 'kg-communities',
    schedule: '57 3 * * *',
    ttlMs: 600000,
    description: 'Nightly Louvain community detection over KG_PG_WORKSPACE — populates KgCommunity sidecar (#917)',
    fn: () => runKgCommunities(),
  });

  // Daily 04:07 UTC — weakly-connected-components pass over the KG
  // property graph. Populates KgIsolation with rows for concept and
  // tutorial vertices whose WCC size <= KG_WCC_ISOLATION_THRESHOLD
  // (default 1). Runs after PageRank (03:53) and Louvain (03:57) so
  // all three algorithms see the same nightly snapshot of
  // KG_PG_WORKSPACE. Off-minute (:07) — 04:00 / 04:11 / 04:17 / 04:23
  // / 04:33 / 04:43 / 04:31 Mon+Thu are already taken. ttlMs 10 min
  // — expected wall-clock at 17k vertices / 40k edges is sub-second
  // (union-find is O(N + M · α(N))); 10-min ceiling is loud headroom.
  // Fail-quiet: job errors never break request-time reads (the
  // on(READ) decorators on Concepts and Tutorials catch SELECT throws
  // and leave `isolated` unset). Spec:
  // docs/superpowers/specs/2026-07-04-918-kg-wcc-isolation-design.md
  // Issue: #918
  registerJob({
    jobName: 'kg-wcc',
    schedule: '7 4 * * *',
    ttlMs: 600000,
    description: 'Weakly-connected components over KG_PG_WORKSPACE — populates KgIsolation sidecar (#918)',
    fn: () => runKgWcc(),
  });

  // Weekly Sunday 02:00 — tutorial metadata review
  registerJob({
    jobName: 'tutorial-metadata-review',
    schedule: '0 2 * * 0',
    ttlMs: 3600000,
    description: 'Tutorial review sync — backfill missing TutorialMeta',
    fn: async () => {
      // Tutorial review sync — self-healing backfill of missing TutorialMeta.
      // Publish handles the happy path; this catches drift.
      try {
        const { backfillMissingTutorialMeta } = await import('../lib/tutorial-meta-init.js');
        const { created } = await backfillMissingTutorialMeta();
        if (created > 0) LOG.info(`tutorial-meta scheduler: backfilled ${created} rows`);
      } catch (e) {
        LOG.error('tutorial-meta scheduler failed:', e);
      }
    },
  });

  // Weekly Monday 09:00 — contributor notifications
  registerJob({
    jobName: 'contributor-notifications',
    schedule: '0 9 * * 1',
    ttlMs: 1800000,
    description: 'Weekly contributor notifications for stale tutorials',
    fn: (logId) => runContributorNotificationsCycle(logId),
  });

  // Every 4 hours — email retry
  registerJob({
    jobName: 'email-retry',
    schedule: '0 */4 * * *',
    ttlMs: 900000,
    description: 'Retry FailedEmails queue',
    fn: retryFailedEmails,
  });

  // Daily at 02:13 — knowledge-graph concept extraction (#381 PR 3).
  // Off-minute (:13) to avoid the :00/:30 thundering herd. 30-min TTL covers
  // a full pass of ~1400 tutorials at ~1s/tutorial cache-hit + ~3s/tutorial
  // LLM call up to KG_EXTRACT_BUILD_CAP (default 200/tick).
  registerJob({
    jobName: 'extractConcepts',
    schedule: '13 2 * * *',
    ttlMs: 30 * 60 * 1000,
    description: 'Knowledge-graph concept extraction (daily)',
    fn: runExtractConcepts,
  });

  // Weekly Sunday at 03:47 — knowledge-graph consolidation (#381 PR 4).
  // Off-minute (:47) and weekly cadence so the merge-on-write path during
  // extraction is the steady-state mechanism; this run mops up cross-batch
  // duplicates, auto-VETOes cycle-causing :requires edges, and rebuilds the
  // SPARQL projection. 30-min TTL matches extractConcepts.
  registerJob({
    jobName: 'consolidateConcepts',
    schedule: '47 3 * * 0',
    ttlMs: 30 * 60 * 1000,
    description: 'Knowledge-graph consolidation (weekly)',
    fn: runConsolidateConcepts,
  });

  // Weekly Sunday at 03:13 — Phase 4.1 Learning Journeys extraction (#447).
  // Off-minute (:13) per the project's cron-collision-avoidance convention.
  // 30-min TTL covers a full pass of ~200 journeys at ~5s/journey (cache hits)
  // or ~30s/journey (full extract path).
  registerJob({
    jobName: 'fetch-learning-journeys',
    schedule: '13 3 * * 0',
    ttlMs: 30 * 60 * 1000,
    description: 'Fetch SAP Learning Journeys + extract concepts (weekly)',
    fn: runFetchLearningJourneys,
  });

  // Daily at 04:23 — Phase 4.2 Blog Posts extraction (#447).
  // Off-minute (:23) per the project's cron-collision-avoidance convention.
  // 30-min TTL covers a full pass of ~200 posts at ~5s/post LLM call.
  // Operator must run scripts/seed-blog-posts.cjs once first; the cron
  // refuses to self-bootstrap on an empty BlogPosts table.
  registerJob({
    jobName: 'fetch-blog-posts',
    schedule: '23 4 * * *',
    ttlMs: 30 * 60 * 1000,
    description: 'Fetch SAP Community blog posts + extract concepts (daily)',
    fn: runFetchBlogPosts,
  });

  // Weekly Sunday at 03:07 — Phase 4.3 Discovery Missions extraction (#447).
  // Off-minute (:07) per the project's cron-collision-avoidance convention
  // (well-separated from :13 journey and :23 blog crons).
  // 30-min TTL covers a full pass of ~100-200 missions at ~5s/mission LLM call.
  // Full catalog upserts every cycle; contentHash gates per-mission LLM
  // extraction. Lazy-import keeps boot fast.
  registerJob({
    jobName: 'fetch-discovery-missions',
    schedule: '7 3 * * 0',
    ttlMs: 30 * 60 * 1000,
    description: 'Fetch BTP Discovery Center missions + extract concepts (weekly)',
    fn: async () => {
      const { runFetchDiscoveryMissions } = await import('./fetch-discovery-missions-job.js');
      return runFetchDiscoveryMissions();
    },
  });

  // Sunday + Wednesday at 03:11 — Phase 4.4 YouTube Videos extraction (#447).
  // Off-minute (:11) per cron-collision-avoidance convention (well-separated
  // from :07 discovery, :13 journey, :23 blog crons). Twice-weekly cadence
  // catches Developer News + Tech Bytes within 3 days of publish. Operator
  // must run scripts/seed-videos.cjs once first; the cron refuses to
  // self-bootstrap on an empty Videos table (MAX-or-abort gate).
  // 30-min TTL covers a steady-state pass of ~10 new videos. Lazy-import
  // keeps boot fast.
  registerJob({
    jobName: 'fetch-videos',
    schedule: '11 3 * * 0,3',
    ttlMs: 30 * 60 * 1000,
    description: 'Fetch SAP Developers YouTube videos + extract concepts (twice weekly)',
    fn: async () => {
      const { runFetchVideos } = await import('./fetch-videos-job.js');
      return runFetchVideos();
    },
  });

  // Monthly at 04:23 on day 1 — Phase 4.5 api.sap.com api-doc extraction (#746).
  // Off-minute (:23) shared with daily blog cron — they collide only once
  // every 1st-of-month; the second arrival waits for the lock to release.
  // Operator must run scripts/seed-api-docs.cjs once first (or click the
  // admin UI Seed button); the cron refuses to self-bootstrap on an empty
  // ApiDocs table (MAX-or-abort gate).
  // 30-min TTL covers a steady-state pass of ~60 packages from the
  // hand-curated YAML seed. Lazy-import keeps boot fast.
  //
  // #756: inline recordJobLastRun() removed — runWithLock chassis now
  // writes JobLastRun unconditionally in its finally block.
  registerJob({
    jobName: 'fetch-api-docs',
    schedule: '23 4 1 * *',
    ttlMs: 30 * 60 * 1000,
    description: 'Fetch api.sap.com api-doc catalog + extract concepts (monthly)',
    fn: async () => {
      const { runFetchApiDocs } = await import('./fetch-api-docs-job.js');
      return runFetchApiDocs();
    },
  });

  // Phase 4.6 (#747): weekly SAP-samples corpus refresh + concept-link extraction.
  // Operator must run scripts/seed-samples.cjs once first (or click the
  // admin UI Seed button); the cron refuses to self-bootstrap on an empty
  // Samples table (MAX-or-abort gate).
  // 30-min TTL covers a steady-state pass. Lazy-import keeps boot fast.
  // opts is threaded through #747's runJobByName extension as the 2nd
  // positional arg, enabling manual-trigger overrides (sinceIsoOverride,
  // budgetOverride) via admin action + scripts/seed-samples.cjs.
  registerJob({
    jobName: 'fetch-samples',
    schedule: '43 4 * * 0',
    ttlMs: 30 * 60 * 1000,
    description: 'Fetch SAP-samples GitHub repos + extract embodies concepts (weekly)',
    fn: async (logId, opts) => {
      const { runFetchSamples } = await import('./fetch-samples-job.js');
      return runFetchSamples(logId, opts);
    },
  });

  // Phase 4.7 (#748): weekly help-docs corpus refresh + concept-link extraction
  // across three sources (help.sap.com + cap.cloud.sap + ui5.sap.com).
  // Wednesday 05:17 UTC — off-cluster from the existing :00/:13/:23/:43 minute
  // grid (spec §3 Q8). Three-source fanout is slower than single-source
  // fetchers, so 45-min TTL is generous. Bootstrap via
  // scripts/seed-help-docs.cjs (or admin action) before the first automatic
  // run; the cron refuses to self-bootstrap on an empty HelpDocs table
  // (MAX-or-abort gate). opts threading (Phase 4.6 #757) already supports
  // manual-trigger overrides.
  registerJob({
    jobName: 'fetch-help-docs',
    schedule: '17 5 * * 3',
    ttlMs: 45 * 60 * 1000,
    description: 'Fetch narrative docs from help.sap.com + cap.cloud.sap + ui5.sap.com; extract explains concept links (weekly)',
    fn: async (logId, opts) => {
      const { runFetchHelpDocs } = await import('./fetch-help-docs-job.js');
      return runFetchHelpDocs(logId, opts);
    },
  });

  // Phase 4.8 (#765): twice-weekly cron for SAP community events (Khoros
  // CodeJams + Devtoberfest RSS). Smaller ttl than help-docs — the corpus
  // is compact and per-row work is lighter (short titles, no HTML fetch).
  registerJob({
    jobName: 'fetch-community-events',
    schedule: '31 4 * * 1,4',       // Mon+Thu 04:31 UTC
    ttlMs: 20 * 60 * 1000,           // 20 min — smaller than help-docs
    description: 'Fetch SAP community events (Khoros CodeJams + Devtoberfest RSS) and extract covers concept links (twice-weekly)',
    fn: async (logId, opts) => {
      const { runFetchCommunityEvents } = await import('./fetch-community-events-job.js');
      return runFetchCommunityEvents(logId, opts);
    },
  });

  // Weekly Sunday at 04:07 — Phase 4 cross-type GC.
  // Prunes content rows past lastSeenAt + 2×TTL when not pinned. Cascade-deletes
  // link entity rows via CDS Compositions on the parent entity, plus an explicit
  // sweep of sibling Associations (e.g. LearningJourneyPrerequisites.prerequisite)
  // in the GC job itself — see srv/jobs/gc-external-content-job.js.
  // Off-minute (:07) avoids the :00 thundering-herd. Lightweight job; 10-min TTL.
  registerJob({
    jobName: 'gc-external-content',
    schedule: '7 4 * * 0',
    ttlMs: 10 * 60 * 1000,
    description: 'GC external content past lastSeenAt + 2×TTL (weekly)',
    fn: runGcExternalContent,
  });

  // Phase 2-B (#464): Daily expiry check for tracked secrets.
  // Off-minute (04:11) avoids the :00 thundering-herd spike. 10-minute
  // lock matches similar lightweight jobs; the actual run is a single
  // SELECT + classification, well under a second.
  registerJob({
    jobName: 'secret-expiry-check',
    schedule: '11 4 * * *',
    ttlMs: 600000,
    description: 'Daily expiry check for tracked secrets',
    fn: runSecretExpiryCheck,
  });

  // Daily at 04:00 — nightly link-health check for HomepageShelves entries.
  // Runs after content GC (03:00) but well before peak traffic.
  // Spec §13.1 (#639).
  registerJob({
    jobName: 'homepage-link-health',
    schedule: '0 4 * * *',
    ttlMs: 30 * 60 * 1000,
    description: 'Nightly link-health check for HomepageShelves entries',
    fn: runHomepageLinkHealth,
  });

  // #805 — every 5 minutes, rotate the metrics module into MetricSnapshots rows.
  // NO job-lock: both CF instances write independently under the composite
  // primary key (windowStart, metric, instanceId). See spec § Rollout.
  registerJob({
    jobName: 'metrics-rollup',
    schedule: '*/5 * * * *',
    ttlMs: 60_000,
    description: '#805 5-min rollup — write MetricSnapshots rows',
    fn: () => runMetricsRollup(),
  });

  // #805 — daily retention. Off-minutes per project convention.
  registerJob({
    jobName: 'metrics-snapshots-retention',
    schedule: '17 4 * * *',
    ttlMs: 5 * 60_000,
    description: '#805 daily prune of MetricSnapshots older than 30 days',
    fn: () => cleanupMetricSnapshots(30),
  });
  registerJob({
    jobName: 'publish-timings-retention',
    schedule: '23 4 * * *',
    ttlMs: 5 * 60_000,
    description: '#805 daily prune of PublishTimings older than 90 days',
    fn: () => cleanupPublishTimings(90),
  });

  // #948: on-demand KG extraction drain. Every 2 minutes on odd minutes,
  // off-schedule vs. daily kg-pagerank (:53), kg-communities (:57), kg-wcc
  // (04:07), and the daily extractConcepts tick (02:13). Fail-open on every
  // fault path; skips entirely when KnowledgeGraphSettings.onDemandExtraction-
  // Enabled is false (default).
  //
  // CAP 10's .as(name) singleton semantics prevent concurrent scheduled ticks
  // across CF instances — the drain body itself does NOT call runWithLock.
  //
  // Spec: docs/superpowers/specs/2026-07-05-948-kg-ondemand-triggers-design.md
  registerJob({
    jobName: 'kg-ondemand-drain',
    schedule: '1-59/2 * * * *',
    ttlMs: 2 * 60 * 1000,
    description: 'On-demand knowledge-graph extraction drain (#948)',
    fn: runOnDemandDrain,
  });

  LOG.info('All scheduled jobs registered');

  // #756 (Task 1): pre-seed JobLastRun so the admin Cron health tile shows
  // all 24 jobs from day 1, even before any cron has fired.
  preSeedJobLastRun().catch(() => {/* already logged inside */});
}
