// Public read endpoints for the TechEd session calendar (mirrors the Devtoberfest
// single-session .ics + feed .ics endpoints in devtoberfest-schedule.js):
//   GET /api/teched/session/:file        (anonymous) -> one-session .ics
//   GET /api/teched/session/:file?to=google|outlook   -> 302 add-to-calendar
//   GET /api/teched/feed.ics             (anonymous) -> whole-catalog .ics
// Reads the /build/teched feed (loadTechEdFeed). The session identity is `slug`
// (there is no numeric id in the feed). Anonymous + edge-cacheable, matching the
// dtf feeds. Fails soft (500) when the feed can't be loaded.
import cds from '@sap/cds';
import { loadTechEdFeed } from '../lib/teched-feed.js';
import { buildICS, buildEventICS, addToCalendarLinks } from '../lib/teched-ical.js';

const LOG = cds.log('teched');

async function loadFeed() {
  const db = await cds.connect.to('db');
  return loadTechEdFeed(db);
}

// Single-session .ics. The :file param carries a trailing ".ics" we strip to
// recover the session slug. Unknown/unscheduled sessions 404 (never leak).
async function sessionIcalHandler(req, res) {
  try {
    const feed = await loadFeed();
    const slug = String(req.params.file || '').replace(/\.ics$/i, '');
    const session = (feed.sessions || []).find((s) => s.slug === slug);
    if (!session) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });

    // ?to=google|outlook → 302 to the provider "add event" page. Targets are
    // built server-side from the session, never from client input (no open
    // redirect surface).
    const to = String(req.query.to || '').toLowerCase();
    if (to === 'google' || to === 'outlook') {
      const target = addToCalendarLinks(session)[to];
      if (!target) return res.status(404).json({ error: 'SESSION_NOT_SCHEDULED' });
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.redirect(302, target);
    }

    const ics = buildEventICS(session);
    if (!ics) return res.status(404).json({ error: 'SESSION_NOT_SCHEDULED' });
    const safe = (session.sessionCode || session.slug).replace(/[^A-Za-z0-9_-]/g, '');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="teched-${safe}.ics"`);
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(ics);
  } catch (err) {
    LOG.error('GET /api/teched/session/:file failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

async function feedIcalHandler(_req, res) {
  try {
    const feed = await loadFeed();
    const ics = buildICS(feed);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="teched.ics"');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(ics);
  } catch (err) {
    LOG.error('GET /api/teched/feed.ics failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

export function register(app) {
  const _contextMw = cds.middlewares?.context?.() || ((req, _res, next) => next());
  app.get('/api/teched/feed.ics', _contextMw, feedIcalHandler);
  app.get('/api/teched/session/:file', _contextMw, sessionIcalHandler);
}

export { sessionIcalHandler, feedIcalHandler };
