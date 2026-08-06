// Public read endpoints for the Devtoberfest homepage island.
// Mounted at /api/devtoberfest/{status,terms}. NO auth — anonymous
// users see the page and the JOIN button (which is gated separately
// by /api/devtoberfest/join requiring XSUAA).
//
// DevtoberfestConfig is multi-row + draft-enabled (spec 2026-06-24).
// Public handlers select WHERE isActive=true. If no row is active,
// statusHandler returns 503 EVENT_NOT_CONFIGURED. The admin tile
// at /admin-ui/#/devtoberfest is responsible for keeping exactly
// one row active.
//
// Spec: docs/superpowers/specs/2026-06-24-devtoberfest-config-multi-row-draft-design.md
// (supersedes singleton sections of 2026-06-22-devtoberfest-homepage-design.md §6)

import cds from '@sap/cds';
import { resolveUser } from '../lib/resolve-user.js';
import { resolveUserSapId } from '../lib/resolve-db-user.js';
import { fetchBanner } from '../lib/devtoberfest-banner-store.js';

const LOG = cds.log('devtoberfest');

async function statusHandler(req, res) {
  try {
    await cds.connect.to('db');
    const { DevtoberfestConfig, Events } = cds.entities('com.sap.developers.ims');

    const config = await SELECT.one.from(DevtoberfestConfig).where({ isActive: true });
    if (!config?.currentEvent_ID) {
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }

    const event = await SELECT.one.from(Events).where({ ID: config.currentEvent_ID });

    // Response carries per-user join state (joined/termsRequired) AND
    // admin-editable config. Must never be shared-cached at the CDN edge:
    // a cached copy would leak one user's join state to all anonymous
    // callers and serve stale rules/URLs after an admin edit.
    res.setHeader('Cache-Control', 'no-store');

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
      bannerUrl: config.hasBanner ? '/api/devtoberfest/banner' : '',
    });
  } catch (err) {
    LOG.error('GET /api/devtoberfest/status failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

async function termsHandler(_req, res) {
  try {
    await cds.connect.to('db');
    const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
    const config = await SELECT.one.from(DevtoberfestConfig).where({ isActive: true });
    if (!config) {
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }
    // Admin-editable content — must not be cached at the CDN edge, or edits
    // stay invisible until the edge's heuristic TTL lapses.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      text: config.termsText || '',
      version: config.termsVersion || 1,
    });
  } catch (err) {
    LOG.error('GET /api/devtoberfest/terms failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

async function faqHandler(_req, res) {
  try {
    await cds.connect.to('db');
    const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
    const config = await SELECT.one.from(DevtoberfestConfig).where({ isActive: true });
    if (!config) {
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }
    // Admin-editable content — see termsHandler.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ text: config.faqText || '' });
  } catch (err) {
    LOG.error('GET /api/devtoberfest/faq failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

async function bannerHandler(req, res) {
  try {
    await cds.connect.to('db');
    const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
    const config = await SELECT.one.from(DevtoberfestConfig).columns('ID', 'hasBanner').where({ isActive: true });
    if (!config?.hasBanner) return res.status(404).end();

    const out = await fetchBanner(config.ID);
    if (!out) return res.status(404).end();

    res.setHeader('ETag', out.etag);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (req.headers['if-none-match'] === out.etag) return res.status(304).end();
    res.setHeader('Content-Type', out.mimeType);
    return res.send(out.buffer);
  } catch (err) {
    LOG.error('GET /api/devtoberfest/banner failed:', err);
    return res.status(500).end();
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
  app.get('/api/devtoberfest/terms',  _contextMw, _authMw, termsHandler);
  app.get('/api/devtoberfest/faq',    _contextMw, _authMw, faqHandler);
  app.get('/api/devtoberfest/banner', bannerHandler);
}

export { statusHandler, termsHandler, faqHandler, bannerHandler };
