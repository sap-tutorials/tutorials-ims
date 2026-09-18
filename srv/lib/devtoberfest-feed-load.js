// srv/lib/devtoberfest-feed-load.js
//
// Impure DB companion to the pure `devtoberfest-feed.js` `assembleFeed`. Reads
// the cross-container Devtoberfest planner facades (external.devtoberfest.*) for
// the current (or requested) edition and returns the assembled feed PLUS a
// `speakerEmailById` map — the one thing `assembleFeed`'s speaker DTO drops.
//
// Issue #2354: attaching a speaker's sessions to advocate/author pages needs to
// match on Speaker EMAIL, so this loader adds EMAIL to the Speaker column list
// (the schedule route in srv/routes/devtoberfest-schedule.js deliberately does
// NOT select EMAIL — that route has no need for it, so it stays untouched).
//
// FAIL-OPEN: the planner facades are `@cds.persistence.exists` synonyms, ABSENT
// on unit SQLite. Any missing entity / read fault returns an EMPTY feed
// (`{ sessions: [] }`) and an empty map — never throws — so callers can attach
// empty session arrays without a guard of their own. (Contrast the schedule
// route, which surfaces a 503; here empty is the correct degrade.)

import cds from '@sap/cds';
import { assembleFeed } from './devtoberfest-feed.js';

const LOG = cds.log('devtoberfest');

const EMPTY = Object.freeze({ feed: { sessions: [] }, speakerEmailById: new Map() });

async function resolveEditionId(ext, requested) {
  if (requested) return requested;
  try {
    const cur = await SELECT.one.from(ext.Edition).columns('ID').where({ ISCURRENT: true });
    return cur?.ID || null;
  } catch { return null; }
}

/**
 * Load the assembled Devtoberfest feed + speaker email lookup.
 * @param opts.edition optional edition ID (defaults to the current edition)
 * @returns { feed, speakerEmailById } — feed is the assembleFeed() result,
 *          speakerEmailById is Map<speakerId, email>. Both empty on any absence.
 */
export async function loadDevtoberfestFeedWithEmail(opts = {}) {
  await cds.connect.to('db');
  let ext;
  try {
    ext = cds.entities('external.devtoberfest');
  } catch { ext = null; }
  if (!ext?.Session || !ext?.Track) return EMPTY;

  const editionId = await resolveEditionId(ext, opts.edition);
  if (!editionId) return EMPTY;

  let tracks = [];
  let editions = [];
  let sessions = [];
  let sessionSpeakers = [];
  let speakers = [];
  try {
    editions = await SELECT.from(ext.Edition);
    tracks = await SELECT.from(ext.Track).where({ EDITION_ID: editionId });
    const trackIds = tracks.map((t) => t.ID);
    sessions = trackIds.length
      ? await SELECT.from(ext.Session)
          .columns('ID', 'SESSIONCODE', 'TRACK_ID', 'TITLE', 'STATUS', 'WEEK', 'SCHEDULEDSTART', 'SCHEDULEDTIMEZONE', 'YOUTUBEURL', 'COMMUNITYEVENTURL', 'ACTIVITY_ID')
          .where({ TRACK_ID: { in: trackIds } })
      : [];
    const sessionIds = sessions.map((s) => s.ID);
    if (sessionIds.length && ext.Sessionspeaker && ext.Speaker) {
      sessionSpeakers = await SELECT.from(ext.Sessionspeaker)
        .columns('SESSION_ID', 'SPEAKER_ID', 'SPEAKERORDER')
        .where({ SESSION_ID: { in: sessionIds } });
      const speakerIds = [...new Set(sessionSpeakers.map((l) => l.SPEAKER_ID))];
      // EMAIL added vs the schedule route (issue #2354). EMAIL is String(255),
      // non-LOB — safe alongside metadata (only PHOTO/BIO are LOBs; BIO omitted).
      speakers = speakerIds.length
        ? await SELECT.from(ext.Speaker).columns('ID', 'FIRSTNAME', 'LASTNAME', 'ROLE', 'COMPANY', 'EMAIL').where({ ID: { in: speakerIds } })
        : [];
    }
  } catch (err) {
    LOG.warn('devtoberfest feed read failed, returning empty feed:', err.message);
    return EMPTY;
  }

  const speakerEmailById = new Map(
    speakers.filter((s) => s.EMAIL).map((s) => [s.ID, s.EMAIL]),
  );
  // No activities / cross-links needed for speaker→session matching — assemble a
  // minimal feed (sessions + speakers). Related-session cross-links are omitted.
  const feed = assembleFeed({ sessions, tracks, editions, activeEditionId: editionId, speakers, sessionSpeakers });
  return { feed, speakerEmailById };
}
