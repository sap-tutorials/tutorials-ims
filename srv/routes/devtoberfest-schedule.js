// Public + authed read endpoints for the dynamic Devtoberfest schedule pages.
//   GET /api/devtoberfest/schedule?edition=<id>   (anonymous) -> feed
//   GET /api/devtoberfest/my-completions?edition=<id> (authed) -> completions+points
//   GET /api/devtoberfest/transcript?video=<id>   (anonymous) -> cached segments
// Reads the cross-container planner facades (external.devtoberfest.*). Fails
// soft (503 / empty) when the facades are unavailable (e.g. unit SQLite).
import cds from '@sap/cds';
import { assembleFeed, completedActivityPoints, normalizeSlugSet, filterCompletionsWithinWindow } from '../lib/devtoberfest-feed.js';
import { resolveUser } from '../lib/resolve-user.js';
import { resolveUserSapId } from '../lib/resolve-db-user.js';
import { getMyCompletedTutorials } from '../lib/user-progress.js';
import { fetchTranscript } from '../lib/devtoberfest-transcript.js';
import { gzipSync, gunzipSync } from 'node:zlib';
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
    let sessionSpeakers = [];
    let speakers = [];
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
      const sessionIds = sessions.map((s) => s.ID);
      if (sessionIds.length && ext.Sessionspeaker && ext.Speaker) {
        sessionSpeakers = await SELECT.from(ext.Sessionspeaker)
          .columns('SESSION_ID', 'SPEAKER_ID', 'SPEAKERORDER')
          .where({ SESSION_ID: { in: sessionIds } });
        const speakerIds = [...new Set(sessionSpeakers.map((l) => l.SPEAKER_ID))];
        speakers = speakerIds.length
          ? await SELECT.from(ext.Speaker).columns('ID', 'FIRSTNAME', 'LASTNAME', 'ROLE', 'COMPANY').where({ ID: { in: speakerIds } })
          : [];
      }
    } catch (err) {
      LOG.warn('schedule facade read failed, returning empty feed:', err.message);
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }

    // Admin-editable schedule feed (sessions/activities/tracks). Must not be
    // cached at the CDN edge, or admin edits stay invisible until the edge's
    // heuristic TTL lapses.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(assembleFeed({ sessions, activities, tracks, editions, activeEditionId: editionId, speakers, sessionSpeakers }));
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
    // Per-user response — never shared-cacheable at the CDN edge.
    res.setHeader('Cache-Control', 'no-store');
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

    // maxPoints (the goal denominator) is the sum of the edition's visible
    // (Confirmed/Completed) activities — completedActivityPoints filters hidden
    // statuses via isVisibleStatus, matching the feed. Independent of join/date
    // state. earnedPoints is gated: only completions inside the edition window
    // count, and only when the user has joined.
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

const TRANSCRIPT_TTL_MS = 1000 * 60 * 60 * 24 * 7;   // 7d for real transcripts
const TRANSCRIPT_NONE_TTL_MS = 1000 * 60 * 60;        // 1h for negative cache

// Physical table name for the owned Transcript entity.
// com.sap.developers.ims.Transcript → dots/camel → COM_SAP_DEVELOPERS_IMS_TRANSCRIPT
// (same derivation pattern as COM_SAP_DEVELOPERS_IMS_USERS, _TUTORIALS, etc.)
// Raw SQL is required for BLOB reads to avoid HANA LOB-locator expiry when
// mixing LargeBinary with metadata columns in one CDS QL SELECT.
const TRANSCRIPT_TABLE = '"COM_SAP_DEVELOPERS_IMS_TRANSCRIPT"';

