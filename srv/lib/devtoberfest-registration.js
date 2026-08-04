// Shared join-state lookup for Devtoberfest. A user "joined" when they have an
// EventRegistrations row for the currently-active event (DevtoberfestConfig
// with isActive=true → currentEvent_ID). This mirrors the inline queries in
// routes/devtoberfest-auth.js (meHandler) and routes/devtoberfest-public.js
// (statusHandler); keep the three in step if the join contract changes.
//
// Returns false (never throws) for anonymous, unconfigured event, unknown user,
// or no registration — points/CTA callers treat "unknown" as "not joined".

import cds from '@sap/cds';
import { resolveUserSapId } from './resolve-db-user.js';

/**
 * @param {object} user — cds.context.user / req.user
 * @returns {Promise<boolean>} true iff the user has joined the active event.
 */
export async function isJoinedCurrentEvent(user) {
  const sapId = resolveUserSapId(user);
  if (!sapId) return false;
  const { Users, DevtoberfestConfig, EventRegistrations } =
    cds.entities('com.sap.developers.ims');

  const config = await SELECT.one.from(DevtoberfestConfig)
    .columns('currentEvent_ID')
    .where({ isActive: true });
  if (!config?.currentEvent_ID) return false;

  const dbUser = await SELECT.one.from(Users).columns('ID').where({ sapId });
  if (!dbUser) return false;

  const reg = await SELECT.one.from(EventRegistrations)
    .columns('ID')
    .where({ user_ID: dbUser.ID, event_ID: config.currentEvent_ID });
  return Boolean(reg);
}
