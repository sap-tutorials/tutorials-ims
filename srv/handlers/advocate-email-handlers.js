// srv/handlers/advocate-email-handlers.js
//
// Handlers for the emailEdit virtual field on AdminService.Advocates.
//
// Reads:   hydrate emailEdit from the linked user's Users.email so the
//          OP shows the current value in display + edit mode.
// Writes:  validate the proposed email, locate the target user (from the
//          current request's user_ID or the active row's user_ID), UPDATE
//          Users.email, then delete req.data.emailEdit so the runtime
//          doesn't try to persist a virtual column.
//
// Draft + virtual semantics:
//   The CAP runtime strips virtual elements from `req.data` before the
//   service-layer handlers fire (the OData input parser sees `virtual`
//   and treats the element as read-only on the persistence side). The
//   raw body, available on `req._.req.body`, still carries the field —
//   we read from there.
//
//   We propagate on PATCH-on-drafts. The alternative (defer to SAVE)
//   doesn't work because the draftActivate POST body is empty `{}` and
//   the active-row UPDATE that follows doesn't carry the virtual either.
//   The acceptable trade-off: if the admin types a new email then
//   discards the draft, the email change still landed on Users.email.
//   We accept that: users are a logically separate resource from the
//   advocate draft, and email is a simple scalar (no rollback complexity).
//
// We also hook `before('UPDATE', Advocates)` for completeness — that
// path fires only if `cds.fiori.direct_crud:true` is enabled (CAP Dec25
// beta). With draft enforcement, direct PATCH on the active row 501s
// before the handler ever sees the request.
//
// Spec: docs/superpowers/specs/2026-06-25-advocate-email-edit-design.md §4.3

import { validateEmail } from '../lib/email-validation.js';

/**
 * Batch-hydrate emailEdit on a result set. Used by both the after-READ
 * handler and the after-UPDATE re-hydrate path.
 *
 * Looks up user_ID on the row first. FE V4 typically $selects user_ID
 * on the OP context read, but a focused $select=emailEdit alone may not
 * include it — in that case we lookup the advocate's user_ID by ID from
 * whichever table (active or drafts) the read fired against.
 */
async function hydrateEmailEdit(rows, srvEntities, fromTable) {
  const arr = Array.isArray(rows) ? rows : [rows];
  if (arr.length === 0) return;

  const { Users, Advocates } = srvEntities;
  const fromAdvocates = fromTable || Advocates;

  // Rows where FE V4 already $selected user_ID can skip the lookup.
  const idsNeedingUserLookup = arr
    .filter((r) => r && !r.user_ID && r.ID)
    .map((r) => r.ID);

  let userIdByAdvId;
  if (idsNeedingUserLookup.length > 0) {
    const advs = await SELECT.from(fromAdvocates)
      .columns('ID', 'user_ID')
      .where({ ID: { in: idsNeedingUserLookup } });
    userIdByAdvId = new Map(advs.map((a) => [a.ID, a.user_ID]));
  }

  const allUserIds = new Set();
  for (const row of arr) {
    if (!row) continue;
    const uid = row.user_ID || userIdByAdvId?.get(row.ID);
    if (uid) allUserIds.add(uid);
  }
  if (allUserIds.size === 0) return;

  const users = await SELECT.from(Users)
    .columns('ID', 'email')
    .where({ ID: { in: [...allUserIds] } });
  const emailByUserId = new Map(users.map((u) => [u.ID, u.email]));

  for (const row of arr) {
    if (!row) continue;
    const uid = row.user_ID || userIdByAdvId?.get(row.ID);
    if (uid) {
      row.emailEdit = emailByUserId.get(uid) ?? null;
    }
  }
}

/**
 * Pull the incoming emailEdit out of the request. CAP's behavior depends
 * on the entry path:
 *   - OData HTTP PATCH on a virtual element: CAP strips emailEdit from
 *     req.data (virtuals aren't persistable). Field is only in the raw
 *     HTTP body (req._.req.body).
 *   - Programmatic srv.run(UPDATE(...).set({emailEdit: ...})): emailEdit
 *     IS present in req.data because the programmatic builder doesn't
 *     run the OData input parser that strips virtuals.
 *
 * We try req.data first (cheap, official API, works for programmatic
 * callers including hybrid tests), then fall back to the raw body (the
 * OData path). Returns undefined when neither carries the field so we
 * can skip propagation on unrelated UPDATEs.
 *
 * Null returns through (intentional — would map to a future "clear email"
 * UX; out of scope here, validator rejects with EMAIL_REQUIRED).
 */
function readEmailEditFromBody(req) {
  if (req.data && Object.prototype.hasOwnProperty.call(req.data, 'emailEdit')) {
    return req.data.emailEdit;
  }
  // TODO(CAP): replace req._.req.body reach with the supported API once
  // CAP exposes "read raw body for virtual fields" (not in the docs as of
  // CAP 9.9.1). The req._ namespace is a convention, not a contract.
  const body = req._?.req?.body;
  if (!body || typeof body !== 'object') return undefined;
  if (!Object.prototype.hasOwnProperty.call(body, 'emailEdit')) return undefined;
  return body.emailEdit;
}