async function transcriptHandler(req, res) {
  const videoId = String(req.query.video || '').trim();
  if (!videoId) return res.status(400).json({ error: 'MISSING_VIDEO' });
  try {
    await cds.connect.to('db');
    // Part of the /api/devtoberfest/* JSON set served no-store. The origin
    // keeps its own 7d/1h transcript cache (below), so bypassing the CDN edge
    // costs nothing but keeps this consistent with the rest of the set.
    res.setHeader('Cache-Control', 'no-store');
    const { Transcript } = cds.entities('com.sap.developers.ims');
    const now = Date.now();
    // Metadata-only SELECT — no segments column — to avoid HANA LOB-locator expiry.
    // Mirror of speakerPhotoHandler: metadata via CDS QL, BLOB via raw db.run().
    const cached = await SELECT.one.from(Transcript)
      .columns('videoId', 'source', 'lang', 'fetchedAt')
      .where({ videoId });
    if (cached) {
      const age = now - new Date(cached.fetchedAt).getTime();
      const ttl = cached.source === 'none' ? TRANSCRIPT_NONE_TTL_MS : TRANSCRIPT_TTL_MS;
      if (age < ttl) {
        if (cached.source === 'none') {
          return res.status(200).json({ videoId, source: 'none', lang: cached.lang, segments: [] });
        }
        // BLOB isolated via raw SQL — LOB-locator-safe on HANA.
        const db = cds.db;
        const rows = await db.run(
          `SELECT "SEGMENTS" FROM ${TRANSCRIPT_TABLE} WHERE "VIDEOID" = ?`, [videoId]
        );
        const row = Array.isArray(rows) ? rows[0] : rows;
        const buf = row && (row.SEGMENTS || row.segments);
        const segments = buf
          ? JSON.parse(gunzipSync(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('utf8'))
          : [];
        return res.status(200).json({ videoId, source: cached.source, lang: cached.lang, segments });
      }
    }
    const fresh = await fetchTranscript(videoId);
    // gzipSync returns a Buffer; on HANA the CDS UPSERT binding may need
    // base64 — flag for Task 15 hybrid run if needed.
    const blob = fresh.source === 'none' ? null : gzipSync(Buffer.from(JSON.stringify(fresh.segments), 'utf8'));
    await UPSERT.into(Transcript).entries({ videoId, source: fresh.source, lang: fresh.lang, segments: blob, fetchedAt: new Date().toISOString() });
    return res.status(200).json({ videoId, source: fresh.source, lang: fresh.lang, segments: fresh.segments });
  } catch (err) {
    LOG.error('GET /api/devtoberfest/transcript failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

// Physical synonym name for the cross-container Speaker facade.
// @cds.persistence.exists entities are named by the HDI synonym: EXTERNAL_DEVTOBERFEST_SPEAKER.
// Raw SQL is required to avoid HANA LOB locator expiry when reading a BLOB alongside metadata.
const SPEAKER_TABLE = '"EXTERNAL_DEVTOBERFEST_SPEAKER"';

async function speakerPhotoHandler(req, res) {
  try {
    await cds.connect.to('db');
    let ext;
    try { ext = cds.entities('external.devtoberfest'); } catch { ext = null; }
    if (!ext?.Speaker) return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    const db = cds.db;
    // Raw SQL: never SELECT a HANA BLOB alongside metadata via CDS QL (LOB locator expires).
    let rows;
    try {
      rows = await db.run(
        `SELECT PHOTO, PHOTOTYPE FROM ${SPEAKER_TABLE} WHERE ID = ?`,
        [req.params.id]
      );
    } catch (sqlErr) {
      // Facade synonym absent (e.g. unit SQLite env where @cds.persistence.exists
      // tables are not created). Treat as not-configured, same as scheduleHandler.
      LOG.warn('speaker photo facade unavailable:', sqlErr.message);
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }
    const row = Array.isArray(rows) ? rows[0] : rows;
    const buf = row && (row.PHOTO || row.photo);
    if (!buf) return res.status(404).end();
    res.setHeader('Content-Type', (row.PHOTOTYPE || row.phototype) || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).end(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  } catch (err) {
    LOG.error('GET /api/devtoberfest/speaker/:id/photo failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}

export function register(app) {
  const _contextMw = cds.middlewares?.context?.() || ((req, _res, next) => next());
  const _authMw = cds.middlewares?.auth?.() || ((req, _res, next) => next());
  app.get('/api/devtoberfest/schedule', _contextMw, _authMw, scheduleHandler);
  app.get('/api/devtoberfest/my-completions', _contextMw, _authMw, myCompletionsHandler);
  app.get('/api/devtoberfest/speaker/:id/photo', _contextMw, speakerPhotoHandler);
  app.get('/api/devtoberfest/transcript', _contextMw, transcriptHandler);
}

export { scheduleHandler, myCompletionsHandler, speakerPhotoHandler, transcriptHandler };
