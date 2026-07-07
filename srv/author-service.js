import cds from '@sap/cds';
import { reviewTutorial, snoozeTutorial } from './lib/tutorial-review.js';
import { generateOsVariants } from './lib/os-variant-generator.js';
import { createRateLimiter, RateLimitError } from './lib/chat-rate-limit.js';
import { scheduleRebuild } from './lib/rebuild-trigger.js';
import { createAuditEmitter } from './lib/audit-event.js';
import { handleRebuildAction } from './lib/rebuild-action-handler.js';
import { attachTagsMdFormatHandlers } from './lib/tag-md-format-handlers.js';
import { resolveDbUser, resolveUserSapId } from './lib/resolve-db-user.js';

const OS_VALUES = ['Windows', 'macOS', 'Linux', 'BAS'];
const OS_VARIANTS_LIMIT = 60;             // calls per hour per author
const OS_VARIANTS_WINDOW_MS = 60 * 60 * 1000;
const osVariantsLimiter = createRateLimiter({ windowMs: OS_VARIANTS_WINDOW_MS });

// #1027 — MyTutorials-family endpoints silently return {"value": []} when the
// authenticated caller has no matching Users row (`resolveDbUser` returns null).
// That's indistinguishable from "you legitimately own zero tutorials," which
// obscures the real failure mode: a token whose `user_uuid` claim doesn't
// match any `Users.sapId`. Cost the #1027 investigation the better part of
// an afternoon (Sage extension had a stale OAuth clientId → tokens with an
// audience-mismatched user identity → 0 rows returned silently).
//
// Log it at WARN so `cf logs tutorials-srv --recent | grep 'Users-row miss'`
// surfaces the diagnostic on the next report of "endpoint X returned 0
// tutorials." The log line includes the resolved sapId (from the JWT) and
// the caller's email claim so ops can correlate against the Users table
// without needing the raw JWT.
function warnUsersRowMiss(log, endpoint, user) {
  const sapId = resolveUserSapId(user);
  log.warn(
    `[Users-row miss] endpoint=${endpoint} user.id=${user?.id ?? '<none>'} ` +
    `resolved-sapId=${sapId ?? '<none>'} attr.email=${user?.attr?.email ?? '<none>'} ` +
    `— returning 0 rows. Check the token's user_uuid claim against Users.sapId.`
  );
}

// #777 followup (2026-06-30) — MyTutorialsView keys on Users.uuid (the
// CAP-context-friendly identifier exposed as MyTutorialsView.userId).
// `req.user.id` from XSUAA tokens against SAP IDP is the user's email
// (per srv/lib/resolve-db-user.js — confirmed in IMS Java sources), NOT
// the uuid. Filtering the view on `req.user.id` returns 0 rows for every
// authenticated request. Resolve to the Users row first, then filter on
// its uuid. Pattern matches every other authenticated handler in this
// codebase (developer-service.js, admin-service.js, server.js#/auth/user).
async function assertOwnership(tutorialId, user) {
  const dbUser = await resolveDbUser(user, ['uuid']);
  if (!dbUser?.uuid) return false;
  const { MyTutorialsView } = cds.entities('com.sap.developers.ims');
  const row = await SELECT.one.from(MyTutorialsView)
    .columns('tutorial_ID')
    .where({ tutorial_ID: tutorialId, userId: dbUser.uuid });
  return !!row;
}

