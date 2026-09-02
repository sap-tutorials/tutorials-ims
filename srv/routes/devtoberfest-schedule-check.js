// srv/routes/devtoberfest-schedule-check.js
//
// Admin-only schedule-consistency check (issue #2103):
//   GET /api/devtoberfest/schedule-check?edition=<id>
//
// Reconciles each planner session's SCHEDULEDSTART against the *actual*
// scheduled start times on its external assets — the YouTube livestream and the
// community.sap.com event — and reports any that have drifted apart. See
// srv/lib/devtoberfest-schedule-check.js for the comparison logic and why Zoom
// is not checked.
//
// Admin-gated (user.is('Admin')); this surfaces operator-facing data (URLs,
// drift) and calls out to external APIs, so it is not public. Fails soft: an
// external time we cannot read is reported 'unknown', never a spurious mismatch.
import cds from '@sap/cds';
import { resolveUser } from '../lib/resolve-user.js';
import { resolveSecret } from '../lib/secret-resolver.js';
import { buildScheduleCheckReport } from '../lib/devtoberfest-schedule-check.js';

const LOG = cds.log('devtoberfest');

async function resolveEditionId(ext, requested) {
  if (requested) return requested;
  try {
    const cur = await SELECT.one.from(ext.Edition).columns('ID').where({ ISCURRENT: true });
    return cur?.ID || null;
  } catch { return null; }
}

async function scheduleCheckHandler(req, res) {
  try {
    await cds.connect.to('db');

    // Admin gate — mirror alerts-public.js / server.js admin express routes.
    const user = resolveUser(req, cds) || cds.context?.user;
    if (!user?.id || user.id === 'anonymous') {
      return res.status(401).json({ error: 'UNAUTHENTICATED' });
    }
    if (!(typeof user.is === 'function' && user.is('Admin') === true)) {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }

    let ext;
    try { ext = cds.entities('external.devtoberfest'); } catch { ext = null; }
    if (!ext?.Session) return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });

    const editionId = await resolveEditionId(ext, req.query.edition);
    if (!editionId) return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });

    // Sessions belong to tracks, tracks to editions. Same join the schedule
    // feed uses (devtoberfest-schedule.js), but we only need the URL columns.
    let sessions = [];
    try {
      const tracks = await SELECT.from(ext.Track).columns('ID').where({ EDITION_ID: editionId });
      const trackIds = tracks.map((t) => t.ID);
      sessions = trackIds.length
        ? await SELECT.from(ext.Session)
            .columns('ID', 'SESSIONCODE', 'TITLE', 'SCHEDULEDSTART', 'SCHEDULEDTIMEZONE', 'YOUTUBEURL', 'COMMUNITYEVENTURL')
            .where({ TRACK_ID: { in: trackIds } })
        : [];
    } catch (err) {
      LOG.warn('schedule-check facade read failed:', err.message);
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }

    // YOUTUBE_API_KEY is optional: without it the YouTube leg reports 'unknown'
    // for every session (fail-soft) rather than erroring the whole report.
    let apiKey = null;
    try { apiKey = await resolveSecret('YOUTUBE_API_KEY', { logTag: '[schedule-check]' }); }
    catch (e) { LOG.warn('YOUTUBE_API_KEY unavailable, YouTube leg will be unknown:', e?.message); }

    const tolQ = Number.parseInt(req.query.tolerance, 10);
    const toleranceMinutes = Number.isFinite(tolQ) && tolQ >= 0 ? tolQ : undefined;

    const report = await buildScheduleCheckReport(sessions, { apiKey, toleranceMinutes });

    // Operator report against live external state — never cache at the edge.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ editionId, ...report });
  } catch (err) {
    LOG.error('GET /api/devtoberfest/schedule-check failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

export function register(app) {
  const _contextMw = cds.middlewares?.context?.() || ((req, _res, next) => next());
  const _authMw = cds.middlewares?.auth?.() || ((req, _res, next) => next());
  app.get('/api/devtoberfest/schedule-check', _contextMw, _authMw, scheduleCheckHandler);
}

export { scheduleCheckHandler };
