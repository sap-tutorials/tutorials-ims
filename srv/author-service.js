import cds from '@sap/cds';
import { reviewTutorial, snoozeTutorial } from './lib/tutorial-review.js';
import { generateOsVariants } from './lib/os-variant-generator.js';
import { createRateLimiter, RateLimitError } from './lib/chat-rate-limit.js';
import { scheduleRebuild } from './lib/rebuild-trigger.js';
import { createAuditEmitter } from './lib/audit-event.js';
import { handleRebuildAction } from './lib/rebuild-action-handler.js';

const OS_VALUES = ['Windows', 'macOS', 'Linux', 'BAS'];
const OS_VARIANTS_LIMIT = 60;             // calls per hour per author
const OS_VARIANTS_WINDOW_MS = 60 * 60 * 1000;
const osVariantsLimiter = createRateLimiter({ windowMs: OS_VARIANTS_WINDOW_MS });

async function assertOwnership(tutorialId, userId) {
  const { MyTutorialsView } = cds.entities('com.sap.developers.ims');
  const row = await SELECT.one.from(MyTutorialsView)
    .columns('ID')
    .where({ ID: tutorialId, ownerUserId: userId });
  return !!row;
}

export default cds.service.impl(async function () {
  const { MyTutorials } = this.entities;
  const { Tutorials } = this.entities;

  // Audit emitter — best-effort; tolerates missing binding in dev/mock-auth.
  let _auditLog;
  try {
    _auditLog = await cds.connect.to('audit-log');
  } catch (err) {
    cds.log('author-service').warn(
      `audit-log binding unavailable (${err?.message ?? err}); rebuild events will not be audited`
    );
  }
  const auditEvent = createAuditEmitter(_auditLog, cds.log('author-service'));

  // rebuildContent — symmetric with AdminService; differs only by source string.
  // The shared helper in srv/lib/rebuild-action-handler.js derives the dispatch
  // reason from the source prefix → 'author-ui:rebuild-button:<user>'.
  this.on('rebuildContent', 'Tutorials', async (req) => {
    return handleRebuildAction(req, {
      source: 'author-ui:tutorial-detail',
      selectOne: (id) =>
        SELECT.one.from(Tutorials).columns('slug', 'title').where({ ID: id }),
      audit: auditEvent,
      schedule: scheduleRebuild,
    });
  });

  // listExposedEntities — curated subset for the analytics-explorer entity dropdown.
  //
  // sqlName values are display-only: AuthorService deliberately omits the
  // `runSelectQuery` ad-hoc SQL action (admin-only), so these strings never
  // reach a query path. They're shown in the UI's entity picker for parity
  // with the admin Analytics tile. If a future task adds an author SQL
  // surface, switch to dialect-aware computation like analytics-service.js
  // does (it uppercases on HANA).
  this.on('listExposedEntities', () => [
    { name: 'CompletionAnalytics',        sqlName: 'com_sap_developers_ims_CompletionAnalytics',        label: 'Completion analytics' },
    { name: 'CodeCheckSubmissions',       sqlName: 'com_sap_developers_ims_CodeCheckSubmissions',       label: 'Code check submissions' },
    { name: 'ValidateAnswerSubmissions',  sqlName: 'com_sap_developers_ims_ValidateAnswerSubmissions',  label: 'Validation submissions' },
    { name: 'ActiveLearnersDaily',        sqlName: 'com_sap_developers_ims_ActiveLearnersDaily',        label: 'Active learners (daily)' },
    { name: 'AnalyticsBranchPerformance', sqlName: 'com_sap_developers_ims_AnalyticsBranchPerformance', label: 'Branch performance' },
    { name: 'AnalyticsBranchTopPick',     sqlName: 'com_sap_developers_ims_AnalyticsBranchTopPick',     label: 'Branch top pick' },
    { name: 'Tasks',                      sqlName: 'com_sap_developers_ims_Tasks',                      label: 'Tasks' },
    { name: 'TaskRecords',                sqlName: 'com_sap_developers_ims_TaskRecords',                label: 'Task records' },
    { name: 'UIEvents',                   sqlName: 'com_sap_developers_ims_UIEvent',                    label: 'UI events' },
  ]);

  this.before('READ', MyTutorials, (req) => {
    const userId = req.user?.id;
    if (!userId || userId === 'anonymous') return req.reject(401, 'Authentication required');
    req.query.where({ ownerUserId: userId });
  });

  this.on('reviewTutorial', async (req) => {
    const userId = req.user?.id;
    const { tutorialId } = req.data;
    if (!(await assertOwnership(tutorialId, userId))) {
      return req.reject(403, 'Not the owner of this tutorial');
    }
    try {
      return await reviewTutorial(tutorialId);
    } catch (err) {
      if (err.code === 404) return req.reject(404, err.message);
      throw err;
    }
  });

  this.on('snoozeTutorial', async (req) => {
    const userId = req.user?.id;
    const { tutorialId, days } = req.data;
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return req.reject(400, 'days must be an integer in [1, 365]');
    }
    if (!(await assertOwnership(tutorialId, userId))) {
      return req.reject(403, 'Not the owner of this tutorial');
    }
    try {
      return await snoozeTutorial(tutorialId, days);
    } catch (err) {
      if (err.code === 404) return req.reject(404, err.message);
      throw err;
    }
  });

  this.on('generateOsVariants', async (req) => {
    const { sourceMarkdown, sourceOS, targetOSes, context } = req.data;
    const userId = req.user?.id ?? 'anonymous';

    if (!sourceMarkdown || typeof sourceMarkdown !== 'string' || sourceMarkdown.length === 0 || sourceMarkdown.length > 8000) {
      return req.reject(400, 'sourceMarkdown must be 1..8000 chars');
    }
    if (!OS_VALUES.includes(sourceOS)) return req.reject(400, 'invalid sourceOS');
    if (!Array.isArray(targetOSes) || targetOSes.length === 0 || targetOSes.length > 3) {
      return req.reject(400, 'targetOSes must be a non-empty array of length 1..3');
    }
    const seen = new Set();
    for (const t of targetOSes) {
      if (!OS_VALUES.includes(t))   return req.reject(400, `invalid targetOS: ${t}`);
      if (t === sourceOS)           return req.reject(400, 'targetOSes cannot include sourceOS');
      if (seen.has(t))              return req.reject(400, `duplicate targetOS: ${t}`);
      seen.add(t);
    }

    try {
      osVariantsLimiter.check(userId, OS_VARIANTS_LIMIT);
    } catch (err) {
      if (err instanceof RateLimitError) {
        return req.reject(429, `Rate limit exceeded — retry after ${err.retryAfterSec}s`);
      }
      throw err;
    }

    return generateOsVariants({ sourceMarkdown, sourceOS, targetOSes, context: context ?? {}, userId });
  });

  this.on('isSlugAvailable', async (req) => {
    const { slug } = req.data;
    if (!slug || typeof slug !== 'string') {
      return req.reject(400, 'slug must be a non-empty string');
    }
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    // LOWER()-based case-insensitive match. Mirrors the publish-side upsert
    // shape in srv/lib/content-publish-session.js so this UX check uses the
    // same key space as @assert.unique.slug's enforcement at write time.
    const row = await SELECT.one.from(Tutorials)
      .columns('ID')
      .where`LOWER(slug) = ${slug.toLowerCase()}`;
    return !row;  // true = available
  });
});