/**
 * Propagate handler. Validates the incoming emailEdit, resolves the
 * target user_ID, writes to Users.email. Reused by before-PATCH on
 * drafts and before-UPDATE on the active entity.
 */
async function propagateEmailEdit(req, srvEntities) {
  const incoming = readEmailEditFromBody(req);
  if (incoming === undefined) return;

  const result = validateEmail(incoming);
  if (!result.ok) {
    return req.reject(400, result.code, `emailEdit: ${result.code}`);
  }

  // Resolve target user_ID. Priority: explicit value in this payload, else
  // the row's user_ID (read from DB). For draft PATCH, params[0].ID is
  // the draft's ID which equals the active's ID for an EDIT'd draft.
  // For NEW drafts (no active row yet) and freshly created advocates the
  // user_ID may live in the incoming body — we read from there as a fallback.
  // The `req.params?.[0]?.ID || req.params?.[0]` defensive form is needed
  // for the CAP 10 `consistent_params` flag flip — see CLAUDE.md note.
  const { Advocates, Users } = srvEntities;
  const body = req._?.req?.body || {};
  let targetUserId = body.user_ID || req.data?.user_ID;
  if (!targetUserId) {
    const advId = req.params?.[0]?.ID || req.params?.[0];
    if (!advId) {
      return req.reject(400, 'EMAIL_PROPAGATE_NO_KEY', 'emailEdit: cannot resolve advocate key');
    }
    // Read user_ID from whichever projection the event fired against
    // (draft for PATCH on .drafts, active for UPDATE on the entity).
    // Identity-compare against the captured Advocates reference so a future
    // rename of AdminService can't silently mis-route this lookup.
    const target = req.target === Advocates
      ? Advocates
      : (Advocates.drafts || Advocates);
    const adv = await SELECT.one.from(target).columns('user_ID').where({ ID: advId });
    targetUserId = adv?.user_ID || null;
  }

  if (!targetUserId) {
    return req.reject(
      400,
      'EMAIL_REQUIRES_LINKED_USER',
      'emailEdit: link a user before setting the email',
    );
  }

  // Confirm the user exists. Defensive — FK should catch first.
  const linkedUser = await SELECT.one.from(Users).columns('ID').where({ ID: targetUserId });
  if (!linkedUser) {
    return req.reject(500, 'LINKED_USER_NOT_FOUND', 'emailEdit: linked user no longer exists');
  }

  try {
    await UPDATE(Users).where({ ID: targetUserId }).set({ email: result.value });
  } catch (err) {
    return req.reject(500, 'USER_UPDATE_FAILED', `emailEdit: ${err.message}`);
  }
}

/**
 * Wire the email handlers onto the AdminService instance.
 */
export function register(srv) {
  const { Advocates, Users } = srv.entities;
  const srvEntities = { Advocates, Users };

  // Hydrate on READ of the active entity.
  srv.after('READ', Advocates, async (rows) => {
    if (!rows) return;
    await hydrateEmailEdit(rows, srvEntities, Advocates);
  });

  // Hydrate on READ of the draft companion too. Fiori OP opens drafts via
  // `Advocates(...,IsActiveEntity=false)` which fires the .drafts event,
  // NOT the active entity event. Without this hook the OP shows '-' in
  // both display + edit because emailEdit stays null on draft load.
  // Diagnosed 2026-06-25 via Playwright network capture (PR #648).
  if (Advocates.drafts) {
    srv.after('READ', Advocates.drafts, async (rows) => {
      if (!rows) return;
      await hydrateEmailEdit(rows, srvEntities, Advocates.drafts);
    });
  }

  // Direct UPDATE path (cds.fiori.direct_crud:true beta, off in this
  // service). Kept for defense-in-depth so a future flip can't silently
  // break propagation.
  srv.before('UPDATE', Advocates, (req) => propagateEmailEdit(req, srvEntities));

  srv.after('UPDATE', Advocates, async (result) => {
    if (!result) return;
    await hydrateEmailEdit(result, srvEntities, Advocates);
  });

  // Fiori draft PATCH path — the ONLY path admins actually exercise
  // through the OP today. Propagates on each PATCH (validation + write
  // to Users.email) so the draft layer doesn't carry the virtual through
  // SAVE (where it would be lost — see file-header note).
  if (Advocates.drafts) {
    srv.before('UPDATE', Advocates.drafts, (req) => propagateEmailEdit(req, srvEntities));
    // Re-hydrate the draft response after PATCH so FE V4 sees the updated value.
    srv.after('UPDATE', Advocates.drafts, async (result) => {
      if (!result) return;
      await hydrateEmailEdit(result, srvEntities, Advocates.drafts);
    });
  }
}
