// srv/lib/teched/seed-core.js
//
// Idempotent upsert orchestration for the TechEd RainFocus ingest
// (issue #2312, Unit F). ESM. Imported by scripts/seed-teched.cjs (via dynamic
// import) and directly by the vitest seed test.
//
// Upsert discipline (mirrors scripts/seed-channels.cjs):
//   - manual SELECT-then-UPDATE-or-INSERT keyed on sourceId (NOT CQL UPSERT)
//   - skip when contentHash is unchanged (unless force)
//   - UPDATE patches SOURCE-owned columns only; lifecycle/curated columns
//     (pinUntil, lastExtractedHash, firstSeenAt) are NEVER overwritten
//   - slug assigned once, reused verbatim on re-ingest
import cds from '@sap/cds';
import { normalizeSession, normalizeSpeaker, normalizeTrack } from './normalize.js';

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

const TRACK_COLS = ['name', 'venue', 'description'];
const SPEAKER_COLS = ['name', 'title', 'company', 'bio', 'photoUrl'];
// Session source columns EXCLUDING the resolved track_ID (handled separately)
// and the transport-only trackSourceId/speakerSourceIds carriers.
const SESSION_COLS = ['venue', 'sessionCode', 'title', 'abstract', 'scheduledStart', 'scheduledEnd', 'room', 'youtubeUrl', 'url'];

function pick(row, keys) {
  const out = {};
  for (const k of keys) out[k] = row[k];
  return out;
}

async function upsertSimple({ db, entity, rawList, normalizeFn, cols, commit, force, nowTs, metadataOnly }) {
  const existing = await db.run(SELECT.from(entity).columns('ID', 'sourceId', 'slug', 'contentHash'));
  const bySource = new Map(existing.map((r) => [r.sourceId, r]));
  const seenSlugs = new Set(existing.map((r) => r.slug).filter(Boolean));
  const idBySource = new Map();
  let inserted = 0, updated = 0, skipped = 0;

  for (const raw of rawList) {
    const prior = bySource.get(String(raw.sourceId));
    const row = normalizeFn(raw, seenSlugs, prior?.slug);
    if (prior) {
      idBySource.set(row.sourceId, prior.ID);
      // metadataOnly (refresh job): always patch metadata, never gate on / write
      // contentHash — that column is owned by the weekly extraction job.
      if (!metadataOnly && prior.contentHash === row.contentHash && !force) { skipped++; continue; }
      const patch = { ...pick(row, cols), slug: row.slug, lastSeenAt: nowTs };
      if (!metadataOnly) patch.contentHash = row.contentHash;
      if (commit) await db.run(UPDATE(entity).set(patch).where({ ID: prior.ID }));
      updated++;
    } else {
      const ID = cds.utils.uuid();
      idBySource.set(row.sourceId, ID);
      const entry = { ID, sourceId: row.sourceId, slug: row.slug, lastSeenAt: nowTs, ...pick(row, cols) };
      if (!metadataOnly) entry.contentHash = row.contentHash;
      if (commit) await db.run(INSERT.into(entity).entries(entry));
      inserted++;
    }
  }
  return { inserted, updated, skipped, idBySource };
}

/**
 * Run the full TechEd upsert against a connected `db`.
 *
 * @param {object} args
 * @param {object} args.db        connected cds db service
 * @param {object} args.entities  { TechEdSessions, TechEdSpeakers, TechEdTracks, TechEdSessionSpeakers }
 * @param {object} args.data      { sessions, speakers, tracks } — fetcher output shape
 * @param {boolean} [args.commit=false]  dry-run unless true
 * @param {boolean} [args.force=false]   bypass the contentHash skip
 * @param {boolean} [args.metadataOnly=false] refresh mode: always upsert
 *   source-owned metadata + lastSeenAt, but NEVER read/write contentHash
 *   (owned by the weekly extraction job). Used by refresh-teched-sessions-job.
 * @param {Date}   [args.now]
 */
