// Public + authed read endpoints for the dynamic Devtoberfest schedule pages.
//   GET /api/devtoberfest/schedule?edition=<id>   (anonymous) -> feed
//   GET /api/devtoberfest/my-completions?edition=<id> (authed) -> completions+points
// Reads the cross-container planner facades (external.devtoberfest.*). Fails
// soft (503 / empty) when the facades are unavailable (e.g. unit SQLite).
import cds from '@sap/cds';
import { assembleFeed, completedActivityPoints, normalizeSlugSet, filterCompletionsWithinWindow } from '../lib/devtoberfest-feed.js';
import { resolveUser } from '../lib/resolve-user.js';
import { resolveUserSapId } from '../lib/resolve-db-user.js';
import { getMyCompletedTutorials } from '../lib/user-progress.js';
import { isJoinedCurrentEvent } from '../lib/devtoberfest-registration.js';

const LOG = cds.log('devtoberfest');

async function resolveEditionId(ext, requested) {
  if (requested) return requested;
  try {
    const cur = await SELECT.one.from(ext.Edition).columns('ID').where({ ISCURRENT: true });
    return cur?.ID || null;
  } catch { return null; }
}

async function scheduleHandler(req, res) {
  try {
    await cds.connect.to('db');
    let ext;
    try {
      ext = cds.entities('external.devtoberfest');
    } catch { ext = null; }
    if (!ext?.Session || !ext?.Activity) {
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }

    const editionId = await resolveEditionId(ext, req.query.edition);
    if (!editionId) return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });

    let tracks = [];
    let editions = [];
    let sessions = [];
    let activities = [];
    try {
      editions = await SELECT.from(ext.Edition);
      tracks = await SELECT.from(ext.Track).where({ EDITION_ID: editionId });
      const trackIds = tracks.map((t) => t.ID);
      sessions = trackIds.length
        ? await SELECT.from(ext.Session)
            .columns('ID', 'SESSIONCODE', 'TRACK_ID', 'TITLE', 'ABSTRACT', 'STATUS', 'SESSIONLENGTH', 'WEEK', 'SCHEDULEDSTART', 'SCHEDULEDTIMEZONE', 'YOUTUBEURL', 'COMMUNITYEVENTURL', 'ACTIVITY_ID')
            .where({ TRACK_ID: { in: trackIds } })
        : [];
      activities = trackIds.length
        ? await SELECT.from(ext.Activity)
            .columns('ID', 'TITLE', 'TRACK_ID', 'STATUS', 'WEEK', 'POINTS', 'TASKSLUG', 'TASKTITLE', 'TASKTYPE', 'TASK_ID')
            .where({ TRACK_ID: { in: trackIds } })
        : [];
    } catch (err) {
      LOG.warn('schedule facade read failed, returning empty feed:', err.message);
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }

    return res.status(200).json(assembleFeed({ sessions, activities, tracks, editions, activeEditionId: editionId }));
  } catch (err) {
    LOG.error('GET /api/devtoberfest/schedule failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

async function myCompletionsHandler(req, res) {
  try {
    await cds.connect.to('db');
    const user = resolveUser(req, cds);
    const sapId = resolveUserSapId(user);
    if (!sapId) return res.status(200).json({ authenticated: false, joined: false });

    // Points are earned by joining Devtoberfest AND completing activities
    // *during* the edition window. A user who never joined — or who completed
    // a tutorial before the event — must see 0 earned points. We still return
    // authenticated:true so the banner can show the "Join" CTA rather than the
    // anonymous "Sign in" prompt.
    const joined = await isJoinedCurrentEvent(user);

    let activities = [];
    let editionWindow = { start: null, end: null };
    try {
      const ext = cds.entities('external.devtoberfest');
      if (ext?.Activity && ext?.Track) {
        // Always resolve the edition (same logic as scheduleHandler) so that
        // points are scoped to the same edition as the feed, not all editions.
        const editionId = await resolveEditionId(ext, req.query.edition);
        if (editionId) {
          const edition = await SELECT.one.from(ext.Edition).columns('ID', 'STARTSAT', 'ENDSAT').where({ ID: editionId });
          editionWindow = { start: edition?.STARTSAT || null, end: edition?.ENDSAT || null };
          const tracks = await SELECT.from(ext.Track).where({ EDITION_ID: editionId });
          const trackIds = tracks.map((t) => t.ID);
          activities = trackIds.length
            ? await SELECT.from(ext.Activity).columns('ID', 'POINTS', 'TASKSLUG', 'TRACK_ID', 'STATUS').where({ TRACK_ID: { in: trackIds } })
            : [];
        }
        // If editionId is null, activities stays [] → earnedPoints/maxPoints 0 (fail-soft).
      }
    } catch (e) { LOG.warn('myCompletions facade read failed:', e?.message); }

    // maxPoints (the goal denominator) is the sum of ALL edition activities —
    // independent of join/date state. earnedPoints is gated: only completions
    // inside the edition window count, and only when the user has joined.
    const { maxPoints } = completedActivityPoints(activities, new Set());

    let earnedPoints = 0;
    let completedSlugSet = new Set();
    let completedActivityIds = [];
    if (joined) {
      // Use the canonical helper — it resolves legacyId→slug internally and
      // handles COMPLETED + SUPERSEDED rows for both TUTORIAL and PUZZLE types.
      const rows = await getMyCompletedTutorials(user);
      const windowed = filterCompletionsWithinWindow(rows, editionWindow.start, editionWindow.end);
      completedSlugSet = normalizeSlugSet(windowed);
      ({ earnedPoints, completedActivityIds } = completedActivityPoints(activities, completedSlugSet));
    }

    return res.status(200).json({
      authenticated: true,
      joined,
      completedSlugs: [...completedSlugSet],
      earnedPoints,
      maxPoints,
      completedActivityIds,
    });
  } catch (err) {
    LOG.error('GET /api/devtoberfest/my-completions failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

export function register(app) {
  const _contextMw = cds.middlewares?.context?.() || ((req, _res, next) => next());
  const _authMw = cds.middlewares?.auth?.() || ((req, _res, next) => next());
  app.get('/api/devtoberfest/schedule', _contextMw, _authMw, scheduleHandler);
  app.get('/api/devtoberfest/my-completions', _contextMw, _authMw, myCompletionsHandler);
}

export { scheduleHandler, myCompletionsHandler };
