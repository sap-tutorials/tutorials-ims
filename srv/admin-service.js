import cds from '@sap/cds';
import { computeEventStatistics, computeBurnup, computeTrackStats, computeCompletionSpeed } from './lib/event-statistics.js';
import { formatTaskRecordsCSV, formatAwardMissionsCSV } from './lib/export-helpers.js';
import { getNextLegacyId } from './lib/legacy-id.js';
import { embedSlugs } from './lib/embedding-pipeline.js';
import { randomUUID } from 'node:crypto';
import { parsePayload, classify, apply, sharedCache, MAX_BYTES } from './lib/tag-import/index.js';
import { buildCfLogsUrl } from './lib/cf-logs-link.js';
import { resolveDisplaySettings } from './lib/runtime-config/display-settings.js';
import { reviewTutorial, snoozeTutorial } from './lib/tutorial-review.js';
import { slugify, ensureUniqueSlug } from './lib/slug-utils.js';
import { classifyAndPersist } from './lib/category-classifier.js';
import { makeAltGroupHandler } from './handlers/completion-path-items-altgroup.js';
import * as advocateHandlers from './handlers/advocate-handlers.js';
import * as devtoberfestBannerHandlers from './handlers/devtoberfest-banner-handlers.js';
import { classifySeverity, daysUntil } from './jobs/secret-expiry-check.js';
import { readSecret, writeSecret, deleteSecret } from './lib/credstore.js';
import { invalidateSecret } from './lib/secret-resolver.js';
import { checkSecretPresence, invalidatePresence } from './lib/secret-presence.js';
import { invalidateInstallationToken } from './lib/github-app-token.js';
import { scheduleRebuild } from './lib/rebuild-trigger.js';
import { createAuditEmitter } from './lib/audit-event.js';
import { handleRebuildAction } from './lib/rebuild-action-handler.js';
import { attachTagsMdFormatHandlers } from './lib/tag-md-format-handlers.js';
import { cleanupChangeLog, cleanupUnusedTags } from './jobs/cleanup.js';
import { ensureDevtoberfestActiveFlagInvariant } from './lib/devtoberfest-active-flag.js';
import { enrichSignupRows } from './lib/devtoberfest-signup-enrich.js';
import { getTutorialSource } from './lib/content-store.js';
import { isDeltaRead, bustContentDeltaFlagsCache } from './lib/content-delta-flags.js';
import { buildTutorialLinks } from './lib/tutorial-links.js';
import { buildPreviewLinks } from './lib/preview-links.js';
import { runSeedApiDocs } from './lib/seed-api-docs.js';
import { randomBytes } from 'node:crypto';
import * as khorosCache from './lib/khoros-cache.js';
import { listCtaTargets } from './lib/alert-cta-targets.js';
import { raiseTest } from './lib/alerting.js'; // #1469 admin test alert
import { isAllowedTarget } from './lib/redirect-allowlist.js';
import { validatePuzzle } from './lib/puzzle-grading.js';
import { recomputeSnapshot } from './lib/featured-topics-snapshot.js';
import { validateApiQuery } from './lib/khoros-transport.js';
import { COMMUNITY_BLOG_SOURCE_DEFAULTS, backfillManagedApiQuery } from './lib/community-blog-source-defaults.js';
import { resetFtCache, resetCommunityBlogsCache } from './homepage-service.js';
import { runReshuffleVideoRotation } from './jobs/reshuffle-video-rotation.js';
import * as metrics from './lib/metrics.js';
import {
  listAlertSeverities,
  listAlertAudiences,
} from './lib/alert-enums.js';
import { _getJobRegistry, runJobByName } from './jobs/scheduler.js';
import { deleteStuckOutboxRow, loadStuckOutboxTargets, isRowStale } from './lib/scheduler-wedge.js';
import { forceCloseRunningPipelineLog } from './lib/pipeline-log-reconciler.js';
import { enumerateFiringsWithinWindow, nextRunIsoFrom } from './lib/cron-firings.js';
import { validateTags, KNOWN_TAGS } from './lib/homepage/persona-tag-validator.js';
import { VERB_DEFAULTS, SHELF_DEFAULTS } from './lib/homepage/verb-shelf-defaults.js';   // #1089
import { computeKgCommunityFingerprint } from './lib/kg-community-fingerprint.js';
import * as mcpAdmin from './lib/mcp-admin-tools.js';   // #1106 Phase 3 (WS2) admin MCP tools
import { computeCoverage, resolveThreshold } from './lib/kg-community-coverage.js'; // #1172
import { resolveFeatureFlags } from './lib/feature-flags/resolve.js'; // #feature-flags
import { resetFeaturedCache } from './lib/featured-resolve.js';

// #756: max jobName payload length. Matches JobLocks.jobName : String(100)
// column width verified in db/schema.cds:412.
const MAX_JOB_NAME_LEN = 100;

/**
 * Emit a SecurityEvent audit row for the manual-trigger lifecycle.
 *
 * Two invocations per click: one with outcome='started' synchronously
 * on the runJob action; one with outcome ∈ {success, error}
 * after the cron resolves (#958 retired the 'lockheld' outcome — CAP 10's
 * .as(name) singleton locking replaced the JobLocks acquire path).
 *
 * Exported so srv/jobs/scheduler.js can lazy-import this from inside
 * runWithLock's emitJobAuditSafely wrapper (circular-import-safe).
 *
 * The first arg to auditEvent is the ACTION NAME (per
 * srv/lib/audit-event.js JSDoc) — NOT 'SecurityEvent', which is the
 * audit-log event type hardcoded inside the createAuditEmitter closure.
 * Do NOT lift the seedApiDocs precedent literally (admin-service.js:1765)
 * — it has a subtle bug (filed as #769) where 'SecurityEvent' is passed
 * as the first arg with a nested action: in data, working only by
 * spread-override luck.
 *
 * Module-state caveat: `_moduleAuditEvent` is set inside the service
 * init() once at boot. Tests that import this module BEFORE the service
 * init has run will observe `_moduleAuditEvent === null` and the warn-
 * log degraded path. Tests inside a single `describe` block using
 * cds.test() / cds.deploy() in beforeAll boot the service once and the
 * pointer is set for the rest of the run.
 *
 * Spec: docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md §4.8
 *
 * @param {{jobName: string, user?: string, outcome: 'started'|'success'|'error'|'unwedged'|'force-closed', durationMs?: number, startedAt?: Date}} opts
 * @returns {Promise<void>}
 */
export async function emitJobAudit({ jobName, user, outcome, durationMs = null, startedAt = null }) {
  const auditEvent = _moduleAuditEvent;
  if (!auditEvent) {
    // Service not yet initialized OR audit-log binding unavailable.
    // Log + return — never fail the cron because of audit emission.
    console.warn('emitJobAudit: auditEvent not initialized; skipping');
    return;
  }
  try {
    await auditEvent('cron.manual-trigger', {
      jobName,
      user,
      outcome,
      ...(durationMs != null && { durationMs }),
      ...(startedAt != null && { startedAt: startedAt.toISOString() }),
    });
  } catch (err) {
    console.warn(`emitJobAudit ${jobName}/${outcome} failed: ${err.message}`);
  }
}

// Module-level closure pointer. Set by the service init() right after
// auditEvent = createAuditEmitter(...). Allows emitJobAudit to be a
// module-level export (so scheduler.js can dynamic-import it) while
// still benefiting from the service-init's audit-log binding
// resolution.
let _moduleAuditEvent = null;

/**
 * Dedupe TaskRecord rows by (user_ID, taskLegacyId), preferring rows on a
 * later attemptNumber and (tiebreaker) rows with a populated completionDate.
 * Used by "has-ever-completed" rollups in this service so a user with
 * multiple attempts of the same task (one SUPERSEDED + one COMPLETED, or
 * two SUPERSEDED + one IN_PROGRESS, etc.) counts as ONE logical completion.
 * See issue #600 / spec read-site audit table.
 */
function dedupeByUserTaskRecords(rows) {
  const best = new Map();
  for (const r of rows) {
    const key = `${r.user_ID} ${r.taskLegacyId}`;
    const cur = best.get(key);
    if (!cur) { best.set(key, r); continue; }
    const curAttempt = cur.attemptNumber ?? 1;
    const rAttempt = r.attemptNumber ?? 1;
    if (rAttempt > curAttempt) { best.set(key, r); continue; }
    if (rAttempt === curAttempt && !cur.completionDate && r.completionDate) {
      best.set(key, r);
    }
  }
  return [...best.values()];
}

/**
 * Shared implementation for sendLastChanceEmail (per-author) and
 * sendLastChanceEmailsAllDormant (bulk). Pure relative to `ctx` — the
 * dynamically-imported helpers are passed in so this function is unit-
 * testable in isolation.
 *
 * @param {string} authorEmail
 * @param {boolean} dryRun
 * @param {object} ctx  spread of contributor-notifications + mail-client exports
 * @returns {Promise<{success: boolean, recipientTo: string, recipientCc: string[],
 *                    tutorialsIncluded: number, tutorialSlugs: string[], error: string}>}
 */
async function sendLastChanceForAuthor(authorEmail, dryRun, ctx) {
  const emptyPayload = {
    recipientTo: '', recipientCc: [], tutorialsIncluded: 0, tutorialSlugs: [],
  };
  if (!authorEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorEmail)) {
    return { success: false, error: 'Invalid authorEmail', ...emptyPayload };
  }

  const knobs = await ctx.resolveTimingKnobs();
  const adminEmails = await ctx.getAdminEmailList();
  const notifications = await ctx.computeStaleNotifications(knobs);
  const digests = ctx.groupNotificationsByAuthor(notifications);
  const target = digests.find(d => d.authorEmail?.toLowerCase() === authorEmail.toLowerCase());

  if (!target) {
    return {
      success: false,
      error: 'No stale tutorials found for that author',
      ...emptyPayload,
    };
  }

  const { to, cc } = ctx.determineRecipientsForDigest(target, adminEmails);
  const dashboardUrl = (await resolveDisplaySettings()).dashboardUrl;
  const count = target.tutorials.length;
  const plural = count === 1 ? 'tutorial' : 'tutorials';
  const payload = {
    to, cc,
    subject: `Final notice: ${count} ${plural} pending retirement`,
    template: 'last-chance',
    variables: {
      authorName: target.authorName || 'Tutorial Owner',
      tutorialCount: count,
      tutorialPlural: plural,
      tutorialListHtml: ctx.renderTutorialList(target.tutorials, dashboardUrl),
      staleDaysThreshold: knobs.staleDays,
      dashboardUrl,
    },
  };

  if (dryRun) {
    return {
      success: true,
      recipientTo: to[0] ?? '',
      recipientCc: cc,
      tutorialsIncluded: count,
      tutorialSlugs: target.tutorials.map(t => t.slug),
      error: '',
    };
  }

  const result = await ctx.sendNotificationEmail(payload);
  if (result.success) {
    for (const t of target.tutorials) await ctx.markNotificationSent(t.tutorialId);
  }
  return {
    success: result.success,
    recipientTo: to[0] ?? '',
    recipientCc: cc,
    tutorialsIncluded: count,
    tutorialSlugs: target.tutorials.map(t => t.slug),
    error: result.error ?? '',
  };
}

// (#763) Validate personaTags / personaHidden arrays against PROFILE_VOCAB.
// Called as before-CREATE/UPDATE on HomepageShelves and HomepageForYouCandidatesAdmin.
// Uses req.reject(400, message) to surface validation errors. Field-level display
// of invalid tags in Fiori Elements is a follow-up (see Task 17).
function checkPersonaTagsHandler(req) {
  for (const field of ['personaTags', 'personaHidden']) {
    const tags = req.data?.[field];
    if (tags == null) continue;
    const v = validateTags(tags);
    if (!v.ok) {
      return req.reject(400, `Unknown persona tag(s): ${v.invalid.join(', ')}`);
    }
  }
}

export default class AdminService extends cds.ApplicationService {

