// srv-sage/author-sage-service.js
//
// Handlers for AuthorSageService — isolated IAS-authenticated author surface
// for the SAGE VS Code extension.
//
// Exposes ONLY the 5 operations SAGE actually uses:
//   1. MyOwnedTutorials  — caller-scoped read (before-READ ownership stamp)
//   2. Tags              — read-only tag catalogue
//   3. isSlugAvailable   — slug UX hint (not a lock)
//   4. reviewTutorial    — marks reviewed; returns timestamp + notification count
//   5. snoozeTutorial    — snoozes notifications; returns next date + count
//
// Auth gate: @requires 'authenticated-user' (IAS tokens carry no XSUAA scopes).
// Per-user isolation is maintained via ownership checks identical to those in
// srv/author-service.js — dropping from Tutorial.Author → authenticated-user
// does NOT loosen data access, only the service entry gate.
//
// Identity resolution: same tiered resolver as srv-mcp — a before('*') hook
// calls pinResolvedUser to walk (iss,sub) link → sapId → email. This means
// IAS social users (no SAP ID) are also correctly resolved when their email
// matches a Users row. The main AuthorService uses XSUAA's user_uuid claim
// which IAS tokens don't carry; the tiered resolver handles both.
//
// No AI, GitHub, or credstore imports — those ops (generateOsVariants,
// rebuildContent) are intentionally excluded from this surface.
//
// (#task-4 — srv-sage handlers + ownership proof)

import cds from '@sap/cds';
import { reviewTutorial, snoozeTutorial } from './lib/tutorial-review.js';

// Workspace-first shim — resolves from @tutorials/core in local dev, from the
// bundled core.bundle.mjs at CF deploy. Do NOT also import from
// srv/lib/resolve-db-user.js (split-module-state: two copies of the module
// would have distinct module-level state, breaking provisionDbUser's
// SELECT-then-INSERT idempotency across the same request).
let resolveDbUser, provisionDbUser, pinResolvedUser, resolveUserSapId;
try {
  ({ resolveDbUser, provisionDbUser, pinResolvedUser, resolveUserSapId }
    = await import('@tutorials/core/resolve-db-user.js'));
} catch {
  ({ resolveDbUser, provisionDbUser, pinResolvedUser, resolveUserSapId }
    = await import('./lib/_shared/core.bundle.mjs'));
}

const LOG = cds.log('author-sage-service');

// #1027 — silence is indistinguishable from "owns zero tutorials." Log at WARN
// so `cf logs tutorials-srv-sage --recent | grep 'Users-row miss'` surfaces
// the diagnostic. Carries ONLY the resolved sapId (no PII).
function warnUsersRowMiss(endpoint, user) {
  const sapId = resolveUserSapId(user);
  LOG.warn(
    `[Users-row miss] endpoint=${endpoint} resolved-sapId=${sapId ?? '<none>'} ` +
    `— returning 0 rows. Check the token's user_uuid claim against Users.sapId.`
  );
}

// assertOwnership — returns true iff the authenticated user owns the tutorial.
// Ported verbatim from srv/author-service.js: resolves to the Users row via
// the tiered resolver, then checks MyTutorialsView for the (tutorial_ID,
// userId=Users.uuid) pair.
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
  const { MyOwnedTutorials } = this.entities;

  // ── Identity pin (IAS / XSUAA / social) ─────────────────────────────────
  // Runs BEFORE every handler. Resolves the Users row via (iss,sub) link →
  // sapId → email and pins the result onto req.user.attr so the downstream
  // resolveDbUser / assertOwnership calls are synchronous fast-paths.
  // Fail-open: an unresolvable identity leaves the context unpinned; each
  // handler's own null/anonymous guard then rejects with 401.
  this.before('*', async (req) => {
    try {
      await pinResolvedUser(req.user);
    } catch (err) {
      LOG.warn('[author-sage-service] identity pin failed:', err?.message ?? err);
    }
  });

  // ── 1. MyOwnedTutorials — caller-scoped read ──────────────────────────────
  // Stamps WHERE userId = caller's uuid so the OData query is scoped to the
  // caller's ownership set. Mirrors srv/author-service.js's before-READ for
  // MyOwnedTutorials (issue #862 reopen / ADR 0006 §2026-08-19).
  this.before('READ', MyOwnedTutorials, async (req) => {
    if (!req.user?.id || req.user.id === 'anonymous') {
      return req.reject(401, 'Authentication required');
    }
    // provisionDbUser = get-or-create: mints the Users row from JWT claims on
    // first access so authors who have never browser-logged-in are still
    // resolved. This is especially important for SAGE authors whose row was
    // never created by the migrator (see srv/author-service.js comment).
    const dbUser = await provisionDbUser(req.user, ['uuid']);
    if (!dbUser?.uuid) {
      warnUsersRowMiss('MyOwnedTutorials', req.user);
      req.query.where({ userId: '__NO_USERS_ROW__' });
      return;
    }
    req.query.where({ userId: dbUser.uuid });
  });

  // ── 2. Tags — read-only ──────────────────────────────────────────────────
  // No handler needed: the CDS projection already limits to @readonly, and
  // @requires 'authenticated-user' on the service is the only gate. Tags are
  // not user-scoped. If the main AuthorService's attachTagsMdFormatHandlers
  // behaviour is needed here, it can be added in a follow-up (not needed for
  // the SAGE tag picker which uses the raw titlePath column).

  // ── 3. isSlugAvailable — slug UX hint ─────────────────────────────────────
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
    return !row; // true = available
  });

  // ── 4. reviewTutorial — ownership-gated ──────────────────────────────────
  // The ownership check is REQUIRED even under authenticated-user: without it
  // any authenticated user (the new, broader gate) could mark any tutorial as
  // reviewed. The check is identical to srv/author-service.js.
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

  // ── 5. snoozeTutorial — ownership-gated ──────────────────────────────────
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
});
