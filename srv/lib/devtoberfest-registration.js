// Shared join-state lookup for Devtoberfest. A user "joined" when they have an
// EventRegistrations row for the currently-active event (DevtoberfestConfig
// with isActive=true → currentEvent_ID). This mirrors the inline queries in
// routes/devtoberfest-auth.js (meHandler) and routes/devtoberfest-public.js
// (statusHandler); keep the three in step if the join contract changes.
//
// Returns false (never throws) for anonymous, unconfigured event, unknown user,
// or no registration — points/CTA callers treat "unknown" as "not joined".

import cds from '@sap/cds';
import { resolveDbUser } from './resolve-db-user.js';

/**
 * @param {object} user — cds.context.user / req.user
 * @returns {Promise<boolean>} true iff the user has joined the active event.
 *
 * Resolves the Users row via resolveDbUser (NOT a bare `where({ sapId })`): it
 * honours the before('*') identity pin (attr.dbUserId), so a human with
 * multiple logins / sapIds under one SAP ID (e.g. P-user + S-user) resolves to
 * the single canonical row that holds their records — the same row /me uses.
 * A sapId-only lookup lands on whichever row matches the current login's
 * user_uuid, which — after an account merge leaves a stale secondary row — can
 * be an empty husk, silently zeroing the user's Devtoberfest points (#2651).
 */
export async function isJoinedCurrentEvent(user) {
  const { DevtoberfestConfig, EventRegistrations } =
    cds.entities('com.sap.developers.ims');

  const config = await SELECT.one.from(DevtoberfestConfig)
    .columns('currentEvent_ID')
    .where({ isActive: true });
  if (!config?.currentEvent_ID) return false;

  const dbUser = await resolveDbUser(user, ['ID']);
  if (!dbUser) return false;

  const reg = await SELECT.one.from(EventRegistrations)
    .columns('ID')
    .where({ user_ID: dbUser.ID, event_ID: config.currentEvent_ID });
  return Boolean(reg);
}