export async function runSeed({ db, entities, data, commit = false, force = false, metadataOnly = false, now = new Date() }) {
  const { TechEdSessions, TechEdSpeakers, TechEdTracks, TechEdSessionSpeakers } = entities;
  const nowTs = now instanceof Date ? now.toISOString() : now;
  const tracks = Array.isArray(data.tracks) ? data.tracks : [];
  const speakers = Array.isArray(data.speakers) ? data.speakers : [];
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];

  // 1) tracks + 2) speakers — independent, no FKs
  const trackRes = await upsertSimple({ db, entity: TechEdTracks, rawList: tracks, normalizeFn: normalizeTrack, cols: TRACK_COLS, commit, force, nowTs, metadataOnly });
  const speakerRes = await upsertSimple({ db, entity: TechEdSpeakers, rawList: speakers, normalizeFn: normalizeSpeaker, cols: SPEAKER_COLS, commit, force, nowTs, metadataOnly });

  // 3) sessions — resolve track_ID via the track map
  const existing = await db.run(SELECT.from(TechEdSessions).columns('ID', 'sourceId', 'slug', 'contentHash'));
  const bySource = new Map(existing.map((r) => [r.sourceId, r]));
  const seenSlugs = new Set(existing.map((r) => r.slug).filter(Boolean));
  const sessionIdBySource = new Map();
  let inserted = 0, updated = 0, skipped = 0;

  for (const raw of sessions) {
    const prior = bySource.get(String(raw.sourceId));
    const row = normalizeSession(raw, seenSlugs, prior?.slug);
    const trackId = row.trackSourceId ? trackRes.idBySource.get(String(row.trackSourceId)) ?? null : null;
    if (prior) {
      sessionIdBySource.set(row.sourceId, prior.ID);
      if (!metadataOnly && prior.contentHash === row.contentHash && !force) { skipped++; continue; }
      const patch = { ...pick(row, SESSION_COLS), track_ID: trackId, slug: row.slug, lastSeenAt: nowTs };
      if (!metadataOnly) patch.contentHash = row.contentHash;
      if (commit) await db.run(UPDATE(TechEdSessions).set(patch).where({ ID: prior.ID }));
      updated++;
    } else {
      const ID = cds.utils.uuid();
      sessionIdBySource.set(row.sourceId, ID);
      const entry = { ID, sourceId: row.sourceId, slug: row.slug, lastSeenAt: nowTs, track_ID: trackId, ...pick(row, SESSION_COLS) };
      if (!metadataOnly) entry.contentHash = row.contentHash;
      if (commit) await db.run(INSERT.into(TechEdSessions).entries(entry));
      inserted++;
    }
  }
  const sessionRes = { inserted, updated, skipped, idBySource: sessionIdBySource };

  // 4) junction reconciliation — for every session IN THIS BATCH, add missing
  // (session, speaker) links AND prune stale ones (a speaker dropped upstream
  // must not linger). Sessions not in the batch are left untouched.
  let linksInserted = 0, linksRemoved = 0;
  const existingLinks = await db.run(SELECT.from(TechEdSessionSpeakers).columns('ID', 'session_ID', 'speaker_ID'));
  const linkKey = (s, sp) => `${s}::${sp}`;
  const haveLinks = new Set(existingLinks.map((l) => linkKey(l.session_ID, l.speaker_ID)));
  const linkRowsBySession = new Map();
  for (const l of existingLinks) {
    if (!linkRowsBySession.has(l.session_ID)) linkRowsBySession.set(l.session_ID, []);
    linkRowsBySession.get(l.session_ID).push(l);
  }
  for (const raw of sessions) {
    const sessionId = sessionRes.idBySource.get(String(raw.sourceId));
    if (!sessionId) continue;
    const desired = new Set();
    for (const spSource of raw.speakerSourceIds ?? []) {
      const speakerId = speakerRes.idBySource.get(String(spSource));
      if (!speakerId) continue; // speaker not in this batch — skip the dangling link
      desired.add(speakerId);
      if (haveLinks.has(linkKey(sessionId, speakerId))) continue;
      if (commit) await db.run(INSERT.into(TechEdSessionSpeakers).entries({ ID: cds.utils.uuid(), session_ID: sessionId, speaker_ID: speakerId }));
      haveLinks.add(linkKey(sessionId, speakerId));
      linksInserted++;
    }
    // prune links for this session whose speaker is no longer desired
    for (const l of linkRowsBySession.get(sessionId) ?? []) {
      if (desired.has(l.speaker_ID)) continue;
      if (commit) await db.run(DELETE.from(TechEdSessionSpeakers).where({ ID: l.ID }));
      linksRemoved++;
    }
  }

  return {
    commit,
    tracks: { inserted: trackRes.inserted, updated: trackRes.updated, skipped: trackRes.skipped },
    speakers: { inserted: speakerRes.inserted, updated: speakerRes.updated, skipped: speakerRes.skipped },
    sessions: { inserted: sessionRes.inserted, updated: sessionRes.updated, skipped: sessionRes.skipped },
    links: { inserted: linksInserted, removed: linksRemoved },
  };
}

export default { runSeed };
