// Auth-gated endpoints for the Devtoberfest homepage:
//   POST /api/devtoberfest/join — record this year's registration
//   GET  /api/devtoberfest/me   — return caller's registration state
//
// Both require an authenticated user (XSUAA in production; mock-auth
// in tests). resolveUser() from PR #557 handles the deployed-XSUAA +
// multer async-context gap. resolveUserSapId() (PR #535) bridges to
// the Users.sapId column — never compare req.user.id directly.
//
// Spec: docs/superpowers/specs/2026-06-22-devtoberfest-homepage-design.md §6

import cds from '@sap/cds';
import { resolveUser } from '../lib/resolve-user.js';
import { resolveUserSapId } from '../lib/resolve-db-user.js';

const LOG = cds.log('devtoberfest');

async function meHandler(req, res) {
  try {
    const user = resolveUser(req, cds);
    if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED' });
    const sapId = resolveUserSapId(user);
    if (!sapId) return res.status(401).json({ error: 'UNAUTHENTICATED' });

    await cds.connect.to('db');
    const { Users, DevtoberfestConfig, EventRegistrations } =
      cds.entities('com.sap.developers.ims');

    const config = await SELECT.one.from(DevtoberfestConfig);
    if (!config?.currentEvent_ID) {
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }

    const dbUser = await SELECT.one.from(Users).columns('ID').where({ sapId });
    if (!dbUser) {
      return res.status(200).json({ joined: false });
    }

    const reg = await SELECT.one.from(EventRegistrations)
      .columns('joinedAt', 'termsVersion')
      .where({
        user_ID: dbUser.ID,
        event_ID: config.currentEvent_ID,
      });
    if (!reg) return res.status(200).json({ joined: false });

    return res.status(200).json({
      joined: true,
      joinedAt: reg.joinedAt,
      termsVersion: reg.termsVersion,
    });
  } catch (err) {
    LOG.error('GET /api/devtoberfest/me failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

export function register(app) {
  // context+auth middlewares are REQUIRED — without them req.user / cds.context.user
  // never gets populated and resolveUser would always return null (false 401s).
  // Same idiom as srv/server.js:272-277 (analytics export) and devtoberfest-public.js.
  const _contextMw = cds.middlewares?.context?.() || ((req, _res, next) => next());
  const _authMw    = cds.middlewares?.auth?.()    || ((req, _res, next) => next());
  app.get('/api/devtoberfest/me', _contextMw, _authMw, meHandler);
  // /api/devtoberfest/join wired in Task 7.
}

export { meHandler };