  async init() {
    const { Users, Tutorials, Missions, Groups, Events, TaskRecords,
            StepFailures, Tags, TutorialTags, UserMetaData,
            PrimaryAccounts, SecondaryAccounts, PrivacyProtectionActions,
            FeaturedTasks, CompletionPaths, CompletionPathItems,
            ChatSettings, ContentManifest, ContentFiles,
            GroupSlugRedirects, MissionSlugRedirects } = cds.entities('com.sap.developers.ims');
    const db = await cds.connect.to('db');

    // Serve enum code lists (no DB table — @cds.persistence.skip)
    this.on('READ', 'ExperienceLevels', () => [
      { code: 'beginner' }, { code: 'intermediate' }, { code: 'advanced' }
    ]);
    this.on('READ', 'TaskStatuses', () => [
      { code: 'ACTIVE' }, { code: 'INACTIVE' }
    ]);
    this.on('READ', 'MissionTypes', () => [
      { code: 'SEQUENTIAL' }, { code: 'SET' }
    ]);
    this.on('READ', 'TaskTypes', () => [
      { code: 'TUTORIAL' }, { code: 'GROUP' }, { code: 'CHECKPOINT' }
    ]);
    // Issue #715 — EventTypes DDLB. Codes mirror the EventType enum in
    // db/schema.cds:19 exactly (drift would surface as @assert.range
    // rejection on write). Labels are display-only.
    this.on('READ', 'EventTypes', () => [
      { code: 'DEVTOBERFEST', label: 'Devtoberfest' },
      { code: 'TECHED',       label: 'TechEd'       },
      { code: 'CODEJAM',      label: 'CodeJam'      },
      { code: 'CHALLENGE',    label: 'Challenge'    },
      { code: 'OTHER',        label: 'Other'        },
    ]);
    // Issue #718 — Alerts severity & audience DDLBs. Codes mirror the
    // inline enums on db/schema.cds:467-471 exactly (drift would surface
    // as @assert.range rejection on write). Labels are display-only.
    this.on('READ', 'AlertSeverities', () => listAlertSeverities());
    this.on('READ', 'AlertAudiences',  () => listAlertAudiences());
    // HomepageShelves verb & shelf DDLBs. Codes mirror the HomepageVerb /
    // HomepageShelf enums in db/homepage.cds:9,17 exactly (drift would surface
    // as @assert.range rejection on write). The record-form @Common.ValueList
    // bound to these makes verb/shelf RPT-1-eligible (@cap-js/ai keys on
    // @Common.ValueList.CollectionPath). Labels are display-only.
    this.on('READ', 'VerbChoices', () => [
      { code: 'LEARN',     label: 'Learn'     },
      { code: 'BUILD',     label: 'Build'     },
      { code: 'INTEGRATE', label: 'Integrate' },
      { code: 'MODEL',     label: 'Model'     },
      { code: 'OPERATE',   label: 'Operate'   },
      { code: 'AI',        label: 'AI'        },
      { code: 'CONNECT',   label: 'Connect'   },
    ]);
    this.on('READ', 'ShelfChoices', () => [
      { code: 'START_HERE',   label: 'Start here'   },
      { code: 'REFERENCE',    label: 'Reference'    },
      { code: 'TOOLS',        label: 'Tools'        },
      { code: 'KEEP_CURRENT', label: 'Keep current' },
    ]);
    // Value help for HomepageShelves/HomepageForYouCandidates.linkStatusOverride.
    // Only the three deliberate pin targets — UNKNOWN is a job sentinel and blank
    // (cleared) is the "auto-detect" state, so neither belongs in the picker.
    this.on('READ', 'LinkStatusChoices', () => [
      { code: 'OK',     label: 'OK (force healthy)' },
      { code: 'SLOW',   label: 'Slow'               },
      { code: 'BROKEN', label: 'Broken'             },
    ]);
    this.on('READ', 'AdvocateRegions', () => [
      { code: 'AMERICAS', label: 'Americas' },
      { code: 'EMEA',     label: 'EMEA' },
      { code: 'APJ',      label: 'APJ' },
    ]);
    // AdvocateLinks.kind DDLB. Keep in sync with the enum on
    // db/advocates.cds:AdvocateLinks.kind — both are source-of-truth (the
    // DDLB drives the admin UI, the @assert.range enum rejects out-of-band
    // writes). Labels are display-only; the `code` is what's persisted.
    this.on('READ', 'AdvocateLinkKinds', () => [
      { code: 'LinkedIn',     label: 'LinkedIn'      },
      { code: 'X',            label: 'X (Twitter)'   },
      { code: 'Mastodon',     label: 'Mastodon'      },
      { code: 'BlueSky',      label: 'BlueSky'       },
      { code: 'GitHub',       label: 'GitHub'        },
      { code: 'YouTube',      label: 'YouTube'       },
      { code: 'Blog',         label: 'Blog'          },
      { code: 'SapCommunity', label: 'SAP Community' },
      { code: 'Email',        label: 'Email'         },
      { code: 'Other',        label: 'Other'         },
    ]);
    this.on('READ', 'AnalyticsTaskTypes', () => [
      { code: 'TUTORIAL', label: 'Tutorial' },
      { code: 'GROUP',    label: 'Group'    },
      { code: 'MISSION',  label: 'Mission'  },
      // Issue #644 — Puzzle surfaces in admin analytics dropdowns. The
      // matching @analytics.exposed entity association lives on
      // db/views.cds TaskRecordsAnalytics.
      { code: 'PUZZLE',   label: 'Puzzle'   },
      // Task 8 — Petoberfest surfaces in admin analytics dropdowns. The
      // matching association lives on db/views.cds TaskRecordsAnalytics.
      { code: 'PETOBERFEST', label: 'Petoberfest' }
    ]);
    this.on('READ', 'AnalyticsLevels', () => [
      { code: 'beginner',     label: 'Beginner'     },
      { code: 'intermediate', label: 'Intermediate' },
      { code: 'advanced',     label: 'Advanced'     }
    ]);
    // Devtoberfest Signups report filter DDLBs (spec 2026-08-13). Codes mirror
    // UserLearningPreferences.preferredEventRegion / role (db/schema.cds:259,270)
    // plus the 'Not set' sentinel the DevtoberfestSignupAnalytics view coalesces
    // nulls to, so the filter can isolate users who never set a preference.
    this.on('READ', 'SignupRegions', () => [
      { code: 'AMERICAS', label: 'Americas' },
      { code: 'EMEA',     label: 'EMEA'     },
      { code: 'APJ',      label: 'APJ'      },
      { code: 'VIRTUAL',  label: 'Virtual'  },
      { code: 'Not set',  label: 'Not set'  },
    ]);
    this.on('READ', 'SignupRoles', () => [
      { code: 'developer', label: 'Developer' },
      { code: 'architect', label: 'Architect' },
      { code: 'sysadmin',  label: 'System Admin' },
      { code: 'student',   label: 'Student'   },
      { code: 'Not set',   label: 'Not set'   },
    ]);
    // Devtoberfest Signups analytics — derive human-readable week label + Monday
    // date from the portable integer weekIndex, and a running cumulative on the
    // pure by-week series. $apply aggregation cannot produce either natively.
    // Logic lives in the pure, unit-tested helper srv/lib/devtoberfest-signup-enrich.js.
    this.after('READ', 'DevtoberfestSignupAnalytics', (rows) => enrichSignupRows(rows));


    // Pipeline / Job log dropdowns. PipelineTypes excludes SCHEDULED_JOB because
    // the PipelineLog projection (admin-service.cds:115) filters it out — those
    // rows land in JobExecutionLog instead. PipelineStatuses is shared by both
    // projections.
    this.on('READ', 'PipelineTypes', () => [
      { code: 'CONTENT_PUBLISH',  label: 'Content Publish'  },
      { code: 'HUGO_BUILD',       label: 'Hugo Build'       },
      { code: 'MTA_DEPLOY',       label: 'MTA Deploy'       },
      { code: 'GITHUB_DISPATCH',  label: 'GitHub Dispatch'  }
    ]);
    this.on('READ', 'PipelineStatuses', () => [
      { code: 'RUNNING', label: 'Running' },
      { code: 'SUCCESS', label: 'Success' },
      { code: 'FAILED',  label: 'Failed'  }
    ]);
    // Account-merge status (mirrors IMS Java AccountMergeStatus enum).
    // CREATED     = user pair queued for merge, not yet picked up
    // IN_PROGRESS = merge actively running (rare; usually flips fast)
    // SCHEDULED   = waiting for the next account-merge-job cron tick
    // COMPLETED   = merge finished, secondary's TaskRecords/etc reassigned to primary
    // FAILED      = merge errored; row stays for forensic inspection
    this.on('READ', 'AccountMergeStatuses', () => [
      { code: 'CREATED',     label: 'Created'     },
      { code: 'IN_PROGRESS', label: 'In Progress' },
      { code: 'SCHEDULED',   label: 'Scheduled'   },
      { code: 'COMPLETED',   label: 'Completed'   },
      { code: 'FAILED',      label: 'Failed'      }
    ]);
    // Change-tracking modification dropdown — values are the i18n-resolved
    // ChangeView.modificationLabel strings (NOT the underlying db enum
    // codes), so they match what FE displays in the list-report. The
    // plugin's i18n hardcodes English Create/Update/Delete.
    this.on('READ', 'ChangeTypes', () => [
      { code: 'create', label: 'Create' },
      { code: 'update', label: 'Update' },
      { code: 'delete', label: 'Delete' }
    ]);
    // Privacy DSR action types — mirrors PrivacyProtectionActions.actionType
    // enum on the db side (SEARCH/DOWNLOAD/ANONYMIZE).
    this.on('READ', 'PrivacyActionTypes', () => [
      { code: 'SEARCH',    label: 'Search'    },
      { code: 'DOWNLOAD',  label: 'Download'  },
      { code: 'ANONYMIZE', label: 'Anonymize' }
    ]);

    // READ handler for the unbound in-memory AlertCtaTargets entity.
    this.on('READ', 'AlertCtaTargets', () => listCtaTargets());

    // (#763) READ handler for the unbound value-help entity PersonaTagChoices.
    // Returns all KNOWN_TAGS as { tag } rows for @Common.ValueList bindings on
    // HomepageShelves.personaTags / personaHidden.
    this.on('READ', 'PersonaTagChoices', () => KNOWN_TAGS.map((tag) => ({ tag })));

    // Default featuredOrder to max+1 so admins rarely type it.
    this.before('CREATE', 'FeaturedTasks', async (req) => {
      if (req.data.featuredOrder == null) {
        const { FeaturedTasks } = cds.entities('com.sap.developers.ims');
        const [row] = await db.run(SELECT.from(FeaturedTasks).columns('max(featuredOrder) as maxOrder'));
        req.data.featuredOrder = (row?.maxOrder ?? 0) + 1;
      }
    });

    // Bust the /build/featured cache on any curation change (draft activate + delete).
    this.after(['SAVE', 'CREATE', 'UPDATE', 'DELETE'], 'FeaturedTasks', () => {
      resetFeaturedCache();
    });

    // Value-help union for FeaturedTasks. Reads live from the three content
    // entities; honors $search/$filter/$top so FE type-ahead works.
    this.on('READ', 'FeaturedTaskCandidates', async (req) => {
      const { Missions, Groups, Tutorials } = cds.entities('com.sap.developers.ims');
      try {
        const [missions, groups, tutorials] = await Promise.all([
          db.run(SELECT.from(Missions).columns('legacyId', 'title', 'slug').where({ published: true })),
          db.run(SELECT.from(Groups).columns('legacyId', 'title', 'slug').where({ published: true })),
          db.run(SELECT.from(Tutorials).columns('legacyId', 'title', 'slug').where(`status = 'ACTIVE' or status is null`)),
        ]);
        let rows = [
          ...missions.map(m => ({ taskLegacyId: m.legacyId, taskType: 'MISSION', title: m.title || '', slug: m.slug || '' })),
          ...groups.map(g => ({ taskLegacyId: g.legacyId, taskType: 'GROUP', title: g.title || '', slug: g.slug || '' })),
          ...tutorials.map(t => ({ taskLegacyId: t.legacyId, taskType: 'TUTORIAL', title: t.title || '', slug: t.slug || '' })),
        ].filter(r => r.taskLegacyId != null && r.slug);

        // Honor a free-text search term from the value-help type-ahead.
        const term = req.query?.SELECT?.search?.[0]?.val
          ?? req._?.req?.query?.$search;
        if (term) {
          const t = String(term).replace(/(^"|"$)/g, '').toLowerCase();
          rows = rows.filter(r => r.title.toLowerCase().includes(t));
        }
        return rows;
      } catch (e) {
        req.warn?.(`FeaturedTaskCandidates READ failed: ${e.message}`);
        return [];
      }
    });

    // Feature Flag Viewer (#feature-flags): synthesize rows from the registry.
    // FeatureFlags is a @cds.persistence.skip entity, so there is no generic
    // DB handler behind us — this on('READ') must itself honor the OData query
    // options FE emits, or (a) the ObjectPage key-read `FeatureFlags(key='X')`
    // returns the whole array and FE renders row 0 every time, and (b) the
    // ListReport's $skip/$top paging is ignored so later rows never appear.
    this.on('READ', 'FeatureFlags', async (req) => {
      const all = await resolveFeatureFlags();
      const select = req.query?.SELECT ?? {};

      // 1) Key predicate → single-row read for the ObjectPage. CAP surfaces the
      //    key either as req.params[...] (keyed navigation) or as a `key = val`
      //    term in SELECT.where. Prefer params; fall back to parsing where.
      let keyVal;
      const params = req.params;
      if (Array.isArray(params) && params.length) {
        const last = params[params.length - 1];
        if (last && typeof last === 'object' && 'key' in last) keyVal = last.key;
        else if (typeof last === 'string') keyVal = last;
      }
      if (keyVal === undefined && Array.isArray(select.where)) {
        const w = select.where;
        for (let i = 0; i < w.length - 2; i++) {
          if (w[i]?.ref?.[0] === 'key' && w[i + 1] === '=' && w[i + 2] && 'val' in w[i + 2]) {
            keyVal = w[i + 2].val;
            break;
          }
        }
      }

      let rows = keyVal === undefined ? all : all.filter((r) => r.key === keyVal);

      // 2) $count=true → attach total (before paging) so FE's growing list and
      //    count header are correct.
      const wantsCount = select.count === true;
      const total = rows.length;

      // 3) $skip / $top → apply paging window from SELECT.limit. CQN wraps the
      //    numbers as { val: N } (and CAP injects a default limit of 1000 on
      //    every collection read), so unwrap before arithmetic — treating the
      //    wrapper object as a number yields NaN → slice(0,NaN) → [].
      const unwrap = (v) => (v && typeof v === 'object' && 'val' in v ? v.val : v);
      const offset = Number(unwrap(select.limit?.offset)) || 0;
      const rowsLimit = unwrap(select.limit?.rows);
      const rowsLimitNum = rowsLimit == null ? null : Number(rowsLimit);
      if (offset || rowsLimitNum != null) {
        rows = rows.slice(offset, rowsLimitNum != null ? offset + rowsLimitNum : undefined);
      }

      if (wantsCount) rows.$count = total;
      return rows;
    });

    // Virtual severityCrit element (drives @UI.LineItem Criticality coloring).
    // Information=3 (Neutral), Success=5 (Positive), Warning=2 (Critical), Error=1 (Negative)
    this.after('READ', 'Alerts', rows => {
      const arr = Array.isArray(rows) ? rows : [rows];
      for (const r of arr) {
        if (!r) continue;
        switch (r.severity) {
          case 'Success':     r.severityCrit = 5; break;
          case 'Warning':     r.severityCrit = 2; break;
          case 'Error':       r.severityCrit = 1; break;
          case 'Information':
          default:            r.severityCrit = 3; break;
        }
      }
    });

    // ─── after(READ, Tutorials) — #918 WCC isolation flag ───────────────
    //
    // Populate the virtual `isolated : Boolean` field on each Tutorials
    // row from the KgIsolation sidecar (populated nightly by
    // srv/jobs/kg-wcc-job.js). Batched per page — Fiori Elements requests
    // 30 rows/page by default, so this is one small IN-clause query per
    // list-report page load. Same shape as the after('READ', 'Concepts')
    // handler in srv/knowledge-graph-service.js.
    //
    // Fail-quiet: on any error (sidecar missing, HANA hiccup, deploy
    // skew), leave `isolated` unset. Fiori renders `null` boolean as no
    // badge — same visual result as false. No request-time throw ever
    // propagates to the client.
    //
    // Spec: docs/superpowers/specs/2026-07-04-918-kg-wcc-isolation-design.md
    this.after('READ', 'Tutorials', async (rows, req) => {
      const arr = Array.isArray(rows) ? rows : [rows];
      const slugs = arr.filter(Boolean).map((r) => r.slug).filter(Boolean);
      if (slugs.length === 0) return;
      try {
        const placeholders = slugs.map(() => '?').join(',');
        const flagged = await cds.tx(req).run(
          `SELECT SLUG FROM "COM_SAP_DEVELOPERS_IMS_KGISOLATION" ` +
            `WHERE VERTEXTYPE = ? AND SLUG IN (${placeholders})`,
          ['tutorial', ...slugs],
        );
        const set = new Set(flagged.map((r) => r.SLUG));
        for (const r of arr) {
          if (r && r.slug) r.isolated = set.has(r.slug);
        }
      } catch (err) {
        cds.log('kg-wcc').warn(
          `admin-service: isolated flag lookup failed on Tutorials; leaving field unset (${err?.message ?? err})`,
        );
      }
    });

    // ─── after(READ, Tutorials) — lifecycle source & preview links ──────
    //
    // Populate the 8 virtual link fields for ACTIVE tutorials only. QA + main
    // preview links are relative (env-correct) and depend only on the slug, so
    // they're set unconditionally for ACTIVE rows. GitHub source/Contributions
    // links need the live repo mapping, read from RepoCatalog in one batched
    // IN-clause query (same shape as the isolated handler above).
    //
    // Fail-quiet: on any RepoCatalog SELECT error, leave the GitHub fields
    // unset (QA/main already set) — never throw to the client. Mirrors the
    // #918 isolated-flag posture.
    //
    // Spec: docs/superpowers/specs/2026-07-28-tutorial-lifecycle-source-preview-links-design.md
    this.after('READ', 'Tutorials', async (rows, req) => {
      const arr = Array.isArray(rows) ? rows : [rows];
      const active = arr.filter((r) => r && r.status === 'ACTIVE' && r.slug);
      if (active.length === 0) return;

      // Best-effort RepoCatalog lookup keyed by slug → {owner, repo, branch}.
      const catalog = new Map();
      try {
        const slugs = active.map((r) => r.slug);
        const placeholders = slugs.map(() => '?').join(',');
        const catRows = await cds.tx(req).run(
          `SELECT SLUG, OWNER, REPO, BRANCH FROM "COM_SAP_DEVELOPERS_IMS_REPOCATALOG" ` +
            `WHERE SLUG IN (${placeholders})`,
          slugs,
        );
        for (const c of catRows) {
          catalog.set(c.SLUG, { owner: c.OWNER, repo: c.REPO, branch: c.BRANCH });
        }
      } catch (err) {
        cds.log('admin').warn(
          `tutorial links: RepoCatalog lookup failed; GitHub links left unset (${err?.message ?? err})`,
        );
      }

      for (const r of active) {
        const cat = catalog.get(r.slug) || {};
        Object.assign(
          r,
          buildTutorialLinks({
            status: r.status,
            slug: r.slug,
            owner: cat.owner,
            repo: cat.repo,
            branch: cat.branch,
          }),
        );
      }
    });

    // ─── after(READ, Missions/Groups) — published-only preview links ────
    //
    // Populate the 4 virtual preview-link fields for published rows only.
    // Missions/Groups are served on /tutorials/{mission|group}-{slug}
    // (content-store.js catalog branch), so the links carry that prefix.
    // Pure computation over fields already on the row — no DB lookup, no
    // throw source; the defensive `if (!r) continue` guards a malformed row.
    //
    // Spec: docs/superpowers/specs/2026-07-28-mission-group-preview-links-design.md
    //
    // FE column-injection guard: Fiori Elements V4 builds a column-limited
    // $select from OP annotations only. Neither Missions nor Groups OP
    // references `slug`, so FE never requests it, and the after('READ')
    // decorator would see r.slug === undefined → helper hits its !slug guard →
    // all links render as empty cells for every published row.
    //
    // Fix: when an explicit SELECT column list exists, ensure both `slug` and
    // `published` are in it before the query hits the DB. If columns is
    // undefined (SELECT *) we do nothing — all columns are already coming back.
    this.before('READ', ['Missions', 'Groups'], (req) => {
      const cols = req.query?.SELECT?.columns;
      if (!Array.isArray(cols)) return; // SELECT * — nothing to do
      const has = (name) => cols.some((c) => c.ref && c.ref[c.ref.length - 1] === name);
      if (!has('slug'))      cols.push({ ref: ['slug'] });
      if (!has('published')) cols.push({ ref: ['published'] });
    });

    this.after('READ', 'Missions', (rows) => {
      const arr = Array.isArray(rows) ? rows : [rows];
      for (const r of arr) {
        if (!r) continue;
        Object.assign(r, buildPreviewLinks({ published: r.published, slug: r.slug, kind: 'mission' }));
      }
    });

    this.after('READ', 'Groups', (rows) => {
      const arr = Array.isArray(rows) ? rows : [rows];
      for (const r of arr) {
        if (!r) continue;
        Object.assign(r, buildPreviewLinks({ published: r.published, slug: r.slug, kind: 'group' }));
      }
    });

    // #1018 — populate the virtual `hasValue : Boolean` field on each
    // Secrets row. Fires on every /admin-ui/#secrets List Report refresh.
    // Uses the shared 5-min presence cache so the 11-row LR doesn't hammer
    // credstore on every $refresh. Fail-quiet: on any error, leave the
    // field unset (Fiori renders null boolean as no badge — better than
    // showing "missing" for what might be a transient credstore blip).
    //
    // Purpose: today's failure mode (2026-07-06) was a row that showed
    // `lastRotatedAt` set + happy admin-UI status, but the credstore
    // itself had no value. Admin visually indistinguishable from a
    // working row. This surface makes the miss obvious in the LR.
    this.after('READ', 'Secrets', async (rows, req) => {
      const arr = Array.isArray(rows) ? rows : [rows];
      const keys = arr.filter(Boolean).map((r) => r.key).filter(Boolean);
      if (keys.length === 0) return;
      try {
        const entries = await Promise.all(
          keys.map(async (k) => [k, await checkSecretPresence(k)]),
        );
        const presence = new Map(entries);
        for (const r of arr) {
          if (r && r.key) r.hasValue = presence.get(r.key) ?? false;
        }
      } catch (err) {
        cds.log('admin-service').warn(
          `Secrets hasValue lookup failed; leaving field unset (${err?.message ?? err})`,
        );
      }
    });

    // Ensure singleton row exists for ChatSettings (defensive — seed CSV
    // populates this on cds deploy; this covers fresh in-memory test DBs).
    const CHAT_SETTINGS_SINGLETON_ID = '00000000-0000-0000-0000-00000000c8a7';
    this.before('READ', 'ChatSettings', async () => {
      const exists = await SELECT.one.from('com.sap.developers.ims.ChatSettings')
        .where({ ID: CHAT_SETTINGS_SINGLETON_ID });
      if (!exists) {
        await INSERT.into('com.sap.developers.ims.ChatSettings').entries({
          ID: CHAT_SETTINGS_SINGLETON_ID,
          enabled: false,
          maxRequestsPerUser: 100
        });
      }
    });

    // DevtoberfestConfig is multi-row + draft-enabled (spec 2026-06-24).
    // The `isActive` flag enforces "at most one active row" via a CDS
    // handler instead of a DB-level partial index. When a draft is
    // activated with isActive=true, deactivate every OTHER row in the
    // same transaction so the invariant always holds.
    this.before(['CREATE', 'UPDATE', 'NEW', 'PATCH'], 'DevtoberfestConfig', async (req) => {
      await ensureDevtoberfestActiveFlagInvariant(req);
    });

    // #752: LegacyRedirects.toPath must be a same-origin absolute path or an
    // https URL on an allowlisted SAP host. The resolver rejects disallowed
    // external targets at index-build time as a backstop, but this hook stops
    // bad rows from being written at all so the admin gets immediate feedback
    // rather than silently-dropped redirects.
    this.before(['CREATE', 'UPDATE', 'NEW', 'PATCH'], 'LegacyRedirects', async (req) => {
      const toPath = req.data?.toPath;
      if (toPath === undefined) return; // PATCH that doesn't touch toPath — fine
      if (typeof toPath !== 'string' || toPath.length === 0) {
        return req.reject(400, 'toPath is required and must be a non-empty string');
      }
      if (!isAllowedTarget(toPath)) {
        return req.reject(400, 'toPath must be a same-origin path (/…) or an https URL on an allowlisted SAP host (community.sap.com, pages.community.sap.com, opensource.sap.com, www.sap.com, help.sap.com)');
      }
    });

    // Ensure singleton row exists for KnowledgeGraphSettings. The seed CSV is
    // header-only (no data row); without this hook OData V4 returns 404 on the
    // singleton's first read. Defaults mirror the admin form's placeholders.
    // UUID is one greater than CHAT_SETTINGS_SINGLETON_ID (c8a7) by convention.
    const KG_SETTINGS_SINGLETON_ID = '00000000-0000-0000-0000-00000000c8a8';
    this.before('READ', 'KnowledgeGraphSettings', async () => {
      const exists = await SELECT.one.from('com.sap.developers.ims.KnowledgeGraphSettings')
        .where({ ID: KG_SETTINGS_SINGLETON_ID });
      if (!exists) {
        await INSERT.into('com.sap.developers.ims.KnowledgeGraphSettings').entries({
          ID: KG_SETTINGS_SINGLETON_ID,
          enabled: false,
          extractBuildCap: 200,
          mergeSimThreshold: 0.92,
          mergeSimThresholdExtract: 0.85
        });
      }
    });

    // Ensure singleton row exists for UiEventsSettings. The seed CSV stays
    // empty (HDI-clobbers-admin-edits footgun documented in
    // [feedback_cap_csv_seeds_clobber_admin_data]), so on a fresh subaccount
    // cutover (DevRel & Community Tools, 2026-06) the table is empty and
    // every PATCH from the admin UI returned 404 because OData singleton
    // semantics require the row to exist before write.
    // UUID convention: one greater than KG_SETTINGS_SINGLETON_ID (c8a8).
    const UI_EVENTS_SETTINGS_SINGLETON_ID = '00000000-0000-0000-0000-00000000c8a9';
    this.before('READ', 'UiEventsSettings', async () => {
      const exists = await SELECT.one.from('com.sap.developers.ims.UiEventsSettings')
        .where({ ID: UI_EVENTS_SETTINGS_SINGLETON_ID });
      if (!exists) {
        await INSERT.into('com.sap.developers.ims.UiEventsSettings').entries({
          ID: UI_EVENTS_SETTINGS_SINGLETON_ID,
          enabled: true   // matches the admin tile's "ON" default
        });
      }
    });

    // Ensure singleton rows exist for the four remaining @odata.singleton
    // projections (TenantSettings, DisplaySettings, SearchSettings, NavigatorSettings).
    // Same root cause + fix pattern as UiEventsSettings above: empty backing
    // table → OData v4 singleton READ returns 404 → admin-UI PATCH fails with
    // 404 because the target singleton doesn't exist for the update to land on.
    // Discovered 2026-06-26 when admin tiles for Tenant + Display silently
    // failed to save. The Search + Navigator handlers preempt the same trap.
    // Default values are lifted from each resolver's DEFAULTS object so an
    // operator opening the tile sees the same values the runtime would have
    // resolved anyway, then can edit-and-save without surprise.
    //
    // UUID convention continues sequentially from c8a9 (UiEvents).
    const TENANT_SETTINGS_SINGLETON_ID    = '00000000-0000-0000-0000-00000000c8aa';
    const DISPLAY_SETTINGS_SINGLETON_ID   = '00000000-0000-0000-0000-00000000c8ab';
    const SEARCH_SETTINGS_SINGLETON_ID    = '00000000-0000-0000-0000-00000000c8ac';
    const NAVIGATOR_SETTINGS_SINGLETON_ID = '00000000-0000-0000-0000-00000000c8ad';

    this.before('READ', 'TenantSettings', async () => {
      const exists = await SELECT.one.from('com.sap.developers.ims.TenantSettings')
        .where({ ID: TENANT_SETTINGS_SINGLETON_ID });
      if (!exists) {
        await INSERT.into('com.sap.developers.ims.TenantSettings').entries({
          ID: TENANT_SETTINGS_SINGLETON_ID,
          // Mirrors srv/lib/runtime-config/tenant-settings.js DEFAULTS so the
          // admin tile shows what the runtime would have resolved if the row
          // were absent. Operators edit-from-defaults; they don't face empty
          // fields and have to guess the right values.
          allowedCorsOrigins: 'http://localhost:1313,http://localhost:5000,http://localhost:4004',
          rebuildTargetEnv: 'dev',
          techUsers: '',
          techUsersMapping: ''
        });
      }
    });

    this.before('READ', 'DisplaySettings', async () => {
      const exists = await SELECT.one.from('com.sap.developers.ims.DisplaySettings')
        .where({ ID: DISPLAY_SETTINGS_SINGLETON_ID });
      if (!exists) {
        await INSERT.into('com.sap.developers.ims.DisplaySettings').entries({
          ID: DISPLAY_SETTINGS_SINGLETON_ID,
          // Mirrors srv/lib/runtime-config/display-settings.js DEFAULTS.
          dashboardUrl: 'https://tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/ui/tutorialDashboard'
        });
      }
    });

    this.before('READ', 'SearchSettings', async () => {
      const exists = await SELECT.one.from('com.sap.developers.ims.SearchSettings')
        .where({ ID: SEARCH_SETTINGS_SINGLETON_ID });
      if (!exists) {
        await INSERT.into('com.sap.developers.ims.SearchSettings').entries({
          ID: SEARCH_SETTINGS_SINGLETON_ID,
          // Mirrors srv/lib/runtime-config/search-settings.js DEFAULTS.
          rateLimitMax: 60,
          rateLimitWindowMs: 60_000
        });
      }
    });

    this.before('READ', 'NavigatorSettings', async () => {
      const exists = await SELECT.one.from('com.sap.developers.ims.NavigatorSettings')
        .where({ ID: NAVIGATOR_SETTINGS_SINGLETON_ID });
      if (!exists) {
        await INSERT.into('com.sap.developers.ims.NavigatorSettings').entries({
          ID: NAVIGATOR_SETTINGS_SINGLETON_ID,
          // Mirrors srv/lib/runtime-config/navigator-settings.js DEFAULTS.
          includeNestedGroups: false
        });
      }
    });

    // #777 followup (2026-06-30) — belt-and-suspenders Admin guard for the
    // MyTutorials entity (Advocate Object Page ownedTutorials facet source).
    // AdminService is already @requires:'Admin' at service level so this is
    // redundant in practice, but makes the intent explicit and mirrors the
    // pattern used for other sensitive admin-only reads in this file.
    this.before('READ', 'MyTutorials', (req) => {
      if (!req.user.is('Admin')) return req.reject(403);
    });

    // #639: HomepageConfig is a singleton; auto-init a default row on first
    // READ so a fresh subaccount doesn't 404. Pattern matches ChatSettings.
    // UUID convention: one greater than NAVIGATOR_SETTINGS_SINGLETON_ID (c8ad).
    const HOMEPAGE_CONFIG_SINGLETON_ID = '00000000-0000-0000-0000-00000000c8ae';
    this.before('READ', 'HomepageConfig', async () => {
      const exists = await SELECT.one.from('com.sap.developers.ims.HomepageConfig')
        .where({ ID: HOMEPAGE_CONFIG_SINGLETON_ID });
      if (!exists) {
        await INSERT.into('com.sap.developers.ims.HomepageConfig').entries({
          ID: HOMEPAGE_CONFIG_SINGLETON_ID,
          developerNewsPlaylistId: null,
          videoBandEnabled: true,
          eventsBandEnabled: true,
          communityLaneEnabled: true,
          personalizationEnabled: false
        });
      }
    });

    // #759: VerbDefinitions auto-init. Cardinality is exactly 7 (#1029) —
    // one per HomepageVerb enum value. Seed CSV in
    // db/data/com.sap.developers.ims-VerbDefinitions.csv is canonical;
    // this handler is the defensive runtime fallback (matches
    // HomepageConfig pattern above). Defaults imported from
    // ./lib/homepage/verb-shelf-defaults.js — same module tests derive
    // expected row counts from (#1089).
    this.before('READ', 'VerbDefinitions', async () => {
      const existing = await SELECT.from('com.sap.developers.ims.VerbDefinitions').columns('verbKey');
      if (existing.length >= VERB_DEFAULTS.length) return;
      const have = new Set(existing.map(r => r.verbKey));
      const missing = VERB_DEFAULTS
        .filter(d => !have.has(d.verbKey))
        .map(d => ({ ...d, authoringStatus: 'BLANK' }));
      if (missing.length > 0) {
        await INSERT.into('com.sap.developers.ims.VerbDefinitions').entries(missing);
      }
    });

    // #759: ShelfDefinitions auto-init. Cardinality is exactly 4.
    // Same pattern as VerbDefinitions.
    this.before('READ', 'ShelfDefinitions', async () => {
      const existing = await SELECT.from('com.sap.developers.ims.ShelfDefinitions').columns('shelfKey');
      if (existing.length >= SHELF_DEFAULTS.length) return;
      const have = new Set(existing.map(r => r.shelfKey));
      const missing = SHELF_DEFAULTS
        .filter(d => !have.has(d.shelfKey))
        .map(d => ({ ...d, authoringStatus: 'BLANK' }));
      if (missing.length > 0) {
        await INSERT.into('com.sap.developers.ims.ShelfDefinitions').entries(missing);
      }
    });

    // (#1033) CommunityBlogSources auto-init. Defensive runtime fallback
    // mirroring the seed CSV in db/data — protects fresh subaccounts where
    // the CSV hasn't landed yet (or the auto-init fires before the DB
    // deployer). Only inserts if the table is empty; individual missing
    // rows are NOT re-inserted (that would fight admin deletes).
    // Defaults + apiQuery backfill live in ./lib/community-blog-source-defaults.js
    // so the cron path (fetchAllSources) shares the exact same source of
    // truth — the READ hook is no longer the only place the backfill runs.
    this.before('READ', 'CommunityBlogSources', async () => {
      const CBS = 'com.sap.developers.ims.CommunityBlogSources';
      const existing = await SELECT.from(CBS).columns('ID');
      if (existing.length === 0) {
        await INSERT.into(CBS).entries(COMMUNITY_BLOG_SOURCE_DEFAULTS);
        return;
      }
      // Backfill apiQuery on managed rows that predate the #1144 column.
      await backfillManagedApiQuery(cds.db);
    });

    this.before(['CREATE', 'UPDATE'], 'CommunityBlogSources', (req) => {
      const q = req.data?.apiQuery;
      // Null/absent is allowed (source falls back to curl); only validate when set.
      if (q != null && q !== '' && !validateApiQuery(q)) {
        return req.reject(400, `Invalid apiQuery — allowed: field comparisons joined by AND/OR only`);
      }
    });

    // (#644 Task 9) Validate layout/solution JSON on Puzzle writes.
    // Metadata-only patches (neither field present) are allowed through.
    // Also lowercases slug for canonical consistency.
    this.before(['CREATE', 'UPDATE'], 'Puzzles', (req) => {
      const { layout, solution } = req.data;
      if (layout == null && solution == null) return; // metadata-only patch
      const v = validatePuzzle({ layout: layout || '{}', solution: solution || '{}' });
      if (!v.ok) return req.reject(400, `Invalid puzzle: ${v.error}`);
      if (typeof req.data.slug === 'string') req.data.slug = req.data.slug.toLowerCase();
    });

    // (#1033) Reclassify — resets a CommunityBlogPosts row so the
    // classifier drain re-picks it on the next 15-min tick. SuperAdmin
    // gate via req.user.is('Admin') is enforced by the service's
    // @requires: 'Admin' — this handler runs only if authenticated.
    this.on('reclassifyCommunityBlogPost', async (req) => {
      const { ID } = req.data;
      if (!ID) return req.reject(400, 'ID is required');
      const updated = await UPDATE('com.sap.developers.ims.CommunityBlogPosts')
        .set({
          aiVerdict:      'PENDING',
          aiClassifiedAt: null,
          aiReason:       null,
          aiConfidence:   null,
          attemptCount:   0,
        })
        .where({ ID });
      resetCommunityBlogsCache();
      return updated > 0;
    });

    // (#1033) Invalidate the public /homepage/communityBlogs cache whenever
    // an admin toggles pinned / adminOverride, deletes a post, or CRUDs a
    // source. after-hooks fire on both direct writes and draft activation.
    for (const target of ['CommunityBlogPosts', 'CommunityBlogSources']) {
      this.after(['UPDATE', 'CREATE', 'DELETE'], target, () => {
        try { resetCommunityBlogsCache(); }
        catch (err) { /* best-effort */ }
      });
    }

    // Auto-assign legacyId on creation for entities that need it
    const legacyKeyedEntities = [
      'Users', 'Tutorials', 'Missions', 'Groups', 'Events', 'TaskRecords',
      'StepFailures', 'Tags', 'Accomplishments', 'AccomplishmentRecords',
      'PrizeRecords', 'TutorialMeta', 'TutorialContributors', 'TutorialRepositories',
      'FeaturedTasks', 'PrimaryAccounts', 'SecondaryAccounts', 'PrivacyProtectionActions',
      'CompletionPaths', 'CompletionPathItems',
      'GroupPathItems', 'EventRegistrations'
    ];
    for (const entity of legacyKeyedEntities) {
      this.before('CREATE', entity, async (req) => {
        if (!req.data.legacyId) {
          req.data.legacyId = await getNextLegacyId(entity, db);
        }
      });
    }

    // Gap-number itemOrder for new GroupPathItems rows so inline-created items
    // get a sensible order without the user typing one. NEW fires on draft
    // inline create (visible immediately); CREATE covers programmatic posts.
    const setGroupItemOrder = async (req) => {
      if (req.data.itemOrder != null) return;
      const groupId = req.data.group_ID
        || (Array.isArray(req.params) && req.params[0] && req.params[0].ID);
      if (!groupId) return;
      const row = await SELECT.one.from(req.target)
        .columns('max(itemOrder) as maxOrder')
        .where({ group_ID: groupId });
      req.data.itemOrder = ((row?.maxOrder ?? 0) + 10);
    };
    this.before('NEW', 'GroupPathItems.drafts', setGroupItemOrder);
    this.before('CREATE', 'GroupPathItems', setGroupItemOrder);

    // Issue #172 — refuse incoherent alt-group shapes.
    // Per PR 2 reviewer addendum item G: enforceMultiMember=false on CREATE
    // (authors create members one at a time in Fiori draft).
    this.before('CREATE', 'CompletionPathItems', makeAltGroupHandler('CompletionPathItems', 'path_ID', 'CREATE'));
    this.before('UPDATE', 'CompletionPathItems', makeAltGroupHandler('CompletionPathItems', 'path_ID', 'UPDATE'));
    this.before('CREATE', 'GroupPathItems',      makeAltGroupHandler('GroupPathItems',      'group_ID', 'CREATE'));
    this.before('UPDATE', 'GroupPathItems',      makeAltGroupHandler('GroupPathItems',      'group_ID', 'UPDATE'));

    // Advocates: auto-derive slug from firstName + lastName on CREATE.
    advocateHandlers.register(this);
    devtoberfestBannerHandlers.register(this);

    // Validate Start Date < End Date on Events
    this.before(['CREATE', 'PATCH'], 'Events', (req) => {
      const { startDate, endDate } = req.data;
      if (startDate && endDate && new Date(startDate) >= new Date(endDate)) {
        req.reject(400, 'Start Date must be earlier than End Date');
      }
    });

    // Require at least one tag on Missions and Groups
    this.before('SAVE', 'Missions', async (req) => {
      const tags = req.data.tags;
      if (!tags || tags.length === 0) {
        req.reject(400, 'At least one Tag is required');
      }
    });

    // [#436] Publish-time integrity guard: refuse a published=true transition
    // when any CompletionPathItems row is unresolvable. Drafts and unpublished
    // saves still allow partial state for incremental authoring; only the
    // false→true publish gate enforces correctness.
    this.before('SAVE', 'Missions', async (req) => {
      if (req.data.published !== true) return;
      const ID = req.data.ID;
      if (!ID) return;

      // Detect transition: only refuse on false→true, not when re-saving an
      // already-published mission whose payload echoes published=true.
      const [prior] = await SELECT.from(Missions).where({ ID }).columns('published');
      if (prior?.published === true) return;

      const paths = await SELECT.from(CompletionPaths)
        .where({ mission_ID: ID })
        .columns('ID', 'name');
      for (const path of paths) {
        const items = await SELECT.from(CompletionPathItems)
          .where({ path_ID: path.ID })
          .columns('ID', 'itemOrder', 'taskType', 'tutorial_ID', 'group_ID', 'checkpointTitle');
        for (const item of items) {
          const ord = item.itemOrder ?? '?';
          if (item.itemOrder == null) {
            return req.reject(400, `Cannot publish: path "${path.name}" has an item with no itemOrder`);
          }
          switch (item.taskType) {
            case 'TUTORIAL':
              if (!item.tutorial_ID) {
                return req.reject(400, `Cannot publish: path "${path.name}" item ${ord} has taskType=TUTORIAL but no tutorial linked`);
              }
              break;
            case 'GROUP':
              if (!item.group_ID) {
                return req.reject(400, `Cannot publish: path "${path.name}" item ${ord} has taskType=GROUP but no group linked`);
              }
              break;
            case 'CHECKPOINT':
              if (!item.checkpointTitle) {
                return req.reject(400, `Cannot publish: path "${path.name}" item ${ord} has taskType=CHECKPOINT but no checkpointTitle`);
              }
              break;
            default:
              return req.reject(400, `Cannot publish: path "${path.name}" item ${ord} has unknown taskType "${item.taskType}"`);
          }
        }
      }
    });

    this.before('SAVE', 'Groups', async (req) => {
      const tags = req.data.tags;
      if (!tags || tags.length === 0) {
        req.reject(400, 'At least one Tag is required');
      }
    });

    // Auto-derive slug from title for Missions and Groups so admin-created
    // records have stable URL fragments (/tutorials/group-<slug>,
    // /tutorials/mission-<slug>) without authors typing them.
    //
    // Fires on the full draft lifecycle:
    //   - NEW (draft create) and PATCH (draft autosave): keep slug visible
    //     and current as the title evolves in the draft.
    //   - SAVE (activation): final reconciliation against active table for
    //     uniqueness, since other drafts may have activated meanwhile. Also
    //     records the prior slug into the redirect history so old URLs
    //     302-survive renames (issue #91).
    //   - CREATE: programmatic non-draft POST (tests, scripts).
    //
    // Collisions resolved by appending -2, -3, ... within the entity's table.
    const deriveSlugForEntity = (entityName) => async (req) => {
      const isCreate = req.event === 'CREATE' || req.event === 'NEW';
      const ID = req.data.ID;
      const title = req.data.title;

      // Pull current persisted state so we can compare title→slug. For NEW the
      // row doesn't exist yet; for PATCH/SAVE it's the active or draft row.
      let prior = null;
      if (!isCreate && ID) {
        [prior] = await SELECT.from(req.target)
          .where({ ID })
          .columns('title', 'slug');
      }

      const effectiveTitle = title ?? prior?.title;
      if (!effectiveTitle) return; // tag/save validation handles missing title

      const base = slugify(effectiveTitle);

      // Skip when nothing relevant changed: title untouched and slug already set.
      if (!isCreate && prior?.slug && (title === undefined || title === prior.title)) {
        return;
      }

      const Entity = entityName === 'Missions' ? Missions : Groups;
      const rows = await SELECT.from(Entity)
        .columns('ID', 'slug')
        .where({ slug: { '!=': null } });
      const taken = new Set(
        rows.filter(r => r.ID !== ID).map(r => r.slug).filter(Boolean)
      );

      const newSlug = ensureUniqueSlug(base, taken, prior?.slug ?? null);
      req.data.slug = newSlug;

      // Record the prior slug into redirect history. Only on SAVE (active-row
      // activation) and CREATE (programmatic non-draft) — draft autosaves
      // (NEW / PATCH) shouldn't accumulate redirect rows for in-progress
      // titles the admin is still typing. See #91 follow-up.
      // Record the prior slug into redirect history. Only when the active
      // entity is being written (not drafts) — draft autosaves shouldn't
      // accumulate redirect rows for in-progress titles. Two paths reach the
      // active entity:
      //   - Initial draftActivate: req.event === 'CREATE' (no prior slug, so
      //     the prior?.slug guard below skips harmlessly).
      //   - Re-edit + draftActivate: req.event === 'UPDATE' on the active row,
      //     prior holds the active row's pre-update slug.
      // Programmatic non-draft writes also reach here as CREATE/UPDATE.
      // SAVE fires too on some handler chains, so accept it as well.
      // See #91 follow-up.
      const targetName = String(req.target?.name ?? '');
      const writingActive = !targetName.endsWith('.drafts')
        && (req.event === 'SAVE' || req.event === 'CREATE' || req.event === 'UPDATE');
      if (writingActive && prior?.slug && prior.slug !== newSlug) {
        const Redirect = entityName === 'Missions' ? MissionSlugRedirects : GroupSlugRedirects;
        const fk = entityName === 'Missions' ? 'mission_ID' : 'group_ID';

        // Slug-reuse: if newSlug was previously held by some other entity in
        // this table, drop that historic record so the redirect points at the
        // current owner (whoever owns the slug now wins). Also drop any prior
        // record for the just-vacated slug under THIS entity so we don't
        // accumulate dupes when a title bounces A → B → A.
        await DELETE.from(Redirect).where({ slug: { in: [newSlug, prior.slug] } });

        await INSERT.into(Redirect).entries({
          ID: randomUUID(),
          [fk]: ID,
          slug: prior.slug,
        });
      }
    };

    for (const entityName of ['Missions', 'Groups']) {
      const handler = deriveSlugForEntity(entityName);
      this.before('CREATE', entityName, handler);
      this.before('NEW',    `${entityName}.drafts`, handler);
      this.before('PATCH',  `${entityName}.drafts`, handler);
      this.before('SAVE',   entityName, handler);
    }

    // [#436] legacyId self-heal for entities authored via the admin UI's draft
    // lifecycle (NEW on .drafts → PATCH autosaves → SAVE on activation). The
    // existing legacyKeyedEntities loop at lines 71-85 covers `before('CREATE')`
    // for programmatic POSTs, but NEW/PATCH/SAVE on draft-edited entities never
    // hit CREATE — so missions/groups/paths created via Fiori (the #382 F1 path)
    // ended up with NULL legacyId.
    //
    // This handler:
    //   - Fires on NEW (draft create), PATCH (draft autosave), SAVE (activation)
    //   - Does NOT register for CREATE (already handled by the line 71 loop)
    //   - Self-heals UPDATE/PATCH/SAVE on existing rows whose legacyId is NULL
    //   - Skips when the row already has legacyId (idempotent across draft lifecycle)
    const initLegacyIdForEntity = (entityName) => async (req) => {
      if (req.data.legacyId != null) return;
      // Self-heal path: only do the prior-row lookup when the row exists. NEW
      // (draft create) carries a fresh UUID in req.data.ID but has no prior
      // row, so skip the SELECT to save a round-trip.
      if (req.data.ID && (req.event === 'PATCH' || req.event === 'SAVE' || req.event === 'UPDATE')) {
        const [prior] = await SELECT.from(req.target).where({ ID: req.data.ID }).columns('legacyId');
        if (prior?.legacyId != null) return;
      }
      req.data.legacyId = await getNextLegacyId(entityName, db);
    };

    for (const entityName of ['Missions', 'Groups', 'CompletionPaths']) {
      const handler = initLegacyIdForEntity(entityName);
      this.before('NEW',   `${entityName}.drafts`, handler);
      this.before('PATCH', `${entityName}.drafts`, handler);
      this.before('SAVE',  entityName,             handler);
      // CREATE is intentionally NOT registered here — the existing
      // legacyKeyedEntities loop at lines 71-85 already covers it.
    }

    // [#436] Auto-derive CompletionPaths.slug from name. Mirrors
    // deriveSlugForEntity but adapted for two CompletionPaths-specific facts:
    //   1. The source field is `name`, not `title`.
    //   2. Slug uniqueness is scoped to the parent mission, not the entity table —
    //      two missions can each legitimately have a "Path A".
    const deriveCompletionPathSlug = async (req) => {
      const isCreate = req.event === 'CREATE' || req.event === 'NEW';
      const ID = req.data.ID;
      const name = req.data.name;
      const missionId = req.data.mission_ID;

      let prior = null;
      if (!isCreate && ID) {
        [prior] = await SELECT.from(req.target).where({ ID }).columns('name', 'slug', 'mission_ID');
      }
      const effectiveName = name ?? prior?.name;
      const effectiveMission = missionId ?? prior?.mission_ID;
      if (!effectiveName || !effectiveMission) return;

      const base = slugify(effectiveName);
      if (!isCreate && prior?.slug && (name === undefined || name === prior.name)) return;

      // Scope-unique: only collide against siblings under the same mission.
      const siblings = await SELECT.from(CompletionPaths)
        .columns('ID', 'slug')
        .where({ mission_ID: effectiveMission, slug: { '!=': null } });
      const taken = new Set(
        siblings.filter(r => r.ID !== ID).map(r => r.slug).filter(Boolean)
      );

      req.data.slug = ensureUniqueSlug(base, taken, prior?.slug ?? null);
    };

    this.before('CREATE', 'CompletionPaths', deriveCompletionPathSlug);
    this.before('NEW',    'CompletionPaths.drafts', deriveCompletionPathSlug);
    this.before('PATCH',  'CompletionPaths.drafts', deriveCompletionPathSlug);
    this.before('SAVE',   'CompletionPaths', deriveCompletionPathSlug);

    // Reset notification escalation when reviewedDate is updated via Fiori UI
    this.before('UPDATE', 'TutorialMeta', (req) => {
      if (req.data.reviewedDate) {
        req.data.notificationNumber = 0;
        req.data.lastNotificationDate = null;
        req.data.firstNotificationDate = null;  // #450: clear all 3 fields atomically
      }
    });

    // --- Tutorials soft-delete + redirect validation ---
    // Delete on Tutorials must NOT remove the row — flip status to INACTIVE so the
    // public side returns 404 / redirects, while preserving history and the legacyId
    // so that bookmarked URLs stay redirectable.
    this.on('DELETE', 'Tutorials', async (req) => {
      const { ID } = req.data;
      if (!ID) return req.reject(400, 'Tutorial ID is required');
      const [existing] = await SELECT.from(Tutorials).where({ ID }).columns('ID', 'status');
      if (!existing) return req.reject(404, `Tutorial not found: ${ID}`);
      if (existing.status === 'INACTIVE') return; // already soft-deleted
      await UPDATE(Tutorials).set({ status: 'INACTIVE' }).where({ ID });
    });

    // Validate redirectTo on save:
    //   - only an INACTIVE tutorial may have a redirectTo target
    //   - cannot point to itself
    //   - target must exist and be ACTIVE
    this.before(['CREATE', 'UPDATE'], 'Tutorials', async (req) => {
      const { ID, status, redirectTo_ID } = req.data;
      const target = redirectTo_ID ?? req.data.redirectTo?.ID;
      if (target === undefined) return; // no change to redirectTo

      // Determine effective status (consider current DB value if not in payload)
      let effectiveStatus = status;
      if (effectiveStatus === undefined && ID) {
        const [row] = await SELECT.from(Tutorials).where({ ID }).columns('status');
        effectiveStatus = row?.status;
      }

      if (target === null) return; // clearing the redirect is always allowed

      if (effectiveStatus !== 'INACTIVE') {
        return req.reject(400, 'Redirect target can only be set on a deleted (INACTIVE) tutorial');
      }
      if (ID && target === ID) {
        return req.reject(400, 'Tutorial cannot redirect to itself');
      }
      const [tgt] = await SELECT.from(Tutorials).where({ ID: target }).columns('ID', 'status');
      if (!tgt) return req.reject(400, 'Redirect target tutorial not found');
      if (tgt.status === 'INACTIVE') {
        return req.reject(400, 'Redirect target must be an active tutorial');
      }
    });

    // --- Event Statistics ---

    this.on('getEventStatistics', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      const records = await SELECT.from(TaskRecords).where({ event_ID: event.ID });
      return computeEventStatistics(records);
    });