export default cds.service.impl(async function () {
  const { MyTutorials, MyAuthoredTutorials, MyOwnedTutorials } = this.entities;
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
  //
  // #890: ownership check is REQUIRED here — the Tutorial.Author scope is
  // shared across all authors, so without this any author could queue a
  // rebuild (expensive; GH Actions quota) against any other author's
  // tutorial by ID. AdminService's rebuildContent is intentionally
  // unrestricted; only the author projection needs this gate.
  this.on('rebuildContent', 'Tutorials', async (req) => {
    const tutorialId = req.params?.[0]?.ID ?? req.params?.[0];
    if (!tutorialId) {
      return req.reject(400, 'Tutorial ID is required');
    }
    if (!(await assertOwnership(tutorialId, req.user))) {
      return req.reject(403, 'Not the owner of this tutorial');
    }
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

  this.before('READ', MyTutorials, async (req) => {
    if (!req.user?.id || req.user.id === 'anonymous') {
      return req.reject(401, 'Authentication required');
    }
    // See assertOwnership above for the req.user.id-vs-Users.uuid rationale.
    // resolveDbUser falls back to req.user.id for non-JWT auth contexts
    // (basic-auth tech users, tests, mock contexts) so old behavior is
    // preserved there.
    const dbUser = await resolveDbUser(req.user, ['uuid']);
    if (!dbUser?.uuid) {
      // No Users row for this caller — could be a fresh-login user whose
      // row hasn't been auto-provisioned yet, or a test context with no
      // matching sapId, or (#1027) a token minted against a stale XSUAA
      // client whose user_uuid doesn't match any Users.sapId. Return zero
      // rows rather than 401: the user IS authenticated; they simply own
      // no tutorials. Log at WARN so the diagnostic is grep-able next
      // time — see warnUsersRowMiss.
      warnUsersRowMiss(cds.log('author-service'), 'MyTutorials', req.user);
      req.query.where({ userId: '__NO_USERS_ROW__' });
      return;
    }
    req.query.where({ userId: dbUser.uuid });
  });

  // #862 — MyAuthoredTutorials uses the same caller-scoping semantics as
  // MyTutorials. The bestPriority=1 filter is baked into the CDS projection
  // (srv/author-service.cds) so all we do here is stamp the userId. That's
  // what makes GET /author/MyAuthoredTutorials return strict-authorship-only
  // rows without any client-side filtering.
  this.before('READ', MyAuthoredTutorials, async (req) => {
    if (!req.user?.id || req.user.id === 'anonymous') {
      return req.reject(401, 'Authentication required');
    }
    const dbUser = await resolveDbUser(req.user, ['uuid']);
    if (!dbUser?.uuid) {
      warnUsersRowMiss(cds.log('author-service'), 'MyAuthoredTutorials', req.user);
      req.query.where({ userId: '__NO_USERS_ROW__' });
      return;
    }
    req.query.where({ userId: dbUser.uuid });
  });

  // #862 reopen — MyOwnedTutorials is Sage's "My Tutorials" panel. The
  // projection sources from MyTutorialsView.bestPriority IN (3, 4) —
  // either ownerEmail match OR owner-display-name match. Stamps userId
  // from resolveDbUser so both joins are caller-scoped. #923's
  // MyMonitoredTutorialsView repoint was reverted; see srv/author-
  // service.cds for the rationale. TutorialMonitors + toggleMonitor
  // from #923 remain for the eye-icon watch feature.
  this.before('READ', MyOwnedTutorials, async (req) => {
    if (!req.user?.id || req.user.id === 'anonymous') {
      return req.reject(401, 'Authentication required');
    }
    const dbUser = await resolveDbUser(req.user, ['uuid']);
    if (!dbUser?.uuid) {
      warnUsersRowMiss(cds.log('author-service'), 'MyOwnedTutorials', req.user);
      req.query.where({ userId: '__NO_USERS_ROW__' });
      return;
    }
    req.query.where({ userId: dbUser.uuid });
  });

  // Tags.mdFormat is a virtual field (no DB column) — populated on the way out
  // so OData consumers (Sage tag-search, #824) get the legacy IMS markdown-ready
  // key, e.g. titlePath "Topic : SAP Community" → mdFormat "topic>sap-community".
  // Algorithm parity with com.sap.developers.ims.util.TagUtil; symmetric with
  // the identical wiring on AdminService.Tags so both surfaces agree.
  //
  // The attached handlers also translate any `$filter` predicate over the
  // virtual `mdFormat` field into a titlePath predicate for SQL push-down,
  // then re-apply the original predicate in JS after applyMdFormat runs
  // (#837 — Sage complex filter expression returning 500). Without this
  // the DB errors on the missing column and CAP surfaces a generic 500.
  attachTagsMdFormatHandlers(this, 'Tags');

  this.on('reviewTutorial', async (req) => {
    const { tutorialId } = req.data;
    if (!(await assertOwnership(tutorialId, req.user))) {
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
    const { tutorialId, days } = req.data;
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return req.reject(400, 'days must be an integer in [1, 365]');
    }
    if (!(await assertOwnership(tutorialId, req.user))) {
      return req.reject(403, 'Not the owner of this tutorial');
    }
    try {
      return await snoozeTutorial(tutorialId, days);
    } catch (err) {
      if (err.code === 404) return req.reject(404, err.message);
      throw err;
    }
  });

  // #923 — Sage's "watch this tutorial" toggle. Mirrors Java IMS's
  // POST /tutorialMeta/setMonitoredStatus semantics: upsert TutorialMonitors
  // row for (caller, tutorial) when status=true; delete when status=false.
  //
  // Idempotent by design — the @assert.unique.userTutorial constraint means a
  // second true-call resolves to the existing row (INSERT is guarded by an
  // exists-check). A second false-call is a no-op (DELETE affects 0 rows).
  //
  // Returns the *post-call* monitored state (true when the row is present,
  // false when absent). Same as Java's ResponseEntity<CREATED|NO_CONTENT>.
  this.on('toggleMonitor', async (req) => {
    const { tutorialId, status } = req.data;
    if (!req.user?.id || req.user.id === 'anonymous') {
      return req.reject(401, 'Authentication required');
    }
    const dbUser = await resolveDbUser(req.user, ['ID']);
    if (!dbUser?.ID) {
      return req.reject(403, 'No matching Users row for caller');
    }
    // Confirm the target tutorial exists (400 rather than a foreign-key
    // failure on INSERT). No ownership assertion — this is a personal
    // watch-list toggle, not an admin action.
    const { Tutorials, TutorialMonitors } = cds.entities('com.sap.developers.ims');
    const t = await SELECT.one.from(Tutorials).columns('ID', 'status').where({ ID: tutorialId });
    if (!t) return req.reject(404, 'Tutorial not found');
    // Refuse to watch INACTIVE/DELETED tutorials — the view would filter
    // them out on read anyway, and letting a row accumulate against a soft-
    // deleted tutorial would leak invisible rows into the DB.
    if (t.status === 'INACTIVE' || t.status === 'DELETED') {
      return req.reject(410, `Tutorial ${tutorialId} is ${t.status}`);
    }

    const existing = await SELECT.one.from(TutorialMonitors)
      .columns('ID')
      .where({ user_ID: dbUser.ID, tutorial_ID: tutorialId });

    if (status) {
      if (!existing) {
        try {
          await INSERT.into(TutorialMonitors).entries({
            ID: cds.utils.uuid(),
            user_ID: dbUser.ID,
            tutorial_ID: tutorialId,
          });
        } catch (err) {
          // Race: another concurrent toggleMonitor(true) call created the row
          // between our SELECT and INSERT. Treat as success — the invariant
          // is "row exists after this call" and it does.
          if (!/unique|duplicate|assert/i.test(String(err.message || ''))) throw err;
        }
      }
      return true;
    } else {
      if (existing) {
        await DELETE.from(TutorialMonitors).where({ ID: existing.ID });
      }
      return false;
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
