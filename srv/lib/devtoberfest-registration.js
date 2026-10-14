// Shared join-state lookup for Devtoberfest. A user "joined" when they have an
// EventRegistrations row for the currently-active event (DevtoberfestConfig
// with isActive=true → currentEvent_ID). This mirrors the inline queries in
// routes/devtoberfest-auth.js (meHandler) and routes/devtoberfest-public.js
// (statusHandler); keep the three in step if the join contract changes.
//
// Returns false (never throws) for anonymous, unconfigured event, unknown user,
// or no registration — points/CTA callers treat "unknown" as "not joined".

import cds from '@sap/cds';
import { resolveUser } from './resolve-db-user.js';

/**
 * @param {object} user — cds.context.user / req.user
 * @returns {Promise<boolean>} true iff the user has joined the active event.
 *
 * Resolves the Users row via the TIERED resolver `resolveUser` — the same path
 * the join WRITE uses (joinHandler → provisionDbUser → resolveUser). It matches
 * on the durable identity: Tier-1 (issuer,subject) UserIdentities link, then
 * Tier-2 canonical sapId, then Tier-3 trusted email. This is required because a
 * human on one universal SAP ID presents a token user_uuid (the XSUAA sapId
 * claim) that is NOT the stored Users.sapId — so a bare `where({ sapId })`
 * lookup (which is what resolveDbUser falls back to when unpinned) returns null
 * and the read path reports "not joined" even though the join row exists under
 * the (iss,sub)-linked canonical row. That mismatch produced the "shows Join,
 * but Join returns 409 ALREADY_JOINED" paradox: the write path resolved the
 * user via resolveUser (found the row → 409) while the read path used the
 * sapId-only fallback (missed → "not joined"). Keeping read and write on the
 * same resolver is the fix.
 */
export async function isJoinedCurrentEvent(user) {
  if (!user || !user.id || user.id === 'anonymous') return false;
  const { DevtoberfestConfig, EventRegistrations } =
    cds.entities('com.sap.developers.ims');

  const config = await SELECT.one.from(DevtoberfestConfig)
    .columns('currentEvent_ID')
    .where({ isActive: true });
  if (!config?.currentEvent_ID) return false;

  const dbUser = await resolveUser(user);
  if (!dbUser) return false;

  const reg = await SELECT.one.from(EventRegistrations)
    .columns('ID')
    .where({ user_ID: dbUser.ID, event_ID: config.currentEvent_ID });
  return Boolean(reg);
}