    this.on('getEventBurnup', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      // Issue #600 — has-ever-completed: include SUPERSEDED (historical truth
      // from a prior reset attempt). computeBurnup() dedupes by (user, task)
      // keeping the earliest completionDate so a re-completion doesn't emit a
      // new burnup point.
      const records = await SELECT.from(TaskRecords).where({
        event_ID: event.ID,
        taskType: 'TUTORIAL',
        status: { in: ['COMPLETED', 'SUPERSEDED'] }
      });
      return computeBurnup(records, event.timeZone || '+00:00');
    });

    this.on('getEventTrackStats', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      // Issue #600 — has-ever-completed: include SUPERSEDED. computeTrackStats
      // dedupes by (user, task) so a re-completion counts once.
      const records = await SELECT.from(TaskRecords).where({
        event_ID: event.ID,
        taskType: 'MISSION',
        status: { in: ['COMPLETED', 'SUPERSEDED'] }
      });
      const missions = await SELECT.from(Missions).columns('legacyId', 'title');
      return computeTrackStats(records, missions);
    });

    this.on('getCompletionSpeed', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      // Issue #600 — has-ever-completed: include SUPERSEDED. computeCompletionSpeed
      // dedupes by (user, task) keeping the earliest completionTime.
      const records = await SELECT.from(TaskRecords).where({
        event_ID: event.ID,
        taskType: 'TUTORIAL',
        status: { in: ['COMPLETED', 'SUPERSEDED'] }
      });
      const tutorials = await SELECT.from(Tutorials).columns('legacyId', 'title');
      return computeCompletionSpeed(records, tutorials);
    });

    // --- Export ---

    this.on('exportTaskRecords', async (req) => {
      const { eventLegacyId, format } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      // Issue #600 — has-ever-completed: include SUPERSEDED, then DISTINCT by
      // (user_ID, taskLegacyId) so the export shows one row per logical
      // completion (the latest attempt — see dedupeByUserTask logic below).
      const records = await SELECT.from(TaskRecords).where({
        event_ID: event.ID,
        status: { in: ['COMPLETED', 'SUPERSEDED'] }
      });
      const distinct = dedupeByUserTaskRecords(records);

      if (format === 'json') return JSON.stringify(distinct, null, 2);
      return formatTaskRecordsCSV(distinct);
    });

    this.on('exportAwardMissions', async (req) => {
      const { eventLegacyId } = req.data;
      const event = await SELECT.one.from(Events).where({ legacyId: eventLegacyId });
      if (!event) return req.reject(404, `Event not found: ${eventLegacyId}`);

      // Issue #600 — has-ever-completed: include SUPERSEDED, DISTINCT below.
      const missionRecords = await SELECT.from(TaskRecords).where({
        event_ID: event.ID,
        taskType: 'MISSION',
        status: { in: ['COMPLETED', 'SUPERSEDED'] }
      });
      const distinct = dedupeByUserTaskRecords(missionRecords);

      const userIds = [...new Set(distinct.map(r => r.user_ID))];
      const users = userIds.length > 0
        ? await SELECT.from(Users).where({ ID: { in: userIds } })
        : [];
      const userMap = new Map(users.map(u => [u.ID, u]));

      const missions = await SELECT.from(Missions).columns('legacyId', 'title');
      const missionMap = new Map(missions.map(m => [m.legacyId, m.title]));

      const awards = distinct.map(r => ({
        userDisplayName: userMap.get(r.user_ID)?.displayName || '',
        missionTitle: missionMap.get(r.taskLegacyId) || '',
        completionDate: r.completionDate
      }));

      return formatAwardMissionsCSV(awards);
    });

    this.on('exportMissionCompletions', async (req) => {
      const { startDate, endDate, missionLegacyId } = req.data;
      if (!startDate || !endDate) return req.reject(400, 'startDate and endDate are required');

      // Issue #600 — has-ever-completed: include SUPERSEDED, DISTINCT below.
      // Note: completionDate IS populated on SUPERSEDED rows (we preserve it
      // on reset to keep historical truth) so the date-window filter still
      // applies meaningfully.
      let query = SELECT.from(TaskRecords)
        .where({ taskType: 'MISSION', status: { in: ['COMPLETED', 'SUPERSEDED'] } })
        .and(`completionDate >=`, startDate)
        .and(`completionDate <=`, endDate);
      if (missionLegacyId) query = query.and({ taskLegacyId: missionLegacyId });

      const records = dedupeByUserTaskRecords(await query);

      const userIds = [...new Set(records.map(r => r.user_ID))];
      const users = userIds.length > 0
        ? await SELECT.from(Users).where({ ID: { in: userIds } })
        : [];
      const userMap = new Map(users.map(u => [u.ID, u]));

      const missions = await SELECT.from(Missions).columns('legacyId', 'title');
      const missionMap = new Map(missions.map(m => [m.legacyId, m.title]));

      const header = 'Mission Title,Mission ID,Login,Username,Email,Completion Date,SAP ID';
      const rows = records.map(r => {
        const user = userMap.get(r.user_ID);
        const completionDate = r.completionDate
          ? new Date(r.completionDate).toISOString().replace('T', ' ').slice(0, 19)
          : '';
        return [
          csvEscape(missionMap.get(r.taskLegacyId) || ''),
          r.taskLegacyId || '',
          csvEscape(user?.email || ''),
          csvEscape(user?.displayName || ''),
          csvEscape(user?.email || ''),
          completionDate,
          csvEscape(user?.sapId || '')
        ].join(',');
      });
      return [header, ...rows].join('\n');
    });

    // --- GDPR / Anonymization ---

    this.on('anonymizeUser', async (req) => {
      const { sapId } = req.data;
      const user = await SELECT.one.from(Users).where({ sapId });
      if (!user) return req.reject(404, `User not found with sapId: ${sapId}`);
      await this._executeAnonymization(user);
    });

    this.on('anonymizeByDsrRequest', async (req) => {
      const { sapId, dsrRequestNumber } = req.data;
      const user = await SELECT.one.from(Users).where({ sapId });
      if (!user) return req.reject(404, `User not found with sapId: ${sapId}`);
      await this._executeAnonymization(user, { dsrRequestNumber });
    });

    // --- Cleanup & Maintenance ---

    this.on('cleanupStepFailures', async (req) => {
      const days = req.data.olderThanDays || 90;
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const result = await DELETE.from(StepFailures).where({ failureDate: { '<': cutoff } });
      return result;
    });

    // clearChangeLog — bulk-purge sap.changelog.Changes rows. Designed for
    // admins to clear migration-trigger noise (74k+ rows on DEV today from
    // migrate-from-hana.js DB triggers) without waiting for the weekly cron.
    // Both params have safe defaults: olderThanDays=0 (purge everything that
    // matches), migrationOnly=true (only createdBy='migration' rows are
    // touched, real admin-edit audit history is preserved).
    this.on('clearChangeLog', async (req) => {
      const olderThanDays = Number.isInteger(req.data.olderThanDays) ? req.data.olderThanDays : 0;
      const migrationOnly = req.data.migrationOnly !== false; // default true
      const deleted = await cleanupChangeLog({ retentionDays: olderThanDays, migrationOnly });
      return { deleted };
    });

    // purgeNoiseChangeLog — sibling of clearChangeLog. Deletes
    // sap.changelog.Changes rows by `entity` allowlist. Empty / missing
    // list ⇒ use NOISE_ENTITIES default. See srv/lib/purge-stale-changelog.js.
    this.on('purgeNoiseChangeLog', async (req) => {
      const { purgeStaleChangelog } = await import(
        './lib/purge-stale-changelog.js'
      );
      const entities = Array.isArray(req.data.entities)
        ? req.data.entities
        : [];
      return await purgeStaleChangelog({ entities });
    });

    this.on('cleanupUnusedTags', async () => {
      // Delegate to the canonical implementation in srv/jobs/cleanup.js.
      // Prior inline copy issued an unchunked `DELETE FROM Tags WHERE ID IN
      // (?, ?, …)` over every unused Tag ID; on production Tag counts (into
      // the thousands after seeded taxonomies) that blew HANA's packet cap
      // (memory: cqn-where-in-hana-packet-cap.md). The exported helper uses
      // `deleteInChunks` — single source of truth, matches the nightly cron.
      return await cleanupUnusedTags();
    });

    this.on('previewTagImport', async (req) => {
      const log = cds.log('tag-import');
      const started = Date.now();
      const { payload, format } = req.data;

      if (!payload) return req.error(400, 'payload is required');
      if (typeof payload !== 'string') return req.error(400, 'payload must be a string');
      if (Buffer.byteLength(payload, 'utf8') > MAX_BYTES) {
        return req.error(413, `Payload exceeds ${MAX_BYTES} bytes`);
      }
      if (!['csv', 'json'].includes(format)) {
        return req.error(400, `format must be 'csv' or 'json'`);
      }

      let parsed;
      try {
        parsed = parsePayload(payload, format);
      } catch (e) {
        return req.error(400, e.message);
      }

      const existingTags = await SELECT.from(Tags).columns('ID', 'name', 'titlePath');
      const { summary, rows } = classify(parsed.rows, existingTags);

      const token = randomUUID();
      sharedCache.set(token, { rows, classifiedAt: Date.now() });

      log.info({
        event: 'tag-import.preview',
        user: req.user?.id,
        total: summary.total,
        summary,
        durationMs: Date.now() - started
      });

      return {
        token,
        summary,
        rows,
        parseWarnings: parsed.parseErrors
      };
    });

    this.on('commitTagImport', async (req) => {
      const log = cds.log('tag-import');
      const started = Date.now();
      const { token, strategy } = req.data;

      if (!token) return req.error(400, 'token is required');
      if (!['upsert', 'skip-duplicates', 'abort-on-duplicate'].includes(strategy)) {
        return req.error(400, `strategy must be one of upsert, skip-duplicates, abort-on-duplicate`);
      }

      const cached = sharedCache.get(token);
      if (!cached) return req.error(410, 'Preview expired or unknown token; please re-upload');

      // Re-classify inside the request to catch races (another admin inserting
      // between preview and commit). The cached parsed rows stay as-is; only the
      // classification against existing tags is refreshed.
      const existingTags = await SELECT.from(Tags).columns('ID', 'name', 'titlePath');
      const inputRows = cached.rows.map(r => r.status === 'invalid'
        ? { invalid: true, name: r.name, titlePath: r.titlePath, reason: r.reason }
        : { name: r.name, titlePath: r.titlePath });
      const { rows: freshRows } = classify(inputRows, existingTags);

      let result;
      try {
        result = await apply(freshRows, strategy, db);
      } catch (e) {
        if (/conflict/i.test(e.message) && strategy === 'abort-on-duplicate') {
          return req.error(409, e.message);
        }
        throw e;
      }

      log.info({
        event: 'tag-import.commit',
        user: req.user?.id,
        strategy,
        ...result,
        durationMs: Date.now() - started
      });

      return result;
    });

    // Tags.mdFormat is a virtual field (populated on read) + $filter over
    // it must not blow up. See srv/lib/tag-md-format-handlers.js — #837.
    attachTagsMdFormatHandlers(this, 'Tags');

    this.on('setFeaturedOrder', async (req) => {
      const { taskLegacyId, taskType, featuredOrder } = req.data;
      const existing = await SELECT.one.from(FeaturedTasks).where({ taskLegacyId, taskType });
      if (existing) {
        await UPDATE(FeaturedTasks, existing.ID).set({ featuredOrder });
      } else {
        await INSERT.into(FeaturedTasks).entries({
          taskLegacyId, taskType, featuredOrder,
          legacyId: await getNextLegacyId('FeaturedTasks', db)
        });
      }
    });

    // --- RAG / Embeddings ---

    this.on('seedEmbeddings', async (req) => {
      const settings = await SELECT.one.from(ChatSettings);
      if (!settings?.ragEnabled) return req.error(400, 'ragEnabled must be true');

      const manifest = await SELECT.one.from(ContentManifest)
        .where({ status: 'ACTIVE' })
        .orderBy({ version: 'desc' });
      if (!manifest) return req.error(409, 'no active content manifest');

      // Option B: active slug set from ContentCurrent when the read flag is on.
      const ContentCurrent = cds.entities('com.sap.developers.ims').ContentCurrent;
      const files = (isDeltaRead() && ContentCurrent)
        ? await SELECT.from(ContentCurrent).columns('slug')
        : await SELECT.from(ContentFiles).columns('slug').where({ version: manifest.version });
      const slugs = files.map(f => f.slug);

      setImmediate(() => embedSlugs(slugs, settings).catch(err => {
        cds.log('rag-seed').warn('seed failed', err.message);
      }));

      return { queued: true, activeSlugs: slugs.length };
    });

    // Issue #943: one-shot backfill for Concepts.embedding. Distinct code path
    // from seedEmbeddings (which handles TutorialEmbedding via embedSlugs).
    // Invokes the same runConceptEmbeddingBackfill() the scheduled cron uses
    // (single source of truth). Synchronous — returns { processed, failed,
    // latencyMs } for the admin toast. Auth enforced by the entity-level
    // @requires: 'Admin' on ChatSettings.
    this.on('seedConceptEmbeddings', async () => {
      const { runConceptEmbeddingBackfill } = await import('./jobs/concept-embedding-backfill.js');
      return await runConceptEmbeddingBackfill({ db });
    });

    // --- Account Merge Status ---

    this.on('getAccountMergeStatus', async (req) => {
      const { uuid } = req.data;
      const primary = await SELECT.one.from(PrimaryAccounts).where({ uuid });
      if (!primary) return { primaryUuid: null, status: null, mergedAt: null, secondaryCount: 0 };

      const secondaries = await SELECT.from(SecondaryAccounts).where({ primaryAccount_ID: primary.ID });
      const latestMerge = secondaries.reduce((latest, s) =>
        s.mergedAt && (!latest || s.mergedAt > latest) ? s.mergedAt : latest, null);

      return {
        primaryUuid: primary.uuid,
        status: primary.status,
        mergedAt: latestMerge,
        secondaryCount: secondaries.length
      };
    });

    this.on('findByAccountNumber', async (req) => {
      const { sapId } = req.data;
      const user = await SELECT.one.from(Users).where({ sapId });
      if (!user) return [];

      await INSERT.into(PrivacyProtectionActions).entries({
        userUuid: user.uuid,
        actionType: 'SEARCH',
        requestedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: 'COMPLETED',
        legacyId: await getNextLegacyId('PrivacyProtectionActions', db)
      });

      return SELECT.from(TaskRecords).where({ user_ID: user.ID });
    });

    // --- Integrations (wired) ---

    this.on('sendToNgds', async (req) => {
      const { taskRecordLegacyId } = req.data;
      const record = await SELECT.one.from(TaskRecords).where({ legacyId: taskRecordLegacyId });
      if (!record) return req.reject(404, `TaskRecord not found: ${taskRecordLegacyId}`);

      // Payload is now assembled inside the client from the persisted record
      // (resolves parent task title, mission CommunityID, interest-item tags,
      // and visitor id) so the wire shape matches the legacy Java contract.
      const { sendTaskRecordToNgds } = await import('./lib/ngds-client.js');
      return sendTaskRecordToNgds(record, db);
    });

    this.on('syncTutorialMetadata', async (req) => {
      const { backfillMissingTutorialMeta } = await import('./lib/tutorial-meta-init.js');
      const { created } = await backfillMissingTutorialMeta();
      return { synced: created, message: `Backfilled ${created} TutorialMeta rows. Use rebuild-content.yml to refresh review dates.` };
    });

    // --- Tutorial Review & Notification Reset ---

    this.on('reviewTutorial', async (req) => {
      try {
        return await reviewTutorial(req.data.tutorialId);
      } catch (err) {
        if (err.code === 404) return req.reject(404, err.message);
        throw err;
      }
    });

    this.on('snoozeTutorial', async (req) => {
      try {
        return await snoozeTutorial(req.data.tutorialId, req.data.days);
      } catch (err) {
        if (err.code === 404) return req.reject(404, err.message);
        throw err;
      }
    });

    this.on('sendContributorNotifications', async (req) => {
      const { computeStaleNotifications, determineRecipients, markNotificationSent, getAdminEmailList, resolveTimingKnobs } = await import('./lib/contributor-notifications.js');
      const { sendNotificationEmail } = await import('./lib/mail-client.js');

      const knobs = await resolveTimingKnobs();
      const adminEmails = await getAdminEmailList();
      const notifications = await computeStaleNotifications(knobs);
      const dashboardUrl = (await resolveDisplaySettings()).dashboardUrl;

      let sent = 0;
      for (const n of notifications) {
        const { to, cc } = determineRecipients(n, adminEmails);
        if (to.length === 0) continue;
        await sendNotificationEmail({
          to, cc, subject: n.title,
          level: n.notificationLevel,
          variables: {
            dashboardUrl,
            tutorialTitle: n.title,
            staleDaysThreshold: knobs.staleDays,
            lastReviewedDate: n.reviewedDate,
          }
        });
        await markNotificationSent(n.tutorialId);
        sent++;
      }
      return { notified: sent };
    });

    this.on('testNotificationEmail', async (req) => {
      const { sendNotificationEmail } = await import('./lib/mail-client.js');
      const { to, level } = req.data;
      if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return { success: false, error: 'Invalid "to" address' };
      }
      const lvl = Number.isInteger(level) && level >= 0 && level <= 3 ? level : 0;
      const dashboardUrl = (await resolveDisplaySettings()).dashboardUrl;
      const today = new Date().toISOString().slice(0, 10);
      const result = await sendNotificationEmail({
        to,
        cc: [],
        subject: '[TEST] CAP tutorials-srv SMTP transport check',
        level: lvl,
        variables: {
          dashboardUrl,
          tutorialTitle: 'Test Tutorial — please ignore',
          staleDaysThreshold: 90,
          lastReviewedDate: today,
        },
      });
      return { success: result.success, error: result.error ?? '' };
    });

    this.on('sendLastChanceEmail', async (req) => {
      const cn = await import('./lib/contributor-notifications.js');
      const mc = await import('./lib/mail-client.js');
      return sendLastChanceForAuthor(
        req.data.authorEmail,
        req.data.dryRun ?? false,
        { ...cn, ...mc },
      );
    });

    this.on('sendLastChanceEmailsAllDormant', async (req) => {
      const { dryRun = false } = req.data;
      const cn = await import('./lib/contributor-notifications.js');
      const mc = await import('./lib/mail-client.js');
      const ctx = { ...cn, ...mc };

      const knobs = await cn.resolveTimingKnobs();
      const notifications = await cn.computeStaleNotifications(knobs);
      const digests = cn.groupNotificationsByAuthor(notifications);
      const dormancyCutoff = new Date(Date.now() - knobs.lastChanceDormancyDays * 86400000).toISOString();

      const qualifying = digests.filter(d =>
        d.authorEmail != null
        && d.tutorials.some(t =>
          t.notificationLevel >= knobs.lastChanceMinLevel
          && t.lastNotificationDate
          && t.lastNotificationDate < dormancyCutoff
        )
      );

      if (dryRun) {
        return {
          authorsProcessed: qualifying.length,
          emailsSent: 0, emailsFailed: 0, authorsSkipped: 0, errors: [],
          preview: qualifying.map(d => ({
            authorEmail: d.authorEmail,
            tutorialCount: d.tutorials.length,
            worstLevel: d.worstLevel,
          })),
        };
      }

      let sent = 0, failed = 0;
      const errors = [];
      for (const d of qualifying) {
        try {
          const result = await sendLastChanceForAuthor(d.authorEmail, false, ctx);
          if (result.success) sent++;
          else { failed++; errors.push(`${d.authorEmail}: ${result.error}`); }
        } catch (err) {
          failed++;
          errors.push(`${d.authorEmail}: ${err.message}`);
        }
      }
      return {
        authorsProcessed: qualifying.length,
        emailsSent: sent, emailsFailed: failed, authorsSkipped: 0, errors,
        preview: [],
      };
    });

    this.on('updateNotificationRecipients', async (req) => {
      const { ImsConfig } = cds.entities('com.sap.developers.ims');
      const { emails } = req.data;
      const existing = await SELECT.one.from(ImsConfig).where({ key: 'emailListForOutdated' });
      if (existing) {
        await UPDATE(ImsConfig, existing.ID).set({ value: emails });
      } else {
        await INSERT.into(ImsConfig).entries({ key: 'emailListForOutdated', value: emails });
      }
      return { updated: true };
    });

    this.on('toggleNotifications', async (req) => {
      const { ImsConfig } = cds.entities('com.sap.developers.ims');
      const { enabled } = req.data;
      const value = String(enabled);
      const existing = await SELECT.one.from(ImsConfig).where({ key: 'isNotificationSendingAllowed' });
      if (existing) {
        await UPDATE(ImsConfig, existing.ID).set({ value });
      } else {
        await INSERT.into(ImsConfig).entries({ key: 'isNotificationSendingAllowed', value });
      }
      return { enabled };
    });

    this.on('getNotificationConfig', async () => {
      const { ImsConfig } = cds.entities('com.sap.developers.ims');
      const enabledConfig = await SELECT.one.from(ImsConfig).where({ key: 'isNotificationSendingAllowed' });
      const recipientsConfig = await SELECT.one.from(ImsConfig).where({ key: 'emailListForOutdated' });
      return {
        enabled: enabledConfig?.value === 'true',
        recipients: recipientsConfig?.value || ''
      };
    });

    this.on('toggleNgdsAutoSend', async (req) => {
      const { ImsConfig } = cds.entities('com.sap.developers.ims');
      const { enabled } = req.data;
      const value = String(enabled);
      const existing = await SELECT.one.from(ImsConfig).where({ key: 'ngds.autosend.enabled' });
      if (existing) {
        await UPDATE(ImsConfig, existing.ID).set({ value });
      } else {
        await INSERT.into(ImsConfig).entries({ key: 'ngds.autosend.enabled', value });
      }
      // Flush the 60s flag cache so the toggle takes effect immediately rather
      // than after the TTL window.
      const { resetAutoSendFlagCache } = await import('./lib/ngds-autosend.js');
      resetAutoSendFlagCache();
      return { enabled };
    });

    this.on('setNgdsAutoSendEpoch', async (req) => {
      const { ImsConfig } = cds.entities('com.sap.developers.ims');
      const { epoch } = req.data;
      // Empty/null clears the watermark (no date suppression). A non-empty value
      // must parse as a date; reject otherwise so we never store garbage that
      // silently disables suppression.
      let value = '';
      if (epoch != null && String(epoch).trim() !== '') {
        const t = new Date(epoch).getTime();
        if (!Number.isFinite(t)) return req.reject(400, `Invalid epoch date: ${epoch}`);
        value = new Date(t).toISOString();
      }
      const existing = await SELECT.one.from(ImsConfig).where({ key: 'ngds.autosend.epoch' });
      if (existing) {
        await UPDATE(ImsConfig, existing.ID).set({ value });
      } else {
        await INSERT.into(ImsConfig).entries({ key: 'ngds.autosend.epoch', value });
      }
      const { resetAutoSendFlagCache } = await import('./lib/ngds-autosend.js');
      resetAutoSendFlagCache();
      return { epoch: value || null };
    });

    this.on('getNgdsAutoSendConfig', async () => {
      const { ImsConfig } = cds.entities('com.sap.developers.ims');
      const { resolveDeployEnvironment } = await import('./lib/deploy-environment.js');
      const cfg = await SELECT.one.from(ImsConfig).where({ key: 'ngds.autosend.enabled' });
      const epochCfg = await SELECT.one.from(ImsConfig).where({ key: 'ngds.autosend.epoch' });
      const enabled = cfg?.value === 'true';
      const env = resolveDeployEnvironment();
      return {
        enabled,
        environment: env.label,
        // Cutover watermark (ISO date) below which completions are suppressed;
        // null when unset.
        epoch: epochCfg?.value || null,
        // effective = will actually send: the flag is on AND we're in PROD.
        effective: enabled && env.id === 'prod'
      };
    });

    // ---- Content Option-B delta flags (ImsConfig-backed, DB-driven config) ----
    // Three flags gate the migration off the legacy ContentFiles snapshot model
    // onto the mutable ContentCurrent model. Moved from env vars to ImsConfig so
    // an admin can flip them without a redeploy. Cache lives in
    // srv/lib/content-delta-flags.js (60s TTL); we bust it on write so a toggle
    // takes effect immediately. Values stored as 'true'/'false' strings.
    this.on('setContentDeltaFlags', async (req) => {
      const { ImsConfig } = cds.entities('com.sap.developers.ims');
      const { DELTA_WRITE_KEY, DELTA_READ_KEY, DELTA_SKIP_CARRYFORWARD_KEY } =
        await import('./lib/content-delta-flags.js');
      const { write, read, skipCarryForward } = req.data;
      // Only upsert the flags actually supplied (undefined → leave unchanged),
      // so a caller can flip one flag without clobbering the other two.
      const upserts = [
        [DELTA_WRITE_KEY, write],
        [DELTA_READ_KEY, read],
        [DELTA_SKIP_CARRYFORWARD_KEY, skipCarryForward],
      ];
      for (const [key, val] of upserts) {
        if (val === undefined || val === null) continue;
        const value = String(Boolean(val));
        const existing = await SELECT.one.from(ImsConfig).where({ key });
        if (existing) {
          await UPDATE(ImsConfig, existing.ID).set({ value });
        } else {
          await INSERT.into(ImsConfig).entries({ key, value });
        }
      }
      // Flush the 60s cache so the flip is effective at once.
      bustContentDeltaFlagsCache();
      return getContentDeltaFlags();
    });

    this.on('getContentDeltaFlags', async () => getContentDeltaFlags());

    async function getContentDeltaFlags() {
      const { ImsConfig } = cds.entities('com.sap.developers.ims');
      const { DELTA_WRITE_KEY, DELTA_READ_KEY, DELTA_SKIP_CARRYFORWARD_KEY } =
        await import('./lib/content-delta-flags.js');
      const readKey = async (key) => {
        const row = await SELECT.one.from(ImsConfig).where({ key });
        return String(row?.value).toLowerCase() === 'true';
      };
      return {
        write: await readKey(DELTA_WRITE_KEY),
        read: await readKey(DELTA_READ_KEY),
        skipCarryForward: await readKey(DELTA_SKIP_CARRYFORWARD_KEY),
      };
    }

    this.on('findMissingSlugs', async () => {
      const { findMissingSlugs } = await import('./lib/slug-mapping.js');
      return findMissingSlugs();
    });

    // #805 — Live in-memory metrics snapshot for the admin-shell Metrics view.
    // Returns JSON-encoded string; the tile JSON.parses it. Matches the shape
    // served by /admin/metrics/live (Express route) for on-call curl.
    this.on('getMetricsSnapshot', async () => {
      return JSON.stringify({
        snapshot: metrics.snapshot(),
        instanceId: process.env.CF_INSTANCE_GUID || `local-${process.pid}`,
        uptimeSec: Math.round(process.uptime()),
        dbWrapEnabled: process.env.METRICS_DB_WRAP === 'true',
        generatedAt: new Date().toISOString(),
      });
    });

    this.on('getBoardStatistics', async () => {
      const { TutorialMeta } = cds.entities('com.sap.developers.ims');

      const [userCount] = await SELECT.from(Users).columns('count(*) as cnt');
      const [tutorialCount] = await SELECT.from(Tutorials).columns('count(*) as cnt');
      const [groupCount] = await SELECT.from(Groups).columns('count(*) as cnt');
      const [missionCount] = await SELECT.from(Missions).columns('count(*) as cnt');

      const avgByType = await SELECT.from(TaskRecords)
        .columns('taskType', 'avg(progress) as avgProgress')
        .where({ status: { '!=': 'SUPERSEDED' } })
        .groupBy('taskType');
      const avgMap = new Map(avgByType.map(r => [r.taskType, Math.round(r.avgProgress || 0)]));

      const now = new Date();
      const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()).toISOString();
      const [upToDateCount] = await SELECT.from(TutorialMeta)
        .columns('count(*) as cnt')
        .where('reviewedDate >=', sixMonthsAgo);
      const totalMeta = tutorialCount.cnt;
      const upToDate = upToDateCount.cnt;

      return {
        totalUsers: userCount.cnt,
        totalTutorials: tutorialCount.cnt,
        totalGroups: groupCount.cnt,
        totalMissions: missionCount.cnt,
        avgTutorialCompletion: avgMap.get('TUTORIAL') || 0,
        avgGroupCompletion: avgMap.get('GROUP') || 0,
        avgMissionCompletion: avgMap.get('MISSION') || 0,
        tutorialsUpToDate: upToDate,
        tutorialsNeedReview: totalMeta - upToDate
      };
    });

    this.after('READ', 'PipelineLog', rows => {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        if (row.status === 'SUCCESS') row.statusCriticality = 3;
        else if (row.status === 'FAILED') row.statusCriticality = 1;
        else if (row.status === 'RUNNING') row.statusCriticality = 2;
        row.cfLogsUrl = buildCfLogsUrl(row);
      }
    });

    this.after('READ', 'JobExecutionLog', rows => {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        if (row.status === 'SUCCESS') row.statusCriticality = 3;
        else if (row.status === 'FAILED') row.statusCriticality = 1;
        else if (row.status === 'RUNNING') row.statusCriticality = 2;
        row.cfLogsUrl = buildCfLogsUrl(row);
      }
    });

    this.after('READ', 'PipelineLogItems', rows => {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        if (row.severity === 'ERROR') row.severityCriticality = 1;
        else if (row.severity === 'WARN') row.severityCriticality = 2;
        else row.severityCriticality = 0;
      }
    });

    this.after('READ', 'JobLogItems', rows => {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        if (row.status === 'ERROR') row.statusCriticality = 1;
        else if (row.status === 'WARN') row.statusCriticality = 2;
        else if (row.status === 'SUCCESS') row.statusCriticality = 3;
        else row.statusCriticality = 0;
      }
    });

    // Task 8: freshness worklist virtuals — openHighCount, freshnessStatus, freshnessCriticality.
    // Batch-look up the latest FreshnessReport per tutorial and stamp the virtual columns.
    // Fail-quiet (try/catch + warn-log) so a lookup error never 500s the read.
    // Criticality: 1=Negative(red), 2=Critical(yellow), 3=Positive(green), 0=Neutral.
    this.after('READ', 'Tutorials', async (rows) => {
      const list = Array.isArray(rows) ? rows : [rows];
      const ids = list.map(r => r?.ID).filter(Boolean);
      if (!ids.length) return;
      try {
        const { FreshnessReport } = cds.entities('com.sap.developers.ims');
        const reports = await SELECT.from(FreshnessReport).columns('tutorial_ID', 'status', 'openHighCount').where({ tutorial_ID: { in: ids } });
        const byT = new Map(reports.map(r => [r.tutorial_ID, r]));
        for (const row of list) {
          const rep = byT.get(row.ID);
          row.openHighCount = rep?.openHighCount ?? 0;
          row.freshnessStatus = rep?.status ?? null;
          row.freshnessCriticality = (rep?.openHighCount > 0) ? 1 : (rep?.status === 'DONE' ? 3 : 0);
        }
      } catch (err) { cds.log('freshness').warn('Tutorials freshness decorate failed', err); }
    });

    // Task 8: confidence → criticality badge for the FreshnessFinding worklist.
    // High-confidence findings are red (1=Negative) — highest visual weight.
    this.after('READ', 'FreshnessFinding', (rows) => {
      const list = Array.isArray(rows) ? rows : [rows];
      const map = { High: 1, Medium: 2, Low: 0 };
      for (const row of list) if (row) row.confidenceCriticality = map[row.confidence] ?? 0;
    });

    // Guard: only SuperAdmin can change the published flag in either direction
    // (publish OR unpublish). The CREATE exemption permits the runtime's
    // draft-activation flow, where the activation payload echoes published=false
    // (the column default per #348) — this is a pass-through, not a change,
    // so we let regular Admins activate new drafts without elevating.
    // Any explicit published=true on CREATE is still a change (against the
    // false default) and requires SuperAdmin. Any PATCH that touches published
    // is a change against an existing row's value and always requires SuperAdmin.
    const _guardPublished = (req) => {
      if (!('published' in req.data)) return;
      if (req.event === 'CREATE' && req.data.published === false) return;
      if (!req.user.is('SuperAdmin')) {
        req.reject(403, 'Only SuperAdmin can change the published state');
      }
    };
    this.before(['CREATE', 'PATCH'], ['Missions', 'Groups'], _guardPublished);
    this.before('PATCH', ['Missions.drafts', 'Groups.drafts'], _guardPublished);

    // Compute dynamic field control for published field
    this.after('READ', ['Missions', 'Groups'], (data, req) => {
      const isSuperAdmin = req.user.is('SuperAdmin');
      const controlValue = isSuperAdmin ? 7 : 1;
      for (const row of Array.isArray(data) ? data : [data]) {
        if (row) row.publishedFieldControl = controlValue;
      }
    });

    // --- getTutorialSource(slug): admin-only source markdown read ---
    // Custom UI5 section on the Tutorials Object Page calls this to display
    // the upstream `.md` content + drift status. Implementation lives in
    // srv/lib/content-store.js (uses raw HANA SQL to dodge LOB locator
    // expiry on BLOB reads alongside metadata). Spec: PR-2 of
    // docs/superpowers/specs/2026-06-24-tutorials-admin-tile-expansion-design.md
    this.on('getTutorialSource', async (req) => {
      const slug = req.data?.slug;
      if (!slug) return req.error(400, 'slug parameter is required');
      try {
        return await getTutorialSource(slug);
      } catch (err) {
        cds.log('admin').error('getTutorialSource failed for slug=' + slug, err.message);
        return req.error(500, 'failed to load tutorial source');
      }
    });

    // --- classifyCategories: bulk AI category assignment with job-lock ---
    this.on('classifyCategories', async (req) => {
      const { kind, ids, force } = req.data;
      const { acquireLock, releaseLock } = await import('./jobs/job-lock.js');
      const LOCK_NAME = 'categories-classify';
      const INSTANCE_ID = process.env.CF_INSTANCE_INDEX || 'local';
      const LOCK_DURATION_MS = 30 * 60 * 1000;
      const acquired = await acquireLock(LOCK_NAME, INSTANCE_ID, LOCK_DURATION_MS);
      if (!acquired) {
        return { processed: 0, succeeded: 0, failed: 0, skipped: 1 };
      }
      try {
        const targets = await this._collectClassifyTargets(kind, ids);
        let succeeded = 0, failed = 0, skipped = 0;
        const CONCURRENCY = 4;
        for (let i = 0; i < targets.length; i += CONCURRENCY) {
          const batch = targets.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map(t => classifyAndPersist(t.kind, t.id, { force }))
          );
          for (const r of results) {
            if (r.status === 'rejected') failed++;
            else if (r.value.kept === 1) succeeded++;
            else skipped++;
          }
        }
        return { processed: targets.length, succeeded, failed, skipped };
      } finally {
        await releaseLock(LOCK_NAME, INSTANCE_ID);
      }
    });

    this.on('embedAllSeeds', async () => {
      const { _resetCache, getSeedEmbeddings } = await import('./lib/category-seed-embeddings.js');
      _resetCache(); // force re-embed of all seeds on next call
      const map = await getSeedEmbeddings();
      return { processed: map.size };
    });

    // --- (#759 PR 3a) Homepage explainer AI generation actions ---
    //
    // Three near-identical action handlers; the only differences are:
    //   - which entity table (VerbDefinitions / ShelfDefinitions / HomepageShelves)
    //   - which kind passed to generateExplainer ('verb' / 'shelf' / 'shelf-entry')
    //   - whether contextLookup is needed (shelf-entry needs verb context)
    //
    // Shared concerns: cap-check, kill-switch, mode dispatch, batch with
    // Promise.allSettled at CONCURRENCY=4, status-transition rules per
    // spec §3.3, structured return shape with USD-cent cost.
    const EXPLAINER_GENERATOR_CONCURRENCY = 4;
    const EXPLAINER_HARD_CAP = 100;

    // (#1552) `writeEntity` defaults to `entityName` (the active table). For
    // the OP-header BOUND actions invoked while the Object Page is in EDIT
    // mode, Fiori Elements POSTs to the `.drafts` shadow — the caller passes
    // the draft-shadow entity ref here so the generated content lands on the
    // row the admin is currently editing (visible mid-edit, persisted on Save)
    // instead of the active row (invisible until reload, lost on Discard).
    async function runExplainerAction({ kind, entityName, writeEntity, ids, mode, contextLookup, req }) {
      if (process.env.AICORE_EXPLAINER_GENERATOR_DISABLED === 'true') {
        req.reject(503, 'AI_GENERATION_DISABLED');
        return;
      }
      const idsArr = Array.isArray(ids) ? ids : [];
      if (idsArr.length > EXPLAINER_HARD_CAP) {
        req.reject(400, `CAP_EXCEEDED: limit ${EXPLAINER_HARD_CAP}`);
        return;
      }
      const readEntity = writeEntity || entityName;

      const { generateExplainer } = await import('./lib/explainer-generator.js');
      const { centsToUsdString } = await import('./lib/_token-cost.js');
      const db = await cds.connect.to('db');

      // Select target rows by mode. Read + write hit the SAME table so a draft
      // regeneration reads the (possibly edited) draft row and writes it back.
      let rows;
      if (mode === 'fill-blanks') {
        rows = await db.run(
          SELECT.from(readEntity).where({ authoringStatus: 'BLANK' })
        );
      } else if (mode === 'regenerate-selected') {
        if (idsArr.length === 0) return { processed: 0, skipped: 0, cost: '$0.00' };
        rows = await db.run(
          SELECT.from(readEntity).where({ ID: { in: idsArr } })
        );
      } else {
        req.reject(400, `unknown mode: ${mode}`);
        return;
      }

      // Process in batches of CONCURRENCY=4, accumulate.
      let totalCents = 0;
      let processed = 0;
      let skipped = 0;
      for (let i = 0; i < rows.length; i += EXPLAINER_GENERATOR_CONCURRENCY) {
        const batch = rows.slice(i, i + EXPLAINER_GENERATOR_CONCURRENCY);
        const results = await Promise.allSettled(batch.map(async (row) => {
          const context = contextLookup ? await contextLookup(row) : undefined;
          const result = await generateExplainer({ kind, row, context });
          if (!result) return null;
          await db.run(
            UPDATE(readEntity)
              .set({
                tagline:         result.tagline,
                whyItMatters:    result.whyItMatters,
                authoringStatus: 'AI_SEEDED',
              })
              .where({ ID: row.ID })
          );
          return result.costCents;
        }));
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value !== null) {
            processed++;
            totalCents += r.value;
          } else {
            skipped++;
          }
        }
      }
      return {
        processed,
        skipped,
        cost: centsToUsdString(totalCents),
      };
    }

    this.on('generateVerbExplainers', async (req) => {
      const { ids, mode } = req.data;
      return runExplainerAction({
        kind: 'verb',
        entityName: 'com.sap.developers.ims.VerbDefinitions',
        ids, mode, req,
      });
    });

    this.on('generateShelfExplainers', async (req) => {
      const { ids, mode } = req.data;
      return runExplainerAction({
        kind: 'shelf',
        entityName: 'com.sap.developers.ims.ShelfDefinitions',
        ids, mode, req,
      });
    });

    this.on('generateShelfEntryExplainers', async (req) => {
      const { ids, mode } = req.data;
      // shelf-entry needs verb context: look up VerbDefinitions[verbKey == row.verb] per row.
      return runExplainerAction({
        kind: 'shelf-entry',
        entityName: 'com.sap.developers.ims.HomepageShelves',
        ids, mode, req,
        contextLookup: async (row) => {
          const db = await cds.connect.to('db');
          const verbDef = await db.run(
            SELECT.one.from('com.sap.developers.ims.VerbDefinitions')
              .where({ verbKey: row.verb })
          );
          return verbDef ? { verbDefinition: { label: verbDef.label, tagline: verbDef.tagline } } : undefined;
        },
      });
    });

    // (#759 PR 3b) Mark-reviewed actions — flip authoringStatus to REVIEWED.
    // authoringStatus is @Common.FieldControl: #ReadOnly on the projections
    // so a plain OData PATCH is rejected; these dedicated actions write
    // direct SQL via cds.connect.to('db') and bypass the FieldControl
    // (the read-only constraint exists to prevent admins from free-form
    // editing status via the object-page form — they go through this
    // explicit "Mark as reviewed" button instead).
    async function runMarkReviewed({ entityName, writeEntity, id, req }) {
      const target = writeEntity || entityName;
      const db = await cds.connect.to('db');
      const row = await db.run(SELECT.one.from(target).where({ ID: id }));
      if (!row) {
        req.reject(404, `not found: ${id}`);
        return;
      }
      await db.run(UPDATE(target).set({ authoringStatus: 'REVIEWED' }).where({ ID: id }));
      return { processed: 1, skipped: 0, cost: '$0.00' };
    }

    this.on('markVerbExplainerReviewed', (req) =>
      runMarkReviewed({ entityName: 'com.sap.developers.ims.VerbDefinitions', id: req.data.id, req }));
    this.on('markShelfExplainerReviewed', (req) =>
      runMarkReviewed({ entityName: 'com.sap.developers.ims.ShelfDefinitions', id: req.data.id, req }));
    this.on('markShelfEntryExplainerReviewed', (req) =>
      runMarkReviewed({ entityName: 'com.sap.developers.ims.HomepageShelves', id: req.data.id, req }));

    // (#790) Bulk Mark-reviewed — flip every AI_SEEDED row in `ids` to
    // REVIEWED in one round-trip. BLANK rows are skipped (no content to
    // review yet); REVIEWED rows are skipped (no-op); IDs not present in
    // the DB are also counted as skipped (the SELECT silently drops them,
    // so `ids.length - aiSeededIds.length` rolls them into one bucket
    // with BLANK + REVIEWED). Callers see a single "skipped" total that
    // matches the issue's toast wording. Same authoringStatus FieldControl
    // bypass as runMarkReviewed.
    async function runBulkMarkReviewed({ entityName, ids }) {
      if (!Array.isArray(ids) || ids.length === 0) {
        return { processed: 0, skipped: 0, cost: '$0.00' };
      }
      const db = await cds.connect.to('db');
      // SELECT current statuses to compute processed vs skipped accurately.
      // A blind UPDATE would only return affectedRows (driver-dependent on
      // HANA via @sap/hana-client) and we'd lose the BLANK/REVIEWED breakdown.
      const rows = await db.run(
        SELECT.from(entityName).columns('ID', 'authoringStatus').where({ ID: { in: ids } })
      );
      const aiSeededIds = rows.filter(r => r.authoringStatus === 'AI_SEEDED').map(r => r.ID);
      if (aiSeededIds.length === 0) {
        return { processed: 0, skipped: ids.length, cost: '$0.00' };
      }
      await db.run(
        UPDATE(entityName).set({ authoringStatus: 'REVIEWED' }).where({ ID: { in: aiSeededIds } })
      );
      return {
        processed: aiSeededIds.length,
        skipped: ids.length - aiSeededIds.length,
        cost: '$0.00',
      };
    }

    this.on('bulkMarkVerbExplainerReviewed', (req) =>
      runBulkMarkReviewed({ entityName: 'com.sap.developers.ims.VerbDefinitions', ids: req.data.ids }));
    this.on('bulkMarkShelfExplainerReviewed', (req) =>
      runBulkMarkReviewed({ entityName: 'com.sap.developers.ims.ShelfDefinitions', ids: req.data.ids }));
    this.on('bulkMarkShelfEntryExplainerReviewed', (req) =>
      runBulkMarkReviewed({ entityName: 'com.sap.developers.ims.HomepageShelves', ids: req.data.ids }));

    // (#759 hotfix) Bound versions of `markReviewed` + `regenerate` on each
    // explainer entity. Fiori Elements V4 won't render an OP-header action
    // for an unbound service-level action without forcing a parameter dialog
    // first — and the original manifest `controlConfiguration[Identification]`
    // pattern silently no-op'd because the entity had no `UI.Identification`
    // annotation for FE to discover. Bound actions + `UI.DataFieldForAction`
    // in CDS annotations is the working precedent (KnowledgeGraphService /
    // Concepts.publishConcept). Row ID arrives via `req.params[0].ID` — the
    // canonical bound-action pattern. The unbound handlers above stay for
    // ListReport bulk fan-out (`generate*Explainers` / `mark*Reviewed`).
    //
    // (#1552) Each action is registered on BOTH the active entity AND its
    // `.drafts` shadow. When the Object Page is in EDIT mode, FE binds the
    // page to the draft (IsActiveEntity=false) and POSTs the bound action to
    // `Entity.drafts`; registering only on the active entity returned HTTP 501
    // ("no handler for regenerate AdminService.HomepageShelves.drafts"),
    // surfaced to the admin as "The server does not support the functionality
    // required to fulfill the request." `resolveWriteEntity` picks the draft
    // shadow when the invocation target is the draft, so the generated content
    // lands on the row the admin is editing (persisted on Save).
    function pickBoundId(req) {
      return req.params?.[0]?.ID;
    }
    // Returns the entity ref the action should read/write: the `.drafts`
    // shadow when invoked on a draft (edit mode), otherwise the active table
    // name. `req.target.name` ends with `.drafts` for draft invocations
    // (verified live in-memory).
    function resolveWriteEntity(req, activeEntity, draftEntity) {
      return req.target?.name?.endsWith('.drafts') ? draftEntity : activeEntity;
    }
    const VerbDefinitionsE  = this.entities.VerbDefinitions;
    const ShelfDefinitionsE = this.entities.ShelfDefinitions;
    const HomepageShelvesE  = this.entities.HomepageShelves;

    const markReviewedTargets = [
      [VerbDefinitionsE,  'com.sap.developers.ims.VerbDefinitions'],
      [ShelfDefinitionsE, 'com.sap.developers.ims.ShelfDefinitions'],
      [HomepageShelvesE,  'com.sap.developers.ims.HomepageShelves'],
    ];
    for (const [entity, activeName] of markReviewedTargets) {
      const draftName = entity.drafts.name; // AdminService.<Entity>.drafts
      this.on('markReviewed', [entity, entity.drafts], async (req) => {
        const id = pickBoundId(req);
        if (!id) return req.reject(400, 'Bound markReviewed invoked without entity context');
        return runMarkReviewed({
          entityName: activeName,
          writeEntity: resolveWriteEntity(req, activeName, draftName),
          id, req,
        });
      });
    }

    this.on('regenerate', [VerbDefinitionsE, VerbDefinitionsE.drafts], async (req) => {
      const id = pickBoundId(req);
      if (!id) return req.reject(400, 'Bound regenerate invoked without entity context');
      return runExplainerAction({
        kind: 'verb',
        entityName: 'com.sap.developers.ims.VerbDefinitions',
        writeEntity: resolveWriteEntity(req, 'com.sap.developers.ims.VerbDefinitions', VerbDefinitionsE.drafts.name),
        ids: [id], mode: 'regenerate-selected', req,
      });
    });
    this.on('regenerate', [ShelfDefinitionsE, ShelfDefinitionsE.drafts], async (req) => {
      const id = pickBoundId(req);
      if (!id) return req.reject(400, 'Bound regenerate invoked without entity context');
      return runExplainerAction({
        kind: 'shelf',
        entityName: 'com.sap.developers.ims.ShelfDefinitions',
        writeEntity: resolveWriteEntity(req, 'com.sap.developers.ims.ShelfDefinitions', ShelfDefinitionsE.drafts.name),
        ids: [id], mode: 'regenerate-selected', req,
      });
    });
    this.on('regenerate', [HomepageShelvesE, HomepageShelvesE.drafts], async (req) => {
      const id = pickBoundId(req);
      if (!id) return req.reject(400, 'Bound regenerate invoked without entity context');
      return runExplainerAction({
        kind: 'shelf-entry',
        entityName: 'com.sap.developers.ims.HomepageShelves',
        writeEntity: resolveWriteEntity(req, 'com.sap.developers.ims.HomepageShelves', HomepageShelvesE.drafts.name),
        ids: [id], mode: 'regenerate-selected', req,
        contextLookup: async (row) => {
          const db = await cds.connect.to('db');
          const verbDef = await db.run(
            SELECT.one.from('com.sap.developers.ims.VerbDefinitions').where({ verbKey: row.verb })
          );
          return verbDef ? { verbDefinition: { label: verbDef.label, tagline: verbDef.tagline } } : undefined;
        },
      });
    });

    // Petoberfest moderation bound actions on PetSubmissions.
    // Row ID arrives via req.params[0].ID — same canonical pattern as the
    // bound markReviewed/regenerate handlers above (see #759 hotfix comment).
    //
    // Auth note: AdminService is @requires:'Admin' at service level (admin-service.cds:13).
    // CAP enforces service-level auth first; action-level @requires in the CDS ANDs with it.
    // In practice, callers need Admin scope. The CDS annotation ['Tutorial.Author','Admin']
    // documents that users with Admin+Tutorial.Author (the standard admin user provisioning)
    // are the intended moderators. Tutorial.Author-only users (without Admin) cannot reach
    // this service and are rejected at the service gate before these handlers run.
    const { PetSubmissions } = this.entities;
    this.on('approve', PetSubmissions, async (req) => {
      const id = req.params?.[0]?.ID ?? req.params?.[0];
      if (!id) return req.reject(400, 'approve: missing entity key');
      await UPDATE(this.entities.PetSubmissions).set({ moderation: 'APPROVED' }).where({ ID: id });
      return req.reply();
    });
    this.on('hide', PetSubmissions, async (req) => {
      const id = req.params?.[0]?.ID ?? req.params?.[0];
      if (!id) return req.reject(400, 'hide: missing entity key');
      await UPDATE(this.entities.PetSubmissions).set({ moderation: 'HIDDEN' }).where({ ID: id });
      return req.reply();
    });
    // purge — permanent DELETE of a submission (row + BLOB columns). Guarded:
    // only HIDDEN submissions may be deleted (Hide-first). Same auth as approve/hide.
    // SELECT only the moderation scalar — never read BLOBs alongside (LOB hygiene);
    // the row DELETE removes photoDisplay/photoThumb as a side effect.
    this.on('purge', PetSubmissions, async (req) => {
      const id = req.params?.[0]?.ID ?? req.params?.[0];
      if (!id) return req.reject(400, 'purge: missing entity key');
      const row = await SELECT.one.from(this.entities.PetSubmissions).columns('moderation').where({ ID: id });
      if (!row) return req.reject(404, 'purge: submission not found');
      if (row.moderation !== 'HIDDEN') {
        return req.reject(400, 'Only hidden submissions can be deleted — hide it first.');
      }
      await DELETE.from(this.entities.PetSubmissions).where({ ID: id });
      return req.reply();
    });


    // Phase 2-B (#464): Severity-classified expiry warnings for the
    // admin-shell notifications popover. Read-only — no DB writes.
    // Imports daysUntil + classifySeverity from the cron module to share
    // the threshold + UTC-truncation contract.
    //
    // #1018: in addition to expiry, this handler now emits a synthetic
    // CRITICAL entry for any tracked row whose value is missing from
    // credstore. Same reason='missing-value' string the cron uses, so the
    // popover surface is symmetric with the daily PipelineLog summary.
    this.on('secretWarnings', async (req) => {
      const { Secrets } = cds.entities('com.sap.developers.ims');
      // Read ALL rows — a row without expiresAt can still have a missing
      // value and must surface as CRITICAL (see the cron for the same
      // pattern). Rows with no expiry AND a present value stay silent.
      const rows = await SELECT.from(Secrets)
        .columns('key', 'description', 'expiresAt', 'rotationOwner', 'rotationDocsUrl');

      // Presence probe per row. Uses the shared 5-min cache — the popover
      // polls every ~30s while the tab is active; we want a warm cache
      // between polls but a stale-safe refresh so admins see a save
      // take effect within one cache window.
      const presenceEntries = await Promise.all(
        rows.map(async (row) => [row.key, await checkSecretPresence(row.key)]),
      );
      const presence = new Map(presenceEntries);

      const now = new Date();
      const warnings = [];
      for (const row of rows) {
        // Missing-value warning first — a row with no credstore value is
        // CRITICAL regardless of expiresAt (probably shouldn't have an
        // expiresAt either, but we don't second-guess the metadata).
        if (!presence.get(row.key)) {
          warnings.push({
            key: row.key,
            description: row.description ?? '',
            daysRemaining: null,
            severity: 'CRITICAL',
            reason: 'missing-value',
            rotationOwner: row.rotationOwner ?? '',
            rotationDocsUrl: row.rotationDocsUrl ?? '',
          });
          continue;
        }
        if (!row.expiresAt) continue;
        const daysRemaining = daysUntil(row.expiresAt, now);
        const severity = classifySeverity(daysRemaining);
        if (!severity) continue;
        warnings.push({
          key: row.key,
          description: row.description ?? '',
          daysRemaining,
          severity,
          reason: 'expiry',
          rotationOwner: row.rotationOwner ?? '',
          rotationDocsUrl: row.rotationDocsUrl ?? '',
        });
      }

      // Sort: missing-value (daysRemaining === null) first, then by
      // ascending daysRemaining. Null sorts to the front intentionally —
      // Number(null) === 0 would collide with "expiring today"; explicit
      // partition keeps the two classes visually separate in the popover.
      warnings.sort((a, b) => {
        if (a.daysRemaining == null && b.daysRemaining != null) return -1;
        if (b.daysRemaining == null && a.daysRemaining != null) return 1;
        return (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0);
      });
      return warnings;
    });

    // ──────────────────────────────────────────────────────────────────────
    // Phase 2-C (#465): Secret value operations via BTP Credential Store.
    // Helpers + 4 handlers (3 actions + 1 function on Secrets).
    // ──────────────────────────────────────────────────────────────────────

    // ~30 second reveal window. Server-supplied; tile auto-hides on this expiry.
    const REVEAL_WINDOW_MS = 30_000;

    // Self-generate-able kinds — admin clicks Rotate, server mints + writes.
    const SELF_GEN_KINDS = new Set(['salt', 'content-api-key']);

    // Load the Secrets row by bound-action ID. All 4 handlers need this.
    // IMPORTANT 7: defensive guard against missing req.params shape (e.g. if
    // an action ever ends up wrongly bound to collection rather than instance,
    // req.params is []).
    const loadSecretRow = async (req) => {
      const { Secrets } = cds.entities('com.sap.developers.ims');
      const id = req.params?.[0]?.ID;
      if (!id) return req.reject(400, 'Secret ID required (bound to instance, not collection)');
      const row = await SELECT.one.from(Secrets).where({ ID: id });
      if (!row) req.reject(404, 'Secret not found');
      return row;
    };

    // Stamp lastRotatedAt on the row.
    const stampRotated = async (id) => {
      const { Secrets } = cds.entities('com.sap.developers.ims');
      const ts = new Date();
      await UPDATE(Secrets).set({ lastRotatedAt: ts }).where({ ID: id });
      return ts;
    };

    // BLOCKING 1: audit-log helper. Verified against existing usage at
    // srv/admin-service.js:1073 (canonical pattern: cds.connect.to('audit-log')
    // + audit.log('SecurityEvent', { data: { action, ...} })) and the
    // graceful-degradation pattern at srv/knowledge-graph-service.js:395-410
    // (warn on bind failure, warn on each write failure — visible monitoring,
    // not silent swallow).
    //
    // 'SecurityEvent' is the ONLY event name registered in the
    // @cap-js/audit-logging plugin's CDS service definition (alongside
    // SensitiveDataRead / PersonalDataModified / ConfigurationModified for
    // other entity-semantics). Custom event names like 'SecretValueRead'
    // are NOT registered and would silently drop or throw depending on
    // plugin version. The action discriminator therefore goes into
    // data.action — every call site stays ergonomic via this helper.
    //
    // cds.audit?.log?.(...) does NOT exist — optional-chaining would mean
    // audit events silently never fire. Use this helper everywhere instead.
    //
    // Hoisted bind: a missing audit binding (mis-MTA-config / dropped
    // binding after redeploy — feedback_cf_set_env_drops_on_redeploy) warns
    // ONCE at boot, not silently per call. Per-event throws are caught and
    // warned, NOT propagated — a successful credstore mutation must not
    // become a 500 to the admin just because audit logging hiccuped.
    const LOG = cds.log('admin-service');
    let _auditLog = null;
    try {
      _auditLog = await cds.connect.to('audit-log');
    } catch (err) {
      LOG.warn(`admin-service: audit-log binding unavailable (${err.message ?? err}); Secrets value ops will not be audited`);
    }
    const auditEvent = createAuditEmitter(_auditLog, LOG);

    // #756: expose the audit closure to the module-level emitJobAudit helper
    // so srv/jobs/scheduler.js can lazy-import it (circular-import-safe).
    _moduleAuditEvent = auditEvent;

    // IMPORTANT 8: response-header helper using public API. req._.res is CAP
    // internal and not guaranteed stable across minor versions. Prefer req.req.res
    // (the Express req has .res back-ref), fall back to req._.res, and silently
    // no-op if neither resolves. Action's return value carries the actual data
    // either way; the header is defense-in-depth.
    const setNoStoreHeaders = (req) => {
      const res = req.req?.res ?? req._?.res;
      if (res?.setHeader) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
      }
    };

    // Verify a credstore write actually landed. #1018: on 2026-07-06 a
    // CONTENT_API_KEY save via /admin-ui/#secrets returned 2xx from the
    // credstore but never persisted — the row stayed unreachable until the
    // envsubst fallback was stripped in PR #980 and every publish 503'd.
    // writeSecret throws on non-2xx, but not on 2xx-with-empty-body / silent
    // no-op / mTLS+JWE transport oddities (the credstore path went through
    // three fixes: PR #586, PR #588, PR #602). One extra round-trip per save
    // — the operation is rare (manual rotation) so latency doesn't matter.
    // readSecret returns null on 404 (never written) or throws on transport
    // error; either shape means the write claim is unverified.
    const verifyWritten = async (req, alias, expected) => {
      let observed;
      try {
        observed = await readSecret(alias);
      } catch (err) {
        return req.reject(500, `credstore write ${alias}: read-back failed: ${err.message ?? err}`);
      }
      if (observed !== expected) {
        return req.reject(500, `credstore write ${alias}: read-back mismatch (write claimed success but value did not persist)`);
      }
    };

    // ────────────────────────────────────────────────────────────────────
    this.on('setSecretValue', 'Secrets', async (req) => {
      const row = await loadSecretRow(req);
      const { value } = req.data;
      if (!value || typeof value !== 'string') {
        return req.reject(400, 'value (non-empty string) is required');
      }
      await writeSecret(row.key, value);
      // #1018: read-back guard — see verifyWritten helper above for the
      // 2026-07-06 CONTENT_API_KEY silent-failure context.
      await verifyWritten(req, row.key, value);
      // Hot-flush the shared secret-resolver cache so the next read picks up
      // the fresh value immediately (or null after a clear) — symmetric for
      // all credstore-fronted secrets (GITHUB_DISPATCH_TOKEN, SMTP_PASS,
      // SUBMISSION_SALT_SECRET, CONTENT_API_KEY). Without this, a rotation via
      // the admin UI would still be observed by callers up to the resolver's
      // 5-min TTL window. The rebuild-trigger.js `invalidateDispatchTokenCache`
      // export is a thin shim over this same call kept for direct callers.
      invalidateSecret(row.key);
      // #1154: App-credential rotations must also bust the cached GitHub App
      // installation token (github-app-token.js caches it ~55 min), else a UI
      // rotation of the private key / installation ID keeps minting with the
      // stale token until it self-expires.
      if (row.key === 'TUTORIALS_APP_ID' || row.key === 'TUTORIALS_APP_INSTALLATION_ID' || row.key === 'TUTORIALS_APP_PRIVATE_KEY') {
        invalidateInstallationToken();
      }
      // #1018: also flush the presence cache so the LR badge + popover
      // reflect the save on the next refresh (≤5 min TTL) instead of
      // waiting up to the resolver's separate window.
      invalidatePresence(row.key);
      // IMPORTANT 2 (quality-review): emit audit event immediately after the
      // external credstore mutation succeeds. The subsequent stampRotated() is
      // a HANA UPDATE that may fail / abort — if it does, the credstore has
      // the new value but the CRUD interceptor never fires (UPDATE didn't
      // commit). Without this explicit event, a successful write would
      // produce ZERO audit trail. Order: external mutation → audit → metadata.
      await auditEvent('SecretValueWritten', {
        user: req.user?.id,
        secretKey: row.key,
      });
      const lastRotatedAt = await stampRotated(row.ID);
      // CRUD interceptor on Secrets fires for the UPDATE on lastRotatedAt
      // → captured by @PersonalData.EntitySemantics: 'Other'; no explicit
      // audit event needed here.
      return { written: true, lastRotatedAt };
    });

    // ────────────────────────────────────────────────────────────────────
    this.on('rotateSecretValue', 'Secrets', async (req) => {
      const row = await loadSecretRow(req);
      const kindNormalized = String(row.kind ?? '').trim().toLowerCase();
      if (!SELF_GEN_KINDS.has(kindNormalized)) {
        // Vendor-side: emit audit event (no value mutation occurred but the
        // user attempted a rotation, worth logging).
        await auditEvent('SecretValueRotateAttempted', {
          user: req.user?.id,
          secretKey: row.key,
          rotated: false,
        });
        return {
          rotated: false,
          reason: 'vendor-side',
          newValue: '',
          written: false,
          lastRotatedAt: null,
          revealExpiresAt: null,
          rotationDocsUrl: row.rotationDocsUrl ?? '',
        };
      }
      // 32 bytes hex = 64-char string. Strong enough for salt + api-key.
      const newValue = randomBytes(32).toString('hex');
      await writeSecret(row.key, newValue);
      // #1018: read-back guard — see verifyWritten helper above.
      await verifyWritten(req, row.key, newValue);
      // See setSecretValue above — same universal hot-flush for any rotated
      // secret, not just GITHUB_DISPATCH_TOKEN.
      invalidateSecret(row.key);
      // #1154: App-credential rotations must also bust the cached GitHub App
      // installation token (github-app-token.js caches it ~55 min), else a UI
      // rotation of the private key / installation ID keeps minting with the
      // stale token until it self-expires.
      if (row.key === 'TUTORIALS_APP_ID' || row.key === 'TUTORIALS_APP_INSTALLATION_ID' || row.key === 'TUTORIALS_APP_PRIVATE_KEY') {
        invalidateInstallationToken();
      }
      invalidatePresence(row.key);
      // IMPORTANT 2 (quality-review): see setSecretValue for the same race.
      // Emit the write event BEFORE stampRotated in case HANA UPDATE fails.
      // The 'SecretValueRotated' event below is still emitted (richer payload)
      // but this one guarantees the external mutation appears in the audit
      // trail even if everything after this line throws.
      await auditEvent('SecretValueWritten', {
        user: req.user?.id,
        secretKey: row.key,
      });
      const lastRotatedAt = await stampRotated(row.ID);
      const revealExpiresAt = new Date(Date.now() + REVEAL_WINDOW_MS);
      // Custom action emitting plaintext — explicit audit event needed.
      await auditEvent('SecretValueRotated', {
        user: req.user?.id,
        secretKey: row.key,
        rotated: true,
      });
      return {
        rotated: true,
        reason: 'self-generated',
        newValue,
        written: true,
        lastRotatedAt,
        revealExpiresAt,
        rotationDocsUrl: '',
      };
    });

    // ────────────────────────────────────────────────────────────────────
    this.on('clearSecretValue', 'Secrets', async (req) => {
      const row = await loadSecretRow(req);
      await deleteSecret(row.key);
      // See setSecretValue above — universal hot-flush; the cleared secret
      // becomes null on the next resolveSecret() call instead of returning
      // the stale TTL'd value.
      invalidateSecret(row.key);
      // #1154: App-credential rotations must also bust the cached GitHub App
      // installation token (github-app-token.js caches it ~55 min), else a UI
      // rotation of the private key / installation ID keeps minting with the
      // stale token until it self-expires.
      if (row.key === 'TUTORIALS_APP_ID' || row.key === 'TUTORIALS_APP_INSTALLATION_ID' || row.key === 'TUTORIALS_APP_PRIVATE_KEY') {
        invalidateInstallationToken();
      }
      // #1018: also drop the presence cache so the LR flips to "missing"
      // on the next refresh instead of showing stale "present".
      invalidatePresence(row.key);
      // No HANA mutation; explicit audit event needed.
      await auditEvent('SecretValueCleared', {
        user: req.user?.id,
        secretKey: row.key,
      });
      return { cleared: true };
    });

    // ────────────────────────────────────────────────────────────────────
    this.on('revealSecretValue', 'Secrets', async (req) => {
      const row = await loadSecretRow(req);
      const value = await readSecret(row.key);
      if (value == null) return req.reject(404, 'No value stored for this secret');

      // Defense-in-depth: don't let proxies cache the response, even though
      // /admin/* is XSUAA-gated. `private` for shared-cache defense.
      // Best-effort: action's return value carries the data regardless.
      setNoStoreHeaders(req);

      // Function (read-only OData) — explicit audit event needed.
      // The value is NOT logged; only the access event.
      await auditEvent('SecretValueRead', {
        user: req.user?.id,
        secretKey: row.key,
      });

      return {
        value,
        expiresAt: new Date(Date.now() + REVEAL_WINDOW_MS),
      };
    });

    // Task 17 (#600) — audit listener for the TutorialProgressReset event
    // declared in srv/developer-service.cds and emitted by the reset action
    // in srv/developer-service.js. cds.emit + cds.on share the same in-process
    // event bus, so the listener fires for every successful reset. This is
    // SUPPLEMENTAL to the @PersonalData.cascade:'audit-only' annotations on
    // TaskRecords (which audit the writes themselves) — it captures the
    // INTENT of the reset (single semantic event) separate from N anonymous
    // status mutations. Listener uses cds.log('audit').info(...) so it shows
    // up in the structured-log stream alongside other audit observations
    // without coupling to the @cap-js/audit-logging service binding (which
    // would fail-open and silently drop in local dev without a binding).
    // Defensive try/catch: listener never throws — the reset action must
    // succeed regardless of observability outcome.
    cds.on('TutorialProgressReset', (msg) => {
      try {
        cds.log('audit').info('TutorialProgressReset', msg.data ?? msg);
      } catch (err) {
        cds.log('admin-service').warn(`audit listener for TutorialProgressReset failed: ${err.message ?? err}`);
      }
    });

    // Puzzle progress reset audit listener (mirrors TutorialProgressReset)
    cds.on('PuzzleProgressReset', (msg) => {
      try {
        cds.log('audit').info('PuzzleProgressReset', msg.data ?? msg);
      } catch (err) {
        cds.log('admin-service').warn(`audit listener for PuzzleProgressReset failed: ${err.message ?? err}`);
      }
    });

    // Phase 4.5 (#746): operator-grade api.sap.com seed trigger. Calls into
    // the same runSeedApiDocs() the CLI script (scripts/seed-api-docs.cjs)
    // uses — single source of truth. Dry-run when commit=false. Emits an
    // audit SecurityEvent on commit so the action shows up in the audit
    // trail alongside other admin writes.
    // Handler is placed AFTER the auditEvent closure (declared at the top of
    // init()) so the `auditEvent` reference resolves; placing it earlier
    // would TDZ-error at first call.
    // Audit emission is fire-and-forget via setImmediate to avoid coupling
    // the action response to outbox queue availability — same posture as
    // seedEmbeddings' embedSlugs invocation.
    this.on('seedApiDocs', async (req) => {
      const commit = !!req.data?.commit;
      const result = await runSeedApiDocs({ commit });
      if (commit && result.committed > 0) {
        const userId = req.user?.id;
        setImmediate(() => {
          // First arg is the action name (becomes data.action inside the
          // audit emitter; the SecurityEvent type is hardcoded inside the
          // closure). Pre-#769 this passed 'SecurityEvent' as the first arg
          // and relied on object-spread last-wins to overwrite data.action —
          // accidentally producing the correct row shape but emitting a
          // useless 'emit failed for SecurityEvent' warn line on failure.
          auditEvent('kg.api-docs.seed', {
            user: userId,
            committed: result.committed,
            planned: result.planned,
          }).catch((err) => {
            cds.log('admin-service').warn(`seedApiDocs audit emit failed: ${err.message ?? err}`);
          });
        });
      }
      return result;
    });

    // #1469: on-demand end-to-end ANS alert test. Fires the REAL alerting
    // code path (raiseTest → dedup → routing → cds.outboxed → ANS POST) with
    // a TEST-marked envelope, and — unlike the fail-open production hooks —
    // reports the outcome back so the admin knows if it actually fired.
    // Placed after the auditEvent closure (line ~2390) so the reference
    // resolves. Auth via entity-level @requires:'Admin' on ChatSettings.
    this.on('sendTestAlert', 'ChatSettings', async (req) => {
      const SEVERITIES = ['INFO', 'NOTICE', 'WARNING', 'ERROR', 'FATAL'];
      const severity = SEVERITIES.includes(req.data?.severity) ? req.data.severity : 'ERROR';
      const user = req.user?.id ?? 'unknown';
      const ts = new Date().toISOString();
      // Unique resourceName per click dodges the plugin's 5-min dedup window
      // (dedup key is `${eventType}:${resourceName}`), so every click fires.
      const resourceName = `admin-test:${user}:${ts}`;

      // TEST-INJECTION HOOK: globalThis.__TEST_raiseTest lets unit tests inject
      // a controlled stub (same pattern as __TEST_emitJobAudit at line ~2971).
      const _raiseTest = globalThis.__TEST_raiseTest ?? raiseTest;
      const result = await _raiseTest({
        eventType: 'AlertingTest',
        severity,
        category: 'ALERT',
        subject: '[TEST] Admin-triggered alert',
        body: `Manual end-to-end verification of the ANS alerting path. Not a real incident. Triggered by ${user} at ${ts}.`,
        resource: { resourceName, resourceType: 'service' },
        tags: { 'ans:correlationId': 'admin-test' },
      });

      // Fire-and-forget audit (mirrors seedApiDocs). Never fails the action.
      setImmediate(() => {
        auditEvent('alerting.test-alert', { user, outcome: result.outcome, severity })
          .catch((err) => cds.log('admin-service').warn(`sendTestAlert audit emit failed: ${err.message ?? err}`));
      });

      return { outcome: result.outcome, reason: result.reason ?? null, eventType: 'AlertingTest', severity };
    });

    // Phase 4.6 (#747): operator-grade SAP-samples corpus bootstrap.
    // Unlike seedApiDocs (which invokes runSeedApiDocs synchronously and
    // returns planned/committed counts), seedSamples is fire-and-forget:
    // it kicks the fetch-samples cron in setImmediate with sinceIsoOverride
    // to bypass the MAX-or-abort gate exactly once, then returns
    // { started, reason } synchronously. The cron itself writes JobLastRun
    // + chassis audit events (cron.manual-trigger.*) as it runs — same
    // posture as the JobControls.runJob path at line 1934.
    //
    // Audit emission uses the post-#769 canonical pattern: first arg is the
    // ACTION NAME ('kg.samples.seed'), NOT 'SecurityEvent'. The
    // SecurityEvent audit type is hardcoded inside the createAuditEmitter
    // closure (see srv/lib/audit-event.js).
    this.on('seedSamples', async (req) => {
      const commit = !!req.data?.commit;
      if (!commit) {
        return { started: false, reason: 'dry-run (pass commit=true to actually seed)' };
      }
      const userId = req.user?.id;
      // Fire-and-forget: invoke the cron with sinceIsoOverride to bypass
      // the MAX-or-abort first-run gate. Budget override 1000 ensures the
      // initial seed isn't truncated by the per-cycle 50-extraction cap.
      setImmediate(() => {
        runJobByName('fetch-samples', {
          manualTrigger: true,
          user: userId,
          sinceIsoOverride: '1970-01-01T00:00:00Z',
          budgetOverride: 1000,
        }).catch((err) => {
          cds.log('admin-service').error(`seedSamples cron failed: ${err.message ?? err}`);
        });
      });
      setImmediate(() => {
        auditEvent('kg.samples.seed', {
          user: userId,
          committed: true,
        }).catch((err) => {
          cds.log('admin-service').warn(`seedSamples audit emit failed: ${err.message ?? err}`);
        });
      });
      return { started: true, reason: null };
    });

    // Phase 4.7 (#748): operator-grade HelpDocs corpus bootstrap
    // (help.sap.com + cap.cloud.sap + ui5.sap.com). Fire-and-forget
    // sibling of seedSamples — same shape, different cron. Audit emission
    // uses the post-#769 canonical pattern: first arg is the ACTION NAME
    // ('kg.help-docs.seed'), NOT 'SecurityEvent'. The SecurityEvent audit
    // type is hardcoded inside the createAuditEmitter closure.
    this.on('seedHelpDocs', async (req) => {
      const commit = !!req.data?.commit;
      if (!commit) {
        return { started: false, reason: 'dry-run (pass commit=true to actually seed)' };
      }
      const userId = req.user?.id;
      // Fire-and-forget: invoke the cron with sinceIsoOverride to bypass
      // the MAX-or-abort first-run gate. Budget override null means "respect
      // ChatSettings"; the CLI uses Infinity for unbounded bootstrap.
      setImmediate(() => {
        runJobByName('fetch-help-docs', {
          manualTrigger: true,
          user: userId,
          sinceIsoOverride: '1970-01-01T00:00:00Z',
          budgetOverride: null,
        }).catch((err) => {
          cds.log('admin-service').error(`seedHelpDocs cron failed: ${err.message ?? err}`);
        });
      });
      setImmediate(() => {
        auditEvent('kg.help-docs.seed', {
          user: userId,
          committed: true,
        }).catch((err) => {
          cds.log('admin-service').warn(`seedHelpDocs audit emit failed: ${err.message ?? err}`);
        });
      });
      return { started: true, reason: null };
    });

    // Phase 4.8 (#765): operator-grade CommunityEvents corpus bootstrap
    // (Khoros CodeJams + Devtoberfest RSS). Fire-and-forget sibling of
    // seedHelpDocs — same shape, different cron. Audit emission uses the
    // post-#769 canonical pattern: first arg is the ACTION NAME
    // ('kg.community-events.seed'), NOT 'SecurityEvent'.
    this.on('seedCommunityEvents', async (req) => {
      const commit = !!req.data?.commit;
      if (!commit) {
        return { started: false, reason: 'dry-run (pass commit=true to actually seed)' };
      }
      const userId = req.user?.id;
      setImmediate(() => {
        runJobByName('fetch-community-events', {
          manualTrigger: true,
          user: userId,
          sinceIsoOverride: '1970-01-01T00:00:00Z',
          budgetOverride: null,
        }).catch((err) => {
          cds.log('admin-service').error(`seedCommunityEvents cron failed: ${err.message ?? err}`);
        });
      });
      setImmediate(() => {
        auditEvent('kg.community-events.seed', {
          user: userId,
          committed: true,
        }).catch((err) => {
          cds.log('admin-service').warn(`seedCommunityEvents audit emit failed: ${err.message ?? err}`);
        });
      });
      return { started: true, reason: null };
    });

    // ─────────────────────────────────────────────────────────────────
    // #756: AdminService.JobControls actions.
    //
    // listJobs() — iterate the in-process JOB_REGISTRY and compute
    // nextRunIso via cron-parser. Failed parses log-and-skip (no 500
    // on a single malformed schedule).
    //
    // runJob(jobName) — validate length + registry membership BEFORE
    // any audit emission (so malformed payloads can't spam the audit
    // log). Then fire-and-forget the 'started' audit event + the
    // background runJobByName call. The runWithLock chassis (Task 1)
    // emits the completion audit event after the fn resolves or the
    // lock is held.
    //
    // Spec: docs/superpowers/specs/2026-06-29-756-admin-cron-trigger.md §4.5-4.8
    // ─────────────────────────────────────────────────────────────────
    this.on('listJobs', 'JobControls', async () => {
      const registry = _getJobRegistry();
      const now = new Date();
      const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      // #1021: fetch stuck outbox targets in one pass — fail-open (empty
      // Map on any error) so a detection fault never masks legitimate rows.
      //
      // TEST-INJECTION HOOK: cds.test('serve') loads this file via
      // cds.utils._import (file:// URL on Windows) which bypasses Vitest's
      // ESM mock interceptor. globalThis.__TEST_loadStuckOutboxTargets and
      // globalThis.__TEST_isRowStale let unit tests inject
      // fakes without vi.mock. Production never sets these globals.
      const _loadStuck = globalThis.__TEST_loadStuckOutboxTargets ?? loadStuckOutboxTargets;
      const _isStale = globalThis.__TEST_isRowStale ?? isRowStale;

      let stuckByJob;
      try {
        stuckByJob = await _loadStuck();
      } catch (err) {
        LOG.warn(`listJobs: loadStuckOutboxTargets failed: ${err.message}`);
        stuckByJob = new Map();
      }

      return Array.from(registry.values()).map(job => {
        let nextRunsIso = [];
        let nextRunIso = null;
        try {
          nextRunsIso = enumerateFiringsWithinWindow(job.schedule, now, horizon, 50);
          // #750: fallback only when the 24h window is empty (monthly crons).
          // Explicit length check — NOT `??` — to make the intent unambiguous:
          // we only invoke nextRunIsoFrom() in the empty case, not always.
          nextRunIso = nextRunsIso.length > 0
            ? nextRunsIso[0]
            : nextRunIsoFrom(job.schedule, now);
        } catch (err) {
          LOG.warn(`listJobs: cron-parser failed on '${job.schedule}': ${err.message}`);
        }
        // #1021: wedged iff a processing outbox row exists for this job
        // AND the row's own timestamp has been surpassed by the next fire.
        const rowStartedAt = stuckByJob.get(job.jobName);
        const wedged = !!rowStartedAt && _isStale(job.schedule, rowStartedAt, now);
        return {
          jobName: job.jobName,
          schedule: job.schedule,
          ttlMs: job.ttlMs,
          description: job.description,
          nextRunIso,
          nextRunsIso,
          wedged,
        };
      });
    });

    // #1023: return currently-executing scheduled jobs so the Cron health
    // tile can distinguish RUNNING from a stale last-completed failure.
    // Reads PipelineLog rows written by srv/jobs/scheduler.js:runWithLock
    // (via srv/lib/pipeline-log.js:logPipelineStart) that haven't been
    // finalized yet. jobName lives inside metadata JSON, extracted here
    // rather than via HANA JSON_VALUE so the code paths stay identical
    // across SQLite (unit tests) and HANA (hybrid + prod).
    this.on('listRunningJobs', 'JobControls', async () => {
      const { PipelineLog } = cds.entities('com.sap.developers.ims');
      let rows;
      try {
        rows = await SELECT.from(PipelineLog)
          .columns('metadata', 'startedAt')
          .where({ pipelineType: 'SCHEDULED_JOB', status: 'RUNNING' });
      } catch (err) {
        LOG.warn(`listRunningJobs SELECT failed: ${err.message ?? err}`);
        return [];
      }
      const out = [];
      for (const row of rows || []) {
        let jobName = null;
        if (row.metadata) {
          try {
            const parsed = JSON.parse(row.metadata);
            if (parsed && typeof parsed.jobName === 'string') {
              jobName = parsed.jobName;
            }
          } catch (err) {
            // Malformed metadata JSON — skip this row, don't fail the whole read.
            LOG.warn(`listRunningJobs: unparseable metadata: ${err.message ?? err}`);
          }
        }
        if (jobName) {
          out.push({ jobName, startedAt: row.startedAt });
        }
      }
      return out;
    });

    this.on('runJob', 'JobControls', async (req) => {
      const { jobName } = req.data;
      // Validation FIRST — before any audit emission — to avoid log spam
      // from malformed payloads.
      if (typeof jobName !== 'string' || jobName.length === 0 || jobName.length > MAX_JOB_NAME_LEN) {
        return req.reject(400, `Invalid jobName (must be non-empty string <=${MAX_JOB_NAME_LEN} chars)`);
      }
      const registry = _getJobRegistry();
      if (!registry.has(jobName)) {
        return req.reject(400, `Unknown jobName: ${jobName}`);
      }
      const user = req.user?.id ?? 'unknown';
      const startedAt = new Date();

      // Audit "started" event (fire-and-forget).
      setImmediate(() => {
        emitJobAudit({ jobName, user, outcome: 'started', startedAt })
          .catch(err => LOG.warn(`runJob audit (started) failed: ${err.message}`));
      });

      // Fire the cron run in the background — handler returns immediately.
      // runJobByName invokes runWithLock which (Task 1) emits the completion
      // audit event after the fn resolves or the lock is held.
      setImmediate(() => {
        runJobByName(jobName, { manualTrigger: true, user })
          .catch(err => LOG.error(`runJob ${jobName} failed: ${err.message}`));
      });

      return {
        jobName,
        started: true,
        skipped: false,
        reason: null,
        startedAt,
      };
    });

    // #1021: forceUnwedge — DELETE the stuck cds.outbox.Messages row
    // for jobName. DELETE-only; operators click "Run now" separately if
    // they want the missed run to fire immediately.
    this.on('forceUnwedge', 'JobControls', async (req) => {
      const { jobName } = req.data;
      if (typeof jobName !== 'string' || jobName.length === 0 || jobName.length > MAX_JOB_NAME_LEN) {
        return req.reject(400, `Invalid jobName (must be non-empty string <=${MAX_JOB_NAME_LEN} chars)`);
      }
      const registry = _getJobRegistry();
      if (!registry.has(jobName)) {
        return req.reject(400, `Unknown jobName: ${jobName}`);
      }
      const user = req.user?.id ?? 'unknown';
      const startedAt = new Date();

      // Audit BEFORE the DELETE so an audit row always exists even if
      // the DELETE later fails. Fire-and-forget — audit failure never
      // fails the action.
      // TEST-INJECTION HOOK: globalThis.__TEST_emitJobAudit lets unit
      // tests verify audit calls without ESM spy limitations (same
      // pattern as __TEST_loadStuckOutboxTargets in listJobs).
      const _emitAudit = globalThis.__TEST_emitJobAudit ?? emitJobAudit;
      setImmediate(() => {
        _emitAudit({ jobName, user, outcome: 'unwedged', startedAt })
          .catch(err => LOG.warn(`forceUnwedge audit failed: ${err.message}`));
      });

      // TEST-INJECTION HOOK: globalThis.__TEST_deleteStuckOutboxRow lets
      // unit tests control the deletion result without real DB operations.
      const _deleteRow = globalThis.__TEST_deleteStuckOutboxRow ?? deleteStuckOutboxRow;
      const cleared = await _deleteRow(jobName);
      return {
        jobName,
        cleared,
        reason: cleared
          ? null
          : 'No stuck outbox row found (already clear, or CAP outbox not present)',
      };
    });

    // #1293: forceClose — flip an orphaned PipelineLog row stuck at
    // RUNNING for jobName to FAILED. Sibling to forceUnwedge, but a
    // DIFFERENT table: forceUnwedge deletes the cds.outbox.Messages row;
    // this closes the PipelineLog health-tile row that a process death
    // (deploy/crash) left orphaned when runWithLock's finally never ran.
    // No age gate — operator-initiated. Emits SecurityEvent audit BEFORE
    // the close so an audit row always exists even if the close fails.
    this.on('forceClose', 'JobControls', async (req) => {
      const { jobName } = req.data;
      if (typeof jobName !== 'string' || jobName.length === 0 || jobName.length > MAX_JOB_NAME_LEN) {
        return req.reject(400, `Invalid jobName (must be non-empty string <=${MAX_JOB_NAME_LEN} chars)`);
      }
      const registry = _getJobRegistry();
      if (!registry.has(jobName)) {
        return req.reject(400, `Unknown jobName: ${jobName}`);
      }
      const user = req.user?.id ?? 'unknown';
      const startedAt = new Date();

      // TEST-INJECTION HOOK: globalThis.__TEST_emitJobAudit mirrors the
      // forceUnwedge pattern for ESM-mock-free unit assertions.
      const _emitAudit = globalThis.__TEST_emitJobAudit ?? emitJobAudit;
      setImmediate(() => {
        _emitAudit({ jobName, user, outcome: 'force-closed', startedAt })
          .catch(err => LOG.warn(`forceClose audit failed: ${err.message}`));
      });

      // TEST-INJECTION HOOK: globalThis.__TEST_forceCloseRunningPipelineLog
      // lets unit tests control the close result without real DB operations.
      const _forceClose = globalThis.__TEST_forceCloseRunningPipelineLog ?? forceCloseRunningPipelineLog;
      const { closed } = await _forceClose(jobName);
      return {
        jobName,
        closed,
        reason: closed > 0
          ? null
          : 'No orphaned RUNNING PipelineLog row found (already closed, or job not currently logged as running)',
      };
    });
    // Bound action on Tutorials. Resolves slug, audit-logs intent, dispatches
    // a slug-targeted rebuild via scheduleRebuild's 60s debounce. Shared body
    // lives in srv/lib/rebuild-action-handler.js so AuthorService can reuse it
    // (#617) with only the `source` string differing.
    this.on('rebuildContent', 'Tutorials', async (req) => {
      return handleRebuildAction(req, {
        source: 'admin-ui:tutorial-detail',
        selectOne: (id) => SELECT.one.from(Tutorials).columns('slug', 'title').where({ ID: id }),
        audit: auditEvent,
        schedule: scheduleRebuild,
      });
    });

    // ── promoteCommunityToMission — #917 ──
    // Drafts a Mission from a Louvain-detected KG community. Atomically
    // writes Missions + CompletionPaths + CompletionPathItems inside one
    // db.tx so a mid-flight failure never leaves an empty Mission behind.
    // Tutorials are ordered deterministically A→Z by title — no LLM-driven
    // "smart" curation. The curator finishes the draft in the Missions LR
    // (title/description/reorder/publish). SuperAdmin-gated via @requires
    // in admin-service.cds; the CDS gate is authoritative, no in-handler
    // recheck (matches the Missions.published pattern at line 1585).
    //
    // Audit uses the post-#769 canonical pattern: first arg is the ACTION
    // NAME ('kg.community.promoted'). The SecurityEvent event type is
    // hardcoded inside createAuditEmitter. Audit is best-effort — a blown
    // audit MUST NOT roll back a successful promotion (fail-open at the
    // helper level, see srv/lib/audit-event.js).
    this.on('promoteCommunityToMission', async (req) => {
      const { communityId, missionSlug, title } = req.data || {};
      if (communityId == null || !missionSlug || !title) {
        return req.reject(400, 'communityId, missionSlug, and title are required');
      }

      const { Missions, CompletionPaths, CompletionPathItems, Tutorials, KgCommunity } =
        cds.entities('com.sap.developers.ims');

      // 1. Load community's tutorial-typed members, then look up matching
      //    Tutorials rows sorted A→Z by title. Members whose slug no longer
      //    resolves in Tutorials are silently skipped (tutorial deleted
      //    between the nightly Louvain pass and this call).
      const members = await SELECT.from(KgCommunity)
        .columns('slug')
        .where({ communityId, vertexType: 'tutorial' });
      if (!members || members.length === 0) {
        return req.reject(404, `no tutorial members found for community ${communityId}`);
      }
      const memberSlugs = members.map((r) => r.slug).filter(Boolean);
      const tutorials = memberSlugs.length
        ? await SELECT.from(Tutorials)
            .columns('ID', 'title', 'slug')
            .where({ slug: { in: memberSlugs } })
            .orderBy('title asc')
        : [];
      if (tutorials.length === 0) {
        return req.reject(404, `community ${communityId} members not found in Tutorials`);
      }

      const lcSlug = String(missionSlug).toLowerCase();
      const missionId = randomUUID();
      const pathId = randomUUID();

      // Fingerprint keyed to the tutorial-typed member slug set — stable
      // across Louvain re-runs while the tutorial cluster contents are
      // stable. Louvain-emitted communityId gets recycled next pass, so
      // Missions.sourceKgCommunityId is retained for audit only; the
      // alreadyPromoted filter (#986) keys off the fingerprint via a
      // materialized LEFT JOIN. #985.
      //
      // Hash over the tutorials we actually resolved (post-slug lookup),
      // not the raw KgCommunity slug list — a promotion where some slugs
      // no longer resolve semantically "already promoted" the reachable
      // subset only. Downstream re-promotion should still be blocked
      // for the SAME reachable subset, hence hash the resolved list.
      const fingerprint = computeKgCommunityFingerprint(
        tutorials.map((t) => t.slug)
      );

      // 2. Atomic write — reuse the request's tx so all three INSERTs
      //    commit or roll back together with the outer request boundary.
      const tx = cds.tx(req);
      await tx.run(
        INSERT.into(Missions).entries({
          ID: missionId,
          slug: lcSlug,
          title,
          published: false,
          sourceKgCommunityId: communityId,
          sourceKgCommunityFingerprint: fingerprint,
        })
      );
      await tx.run(
        INSERT.into(CompletionPaths).entries({
          ID: pathId,
          mission_ID: missionId,
          name: 'Default',
          slug: `${lcSlug}-default`,
        })
      );
      await tx.run(
        INSERT.into(CompletionPathItems).entries(
          tutorials.map((t, idx) => ({
            ID: randomUUID(),
            path_ID: pathId,
            tutorial_ID: t.ID,
            taskType: 'TUTORIAL',
            itemOrder: idx,
          }))
        )
      );

      // 3. Audit — fail-open. createAuditEmitter already swallows and warns
      //    on per-event throws, but wrap defensively in case the helper
      //    itself is unavailable (e.g. audit-log binding init raced).
      try {
        await auditEvent('kg.community.promoted', {
          user: req.user?.id,
          communityId,
          missionSlug: lcSlug,
          missionId,
          memberCount: tutorials.length,
        });
      } catch (err) {
        cds.log('admin-service').warn(
          `promoteCommunityToMission audit emit failed: ${err?.message ?? err}`
        );
      }

      // 4. Return the created Mission so FE can navigate to its OP.
      return await SELECT.one.from(Missions).where({ ID: missionId });
    });

    // ── KgCommunities read decorators — #917 ──
    // topConceptSlugs: for each row, gather up to 3 concept-typed member
    // slugs from KgCommunity (same communityId). Computed at read time; no
    // extra column on the base view. Slugs are joined with ', ' and
    // truncated to 255 chars to match the projection's virtual type.
    // Sorted alphabetically so the LR presentation is stable across reads.
    this.after('READ', 'KgCommunities', async (rows) => {
      if (!rows) return;
      const list = Array.isArray(rows) ? rows : [rows];
      if (list.length === 0) return;
      const ids = list.map((r) => r.communityId).filter((v) => v != null);
      if (ids.length === 0) return;
      const { KgCommunity } = cds.entities('com.sap.developers.ims');
      const concepts = await SELECT.from(KgCommunity)
        .columns('communityId', 'slug')
        .where({ communityId: { in: ids }, vertexType: 'concept' });
      const byId = new Map();
      for (const c of concepts) {
        if (c.slug == null) continue;
        if (!byId.has(c.communityId)) byId.set(c.communityId, []);
        byId.get(c.communityId).push(c.slug);
      }
      for (const row of list) {
        const slugs = (byId.get(row.communityId) || []).slice().sort();
        const joined = slugs.slice(0, 3).join(', ');
        row.topConceptSlugs = joined.length > 255 ? joined.slice(0, 255) : joined;
      }
    });

    // ── KgCommunities coverage/orphan nudges — #1172 ──────────────────────
    // For each community row, compute (over TUTORIAL members only, against
    // PUBLISHED missions only): mission-coverage %, dominant covering mission,
    // orphan-tutorial count, and a coverageHigh flag (>= threshold). Populates
    // the virtual fields added in srv/admin-service.cds.
    //
    // Fail-quiet, in its OWN try/catch separate from topConceptSlugs above: any
    // throw → warn-log, fields left unset, Fiori renders no badge (never a
    // 500). Mirrors the #918 isolated-flag posture.
    //
    // Packet-safe: the covered-slug fetch chunks the .in() slug list at 500 to
    // stay under HANA's bound-param cap (memory: cqn-where-in-hana-packet-cap).
    // Spec: docs/superpowers/specs/2026-07-14-1172-kg-community-curator-nudges-design.md
    const COVERAGE_SLUG_CHUNK = 500;

    // Packet-safe chunked IN-query helper (memory: cqn-where-in-hana-packet-cap).
    // Splits any unbounded id list into COVERAGE_SLUG_CHUNK-sized slices to stay
    // under HANA's bound-param limit. SQLite unit tests would never catch an
    // unbounded .in() blowing the packet cap; use this helper for ALL three IN
    // queries in the coverage decorator.
    async function selectInChunks(entity, idColumn, ids, columns) {
      const out = [];
      for (let i = 0; i < ids.length; i += COVERAGE_SLUG_CHUNK) {
        const slice = ids.slice(i, i + COVERAGE_SLUG_CHUNK);
        // slice is always non-empty here because i < ids.length guarantees at least one element.
        out.push(...(await SELECT.from(entity).columns(...columns).where({ [idColumn]: { in: slice } })));
      }
      return out;
    }

    this.after('READ', 'KgCommunities', async (rows) => {
      if (!rows) return;
      const list = Array.isArray(rows) ? rows : [rows];
      if (list.length === 0) return;
      const ids = list.map((r) => r.communityId).filter((v) => v != null);
      if (ids.length === 0) return;
      try {
        const { KgCommunity, CompletionPathItems, CompletionPaths, Missions } = cds.entities('com.sap.developers.ims');

        // 1. Tutorial members per community (the denominator).
        const memberRows = await SELECT.from(KgCommunity)
          .columns('communityId', 'slug')
          .where({ communityId: { in: ids }, vertexType: 'tutorial' });
        const memberSlugsByCommunity = new Map();
        const allSlugs = new Set();
        for (const m of memberRows) {
          if (m.slug == null) continue;
          const s = String(m.slug).toLowerCase();
          if (!memberSlugsByCommunity.has(m.communityId)) memberSlugsByCommunity.set(m.communityId, []);
          memberSlugsByCommunity.get(m.communityId).push(s);
          allSlugs.add(s);
        }
        // Communities with zero tutorial members still need a result entry so
        // the helper can null their fields.
        for (const id of ids) if (!memberSlugsByCommunity.has(id)) memberSlugsByCommunity.set(id, []);

        // 2. Covered slug → published mission(s).
        // Two-step approach (chosen over path navigation for CI-Node-22 safety):
        //   (a) SELECT CompletionPathItems by tutorial slug → get tutorial.slug + path_ID
        //   (b) Resolve path IDs → CompletionPaths → mission_IDs → Missions (published=true)
        //       then join in Node to produce {slug, missionTitle, missionSlug} rows.
        // This avoids the path.mission.title cross-association projection which can
        // behave differently on Node 22 CI (see brief CQL path-navigation caveat).
        // ALL three IN-queries use selectInChunks — see COVERAGE_SLUG_CHUNK comment above.
        const coveredRows = [];
        const slugArr = [...allSlugs];
        for (let i = 0; i < slugArr.length; i += COVERAGE_SLUG_CHUNK) {
          const chunk = slugArr.slice(i, i + COVERAGE_SLUG_CHUNK);
          // chunk is always non-empty here: i < slugArr.length guarantees at least one element.

          // Step (a): get slug + path_ID for this chunk of tutorial slugs.
          const pathItemRows = await SELECT.from(CompletionPathItems)
            .columns('tutorial.slug as tutSlug', 'path_ID')
            .where({ 'tutorial.slug': { in: chunk } });

          if (!pathItemRows.length) continue;
          const pathIds = [...new Set(pathItemRows.map((r) => r.path_ID).filter(Boolean))];
          if (!pathIds.length) continue;

          // Step (b): resolve path_IDs → CompletionPaths → mission_ID.
          // Chunked: pathIds can exceed COVERAGE_SLUG_CHUNK when many slugs map to many paths.
          const pathRows = await selectInChunks(CompletionPaths, 'ID', pathIds, ['ID', 'mission_ID']);
          const missionIds = [...new Set(pathRows.map((r) => r.mission_ID).filter(Boolean))];
          if (!missionIds.length) continue;

          // Step (c): fetch published missions only.
          // Chunked: missionIds can exceed COVERAGE_SLUG_CHUNK when many paths map to many missions.
          const missionRows = await selectInChunks(Missions, 'ID', missionIds, ['ID', 'title', 'slug', 'published']);

          // Step (d): join in Node — filter to published-only here (published was fetched
          // as a column so we can filter post-chunk-accumulation rather than duplicating
          // WHERE logic across slices).
          const missionById = new Map(missionRows.filter((m) => m.published === true).map((m) => [m.ID, m]));
          const pathToMission = new Map(
            pathRows
              .map((p) => {
                const m = missionById.get(p.mission_ID);
                return m ? [p.ID, { missionTitle: m.title, missionSlug: m.slug }] : null;
              })
              .filter(Boolean),
          );
          for (const item of pathItemRows) {
            if (!item.tutSlug || !item.path_ID) continue;
            const m = pathToMission.get(item.path_ID);
            if (m) coveredRows.push({ slug: item.tutSlug, missionTitle: m.missionTitle, missionSlug: m.missionSlug });
          }
        }

        // 3. Compute + assign.
        const threshold = resolveThreshold(process.env);
        const result = computeCoverage({ memberSlugsByCommunity, coveredRows, threshold });
        for (const row of list) {
          const r = result.get(row.communityId);
          if (!r) continue;
          row.missionCoveragePct = r.missionCoveragePct;
          row.dominantMissionTitle = r.dominantMissionTitle;
          row.dominantMissionSlug = r.dominantMissionSlug;
          row.orphanTutorialCount = r.orphanTutorialCount;
          row.coverageHigh = r.coverageHigh;
        }
      } catch (err) {
        cds.log('kg-community-coverage').warn(
          `admin-service: coverage nudge computation failed on KgCommunities; leaving fields unset (${err?.message ?? err})`,
        );
      }
    });

    // alreadyPromoted is materialized by KgCommunitySummaryV's LEFT JOIN
    // Missions on communityFingerprint (#986). No after('READ') decorator
    // needed — the LR filter (SPV #default) evaluates against a real
    // column at the DB layer, and the previous Node-side compute has been
    // dropped. See db/knowledge-graph-communities.cds and issue #985/#986.

    // ── TopicClustersAdmin read decorator — Task 11 (#topics-discovery) ──
    // Populate the virtual effectiveLabel column: prefer curatedLabel, fall
    // back to label. Mirrors the KgCommunities topConceptSlugs pattern above.
    this.after('READ', 'TopicClustersAdmin', (rows) => {
      if (!rows) return;
      const list = Array.isArray(rows) ? rows : [rows];
      for (const r of list) r.effectiveLabel = r.curatedLabel || r.label;
    });

    // ── overrideTopicLabel — Task 11 (#topics-discovery) ──
    // Sets curatedLabel on the underlying TopicClusters row. The nightly job
    // carries curatedLabel forward via overridesBySlug, so the override
    // survives TRUNCATE+INSERT cycles.
    this.on('overrideTopicLabel', async (req) => {
      const { slug, label } = req.data;
      const { TopicClusters } = cds.entities('com.sap.developers.ims');
      // Slugs are minted lowercase (topic-cluster-reconcile slugify); canonicalize
      // the action input so a mixed-case slug still matches the stored row.
      const lcSlug = (slug || '').toLowerCase();
      await UPDATE(TopicClusters).set({ curatedLabel: label }).where({ slug: lcSlug });
      return true;
    });

    // ── setTopicClusterHidden — Task 11 (#topics-discovery) ──
    // Toggles the hidden flag on the underlying TopicClusters row. The nightly
    // job carries hidden forward via overridesBySlug across TRUNCATE cycles.
    this.on('setTopicClusterHidden', async (req) => {
      const { slug, hidden } = req.data;
      const { TopicClusters } = cds.entities('com.sap.developers.ims');
      // Slugs are minted lowercase; canonicalize the action input to match.
      const lcSlug = (slug || '').toLowerCase();
      await UPDATE(TopicClusters).set({ hidden }).where({ slug: lcSlug });
      return true;
    });

    // ── clearKhorosLink — admin on-behalf-of variant (issue #566) ──
    // Bound action on Users. Nulls the 4 Khoros columns, evicts the
    // in-process cache, and emits an INFO log for operational debugging.
    // @cap-js/audit-logging captures the UPDATE automatically via the
    // @PersonalData annotations on Users — no manual audit-row write needed.
    this.on('clearKhorosLink', 'Users', async (req) => {
      const userId = req.params?.[0]?.ID;
      if (!userId) return req.reject(400, 'userId required');
      const dbUser = await SELECT.one.from(Users).where({ ID: userId });
      if (!dbUser) return req.reject(404, 'User not found');
      const prevKhorosId = dbUser.khorosId;
      await UPDATE(Users)
        .set({ khorosId: null, khorosLogin: null, khorosAvatarUrl: null, khorosLinkedAt: null })
        .where({ ID: userId });
      if (prevKhorosId) await khorosCache.evict(prevKhorosId);
      cds.log('khoros').info('admin cleared khoros link', {
        adminEmail: req.user?.id, targetUserId: userId, prevKhorosId
      });
      return { status: 'ok' };
    });

    // (#763) Persona-tag validator — rejects unknown tags at save time on
    // both HomepageShelves and the new ForYou candidate pool.
    // Draft lifecycle: NEW/PATCH fire on entity.drafts; SAVE fires on drafts at activation.
    // Direct REST: CREATE/UPDATE fire on the active entity.
    const { HomepageShelves, HomepageForYouCandidatesAdmin } = this.entities;
    const shelfEvents = ['CREATE', 'UPDATE', 'NEW', 'PATCH', 'SAVE'];
    this.before(shelfEvents, HomepageShelves, checkPersonaTagsHandler);
    this.before(shelfEvents, HomepageShelves.drafts, checkPersonaTagsHandler);
    this.before(shelfEvents, HomepageForYouCandidatesAdmin, checkPersonaTagsHandler);
    this.before(shelfEvents, HomepageForYouCandidatesAdmin.drafts, checkPersonaTagsHandler);

    // ── (#1032) Featured missions carousel admin handlers ──
    // recomputeFeaturedTopics — SuperAdmin manual trigger to force a fresh
    // snapshot materialisation without waiting for the nightly job.
    this.on('recomputeFeaturedTopics', async () => {
      const { count, computedAt } = await cds.tx(async (tx) => recomputeSnapshot(tx));
      resetFtCache();
      return { count, computedAt };
    });

    // (#1031) recomputeHomepageVideoRotation — SuperAdmin manual trigger.
    // Same code path as the 4h cron; used for the DEV cutover to populate
    // HomepageVideoRotation immediately without waiting for the next tick.
    this.on('recomputeHomepageVideoRotation', async () => {
      return runReshuffleVideoRotation();
    });

    // After-SAVE on the draft-active flow: recompute the snapshot inline
    // (≤8 rows, fast) so admins see the updated carousel immediately, then
    // fire a debounced rebuild so hugo/data/featured_topics.json refreshes.
    this.after(['CREATE', 'UPDATE', 'DELETE'], 'FeaturedTopics', async (_data, req) => {
      try {
        await cds.tx(async (tx) => recomputeSnapshot(tx));
        resetFtCache();
      } catch (err) {
        cds.log('admin-featured').warn('inline recompute failed after write:', err.message);
      }
      try {
        await scheduleRebuild('admin-featured-topics-write', { mode: 'catalog-only' });
      } catch (err) {
        cds.log('admin-featured').warn('rebuild dispatch failed:', err.message);
      }
    });

    // #1106 Phase 3 (WS2) — admin curation MCP tools. Each handler delegates
    // to an existing action/entry point; per-action @requires in
    // srv/admin-service-mcp.cds is authoritative for auth.
    this.on('merge_concepts', mcpAdmin.handleMergeConcepts);
    this.on('promote_community_to_mission', mcpAdmin.handlePromoteCommunity);
    this.on('trigger_rebuild', mcpAdmin.handleTriggerRebuild);
    this.on('publish_content', mcpAdmin.handlePublishContent);

    // ── Freshness detector actions (task-7) ──────────────────────────────────
    // checkFreshness: per-tutorial trigger — runs detection+persist INLINE (v1).
    // Returns {status:'DONE'|'FAILED', reportId}. Never throws a 500.
    // NON-DESTRUCTIVE on fault: when detectFreshness signals ok:false (AI Core
    // down, parse/grounding throw) we do NOT persist — the prior report + author
    // dispositions are left intact, and we report FAILED without writing any row.
    this.on('checkFreshness', 'Tutorials', async (req) => {
      const tutorialId = req.params?.[0]?.ID;
      if (!tutorialId) return req.reject(400, 'tutorialId required');
      const { detectFreshness } = await import('./lib/freshness-detector.js');
      const { persistReport } = await import('./lib/freshness-persist.js');
      const db = await cds.connect.to('db');
      try {
        const r = await detectFreshness({ db, tutorialId });
        // Real fault: do NOT call persistReport, do NOT write any report row,
        // leave the prior report + dispositions untouched.
        if (!r.ok) return { status: 'FAILED', reportId: null };
        const { reportId } = await persistReport({
          db, tutorialId, model: r.model, costCents: r.costCents, findings: r.findings,
        });
        return { status: 'DONE', reportId };
      } catch (err) {
        // Top-level guard so the action never 500s. The fault is normally
        // signaled by ok:false above; this only catches truly unexpected throws.
        cds.log('freshness').error('checkFreshness failed', err);
        return { status: 'FAILED', reportId: null };
      }
    });

    // setDisposition: per-finding disposition setter — validates enum, updates
    // the row with dispositionBy = req.user?.id, returns {status:'ok'}.
    this.on('setDisposition', 'FreshnessFinding', async (req) => {
      const id = req.params?.[0]?.ID;
      if (!id) return req.reject(400, 'finding id required');
      const { disposition, note } = req.data;
      if (!['OPEN', 'ACCEPTED', 'DISMISSED', 'FIXED'].includes(disposition)) {
        return req.reject(400, 'invalid disposition');
      }
      const { FreshnessFinding } = cds.entities('com.sap.developers.ims');
      await UPDATE(FreshnessFinding).set({
        disposition,
        dispositionNote: note || null,
        dispositionBy: req.user?.id || 'unknown',
        dispositionAt: new Date().toISOString(),
      }).where({ ID: id });
      return { status: 'ok' };
    });

    await super.init();

    // Allow standalone read access to ChangeView (plugin sets Readable:false by default)
    const changeView = this.model.definitions['AdminService.ChangeView'];
    if (changeView) changeView['@Capabilities.ReadRestrictions.Readable'] = true;
  }

  async _collectClassifyTargets(kind, ids) {
    const out = [];
    const kinds = kind === 'all' ? ['mission', 'group', 'tutorial'] : [kind];
    // Use the entity refs from the persisted model, not the bare projection
    // names ('Missions'/'Groups'/'Tutorials'). Under `cds.test('serve','--in-memory')`
    // the AdminService projections are compiled as views, but the awaited
    // SELECT ultimately dispatches through `cds.db`, whose model only carries
    // the fully-qualified persisted names. Passing the bare projection name
    // there yields `SELECT ID FROM Missions` → SQLite "no such table" on some
    // Node versions where the resolver doesn't fall back to the projection.
    // Grabbing the entity references from `cds.entities(NS)` sidesteps this.
    const { Missions, Groups, Tutorials } = cds.entities('com.sap.developers.ims');
    const entityRef = { mission: Missions, group: Groups, tutorial: Tutorials };
    for (const k of kinds) {
      const entity = entityRef[k];
      const where = (Array.isArray(ids) && ids.length > 0) ? { ID: { in: ids } } : {};
      const rows = await SELECT.from(entity).columns('ID').where(where);
      for (const r of rows) out.push({ kind: k, id: r.ID });
    }
    return out;
  }

  async _executeAnonymization(user, opts = {}) {
    const db = await cds.connect.to('db');
    const { PrivacyProtectionActions } = cds.entities('com.sap.developers.ims');
    const { dsrRequestNumber } = opts;
    // Identify the auditor for the audit row. Falls back to the audit-log
    // pseudo-user when no human session is present (scripts / tests).
    const auditor = cds.context?.user?.id || 'system';

    // 1. DSR-only: open the action row (idempotent — guard if it already exists).
    if (dsrRequestNumber) {
      const existing = await SELECT.one.from(PrivacyProtectionActions).where({
        userUuid: user.uuid, actionType: 'ANONYMIZE'
      });
      if (!existing) {
        await INSERT.into(PrivacyProtectionActions).entries({
          userUuid: user.uuid,
          actionType: 'ANONYMIZE',
          requestedAt: new Date().toISOString(),
          status: 'PROCESSING',
          dsrRequestNumber,  // PR #554: was silently dropped before schema extension
          createdBy: auditor,
          legacyId: await getNextLegacyId('PrivacyProtectionActions', db)
        });
      }
    }

    // 2. Cascade — handles ALL @PersonalData entities by annotation.
    // Dynamic import keeps this dependency lazy: the cascade module
    // only loads when an anonymization is actually triggered, and the
    // pattern matches the project's other ad-hoc-handler imports
    // (chat-orchestrator.js, content-store.js, etc.).
    const { executeAnonymizationCascade } = await import('./lib/anonymization-cascade.js');
    await executeAnonymizationCascade(user, db);

    // 3. DSR-only: close the action row.
    if (dsrRequestNumber) {
      await UPDATE(PrivacyProtectionActions)
        .where({ userUuid: user.uuid, actionType: 'ANONYMIZE', status: 'PROCESSING' })
        .set({ status: 'COMPLETED', completedAt: new Date().toISOString() });
    }

    // 4. Audit log (always — both action handlers want this).
    const audit = await cds.connect.to('audit-log');
    await audit.log('SecurityEvent', {
      data: { action: 'AnonymizeUser', sapId: user.sapId, dsrRequestNumber: dsrRequestNumber ?? null }
    });
  }
}

function csvEscape(value) {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}
