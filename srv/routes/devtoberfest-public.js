// Public read endpoints for the Devtoberfest homepage island.
// Mounted at /api/devtoberfest/{status,terms}. NO auth — anonymous
// users see the page and the JOIN button (which is gated separately
// by /api/devtoberfest/join requiring XSUAA).
//
// Spec: docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md §6

import cds from '@sap/cds';
import { ensureDevtoberfestConfigSingleton } from '../lib/devtoberfest-singleton.js';
import { resolveUser } from '../lib/resolve-user.js';
import { resolveUserSapId } from '../lib/resolve-db-user.js';

const LOG = cds.log('devtoberfest');

async function statusHandler(req, res) {
  try {
    await cds.connect.to('db');
    await ensureDevtoberfestConfigSingleton();
    const { DevtoberfestConfig, Events } = cds.entities('com.sap.developers.ims');

    const config = await SELECT.one.from(DevtoberfestConfig);
    if (!config?.currentEvent_ID) {
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }

    const event = await SELECT.one.from(Events).where({ ID: config.currentEvent_ID });

    const user = resolveUser(req, cds);
    let joined = false;
    if (user) {
      const sapId = resolveUserSapId(user);
      if (sapId) {
        const { Users, EventRegistrations } = cds.entities('com.sap.developers.ims');
        const dbUser = await SELECT.one.from(Users).columns('ID').where({ sapId });
        if (dbUser) {
          const reg = await SELECT.one.from(EventRegistrations).columns('ID').where({
            user_ID: dbUser.ID,
            event_ID: config.currentEvent_ID,
          });
          joined = Boolean(reg);
        }
      }
    }

    return res.status(200).json({
      event: event ? { name: event.name, startDate: event.startDate, endDate: event.endDate } : null,
      joined,
      termsVersion: config.termsVersion,
      termsRequired: !joined,
      contentRulesUrl: config.contentRulesUrl || '',
      faqUrl: config.faqUrl || '',
      gameboardUrl: config.gameboardUrl || '',
      activitiesUrl: config.activitiesUrl || '',
    });
  } catch (err) {
    LOG.error('GET /api/devtoberfest/status failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

export function register(app) {
  // context+auth middlewares populate cds.context.user / req.user when
  // a Bearer (XSUAA) or Basic credential is presented. The route stays
  // anonymous-friendly — resolveUser returns null for unauthenticated
  // callers, and the handler keeps joined=false in that case. Same
  // pattern as the analytics export bridge (server.js).
  const _contextMw = cds.middlewares?.context?.() || ((req, _res, next) => next());
  const _authMw    = cds.middlewares?.auth?.()    || ((req, _res, next) => next());
  app.get('/api/devtoberfest/status', _contextMw, _authMw, statusHandler);
  // /api/devtoberfest/terms wired in Task 5.
}

export { statusHandler };
