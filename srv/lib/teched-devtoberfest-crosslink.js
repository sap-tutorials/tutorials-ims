// srv/lib/teched-devtoberfest-crosslink.js
//
// Bidirectional related-session cross-linking between Devtoberfest sessions and
// SAP TechEd sessions, based on shared Knowledge-Graph concepts (issue #2312,
// Unit 9). A Devtoberfest session links to a tutorial via its Activity
// (Activity.TASKSLUG); that tutorial has TutorialConceptLinks → Concepts. A
// TechEd session has TechEdSessionConceptLinks → the SAME Concepts registry.
// Two sessions are "related" when their concept sets overlap; ranked by overlap
// count, capped at the top MAX_RELATED_SESSIONS.
//
// GATING & FAIL-OPEN CONTRACT (mirrors the KG feature-flag convention):
//   - The whole feature is behind the DB feature flag
//     TECHED_DEVTOBERFEST_CROSSLINK_ENABLED (ImsConfig flag.teched.devtoberfestCrosslink,
//     default OFF, dev-only). When OFF the orchestrators return an EMPTY map so
//     callers attach empty related arrays.
//   - Devtoberfest planner entities are @cds.persistence.exists cross-container
//     facades — ABSENT on unit SQLite. Concept-link tables may also be empty.
//     Every DB read is wrapped so a missing facade / cold KG degrades to empty
//     arrays and NEVER throws into feed assembly or the /build/teched handler.
//
// The pure ranking helpers (buildRelated*) take pre-fetched, normalized inputs
// and are trivially unit-testable with no cds/db access.

import cds from '@sap/cds';
import { isFlagEnabled } from './feature-flags/db-flags.js';
import { isVisibleStatus } from './devtoberfest-feed.js';

const LOG = cds.log('teched-crosslink');

const KG_NS = 'com.sap.developers.ims';
const EXT_NS = 'com.sap.developers.ims.external';
const DTF_NS = 'external.devtoberfest';

const FLAG = 'TECHED_DEVTOBERFEST_CROSSLINK_ENABLED';

// Top-N related sessions attached per session (both directions).
export const MAX_RELATED_SESSIONS = 3;

function toSet(x) {
  return x instanceof Set ? x : new Set(x || []);
}

// Count of concept IDs present in BOTH sets (iterate the smaller set).
function overlapCount(a, b) {
  const A = toSet(a);
  const B = toSet(b);
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  let n = 0;
  for (const v of small) if (large.has(v)) n++;
  return n;
}

// Deterministic ordering: highest overlap first, stable tiebreak on a string key.
function byOverlapThen(keyFn) {
  return (a, b) =>
    (b.sharedConceptCount - a.sharedConceptCount) ||
    String(keyFn(a)).localeCompare(String(keyFn(b)));
}

/**
 * Forward direction (Devtoberfest → TechEd). PURE.
 *
 * @param {Map<string, Set<string>>} tutorialConceptsBySlug lowercased tutorial slug → concept-id set
 * @param {Array<{slug,title,sessionCode,venue,url,conceptIds}>} techEdSessions
 * @returns {Map<string, Array>} lowercased tutorial slug → top related TechEd sessions
 */
export function buildRelatedTechEdBySlug(tutorialConceptsBySlug, techEdSessions) {
  const out = new Map();
  if (!(tutorialConceptsBySlug instanceof Map) || tutorialConceptsBySlug.size === 0) return out;
  if (!Array.isArray(techEdSessions) || techEdSessions.length === 0) return out;
  for (const [slug, concepts] of tutorialConceptsBySlug) {
    const cset = toSet(concepts);
    if (!cset.size) continue;
    const scored = [];
    for (const te of techEdSessions) {
      const n = overlapCount(cset, te.conceptIds);
      if (n > 0) {
        scored.push({
          slug: te.slug,
          title: te.title,
          sessionCode: te.sessionCode || '',
          venue: te.venue || '',
          url: te.url || '',
          sharedConceptCount: n,
        });
      }
    }
    if (scored.length) {
      scored.sort(byOverlapThen((x) => x.slug));
      out.set(slug, scored.slice(0, MAX_RELATED_SESSIONS));
    }
  }
  return out;
}

/**
 * Reverse direction (TechEd → Devtoberfest). PURE.
 *
 * @param {Array<{slug,conceptIds}>} techEdSessions
 * @param {Array<{id,title,sessionCode,taskSlug,conceptIds}>} dtfSessions
 * @returns {Map<string, Array>} TechEd slug → top related Devtoberfest sessions
 */
export function buildRelatedDevtoberfestByTechEd(techEdSessions, dtfSessions) {
  const out = new Map();
  if (!Array.isArray(techEdSessions) || techEdSessions.length === 0) return out;
  if (!Array.isArray(dtfSessions) || dtfSessions.length === 0) return out;
  for (const te of techEdSessions) {
    const cset = toSet(te.conceptIds);
    if (!cset.size) continue;
    const scored = [];
    for (const d of dtfSessions) {
      const n = overlapCount(cset, d.conceptIds);
      if (n > 0) {
        scored.push({
          sessionId: d.id,
          title: d.title,
          sessionCode: d.sessionCode || '',
          taskSlug: d.taskSlug || '',
          sharedConceptCount: n,
        });
      }
    }
    if (scored.length) {
      scored.sort(byOverlapThen((x) => x.sessionId));
      out.set(te.slug, scored.slice(0, MAX_RELATED_SESSIONS));
    }
  }
  return out;
}

// ── impure loaders (guarded by the orchestrators' try/catch) ────────────────

// Short in-process cache for the TechEd sessions-with-concepts map. The feature
// is read on every schedule/iCal/RSS request and every /build/teched build; the
// underlying TechEd catalog only changes on the twice-weekly ingest, so a 60s
// TTL (matching the feature-flag cache cadence) collapses the repeated
// full-table scans a naive per-request load would incur. Process-global so all
// ESM instances share it (same rationale as the feature-flag cache).
const TECHED_TTL_MS = 60 * 1000;
const TECHED_CACHE = (globalThis.__techEdCrosslinkCache__ ??= { at: 0, rows: null, inflight: null });

// All owned TechEd sessions with their concept-id sets. Metadata-only columns
// (no LargeString `abstract`), so plain CDS QL is LOB-safe on HANA.
async function loadTechEdSessionsWithConceptsUncached() {
  const { TechEdSessions, TechEdSessionConceptLinks } = cds.entities(EXT_NS);
  const sessions = await SELECT.from(TechEdSessions)
    .columns('ID', 'slug', 'title', 'sessionCode', 'venue', 'url');
  if (!sessions.length) return [];
  const links = await SELECT.from(TechEdSessionConceptLinks).columns('session_ID', 'concept_ID');
  const bySession = new Map();
  for (const l of links) {
    if (!l.concept_ID) continue;
    if (!bySession.has(l.session_ID)) bySession.set(l.session_ID, new Set());
    bySession.get(l.session_ID).add(l.concept_ID);
  }
  return sessions.map((s) => ({
    ID: s.ID,
    slug: s.slug,
    title: s.title,
    sessionCode: s.sessionCode,
    venue: s.venue,
    url: s.url,
    conceptIds: bySession.get(s.ID) || new Set(),
  }));
}

async function loadTechEdSessionsWithConcepts() {
  const now = Date.now();
  if (TECHED_CACHE.rows && now - TECHED_CACHE.at < TECHED_TTL_MS) return TECHED_CACHE.rows;
  if (TECHED_CACHE.inflight) return TECHED_CACHE.inflight;
  const work = (async () => {
    try {
      const rows = await loadTechEdSessionsWithConceptsUncached();
      TECHED_CACHE.rows = rows;
      TECHED_CACHE.at = Date.now();
      return rows;
    } finally {
      if (TECHED_CACHE.inflight === work) TECHED_CACHE.inflight = null;
    }
  })();
  TECHED_CACHE.inflight = work;
  return work;
}

// Test-only: drop the TechEd cache so a seeded row set is picked up immediately.
export function __bustTechEdCacheForTest() {
  TECHED_CACHE.at = 0;
  TECHED_CACHE.rows = null;
  TECHED_CACHE.inflight = null;
}

// lowercased tutorial slug → concept-id set (predicate 'teaches'), restricted to
// the requested slug set. Tutorial slugs are lowercase-canonical (CLAUDE.md).
async function loadTutorialConceptsBySlug(slugsLower) {
  const set = slugsLower instanceof Set ? slugsLower : new Set(slugsLower || []);
  if (!set.size) return new Map();
  const { TutorialConceptLinks, Tutorials } = cds.entities(KG_NS);
  const tuts = await SELECT.from(Tutorials).columns('ID', 'slug').where({ slug: { in: [...set] } });
  if (!tuts.length) return new Map();
  const idToSlug = new Map();
  for (const t of tuts) {
    if (t.slug) idToSlug.set(t.ID, String(t.slug).toLowerCase());
  }
  const tutIds = [...idToSlug.keys()];
  const links = await SELECT.from(TutorialConceptLinks)
    .columns('tutorial_ID', 'concept_ID')
    .where({ tutorial_ID: { in: tutIds }, predicate: 'teaches' });
  const map = new Map();
  for (const l of links) {
    if (!l.concept_ID) continue;
    const slug = idToSlug.get(l.tutorial_ID);
    if (!slug) continue;
    if (!map.has(slug)) map.set(slug, new Set());
    map.get(slug).add(l.concept_ID);
  }
  return map;
}

// Visible Devtoberfest sessions carrying the concept set of the tutorial they
// link to (via Activity.TASKSLUG). Reads the cross-container planner facades,
// which are absent on unit SQLite — the caller's try/catch turns that into an
// empty result (fail-soft). Scoped to the CURRENT edition (ISCURRENT) so the
// reverse cross-links stay symmetric with the edition-scoped forward feed and
// never surface sessions from a past Devtoberfest year. Only sessions with a
// non-empty concept set are returned.
async function loadDevtoberfestSessionsWithConcepts() {
  let ext;
  try { ext = cds.entities(DTF_NS); } catch { ext = null; }
  if (!ext?.Session || !ext?.Activity || !ext?.Track || !ext?.Edition) return [];

  const currentEdition = await SELECT.one.from(ext.Edition).columns('ID').where({ ISCURRENT: true });
  if (!currentEdition?.ID) return [];
  const tracks = await SELECT.from(ext.Track).columns('ID').where({ EDITION_ID: currentEdition.ID });
  const trackIds = tracks.map((t) => t.ID);
  if (!trackIds.length) return [];

  const sessions = await SELECT.from(ext.Session)
    .columns('ID', 'TITLE', 'SESSIONCODE', 'STATUS', 'ACTIVITY_ID')
    .where({ TRACK_ID: { in: trackIds } });
  const visible = sessions.filter(isVisibleStatus);
  if (!visible.length) return [];
  const activityIds = [...new Set(visible.map((s) => s.ACTIVITY_ID).filter(Boolean))];
  const activities = activityIds.length
    ? await SELECT.from(ext.Activity).columns('ID', 'TASKSLUG').where({ ID: { in: activityIds } })
    : [];
  const slugByActivity = new Map(
    activities.map((a) => [a.ID, (a.TASKSLUG || '').toLowerCase()]),
  );
  const taskSlugs = new Set([...slugByActivity.values()].filter(Boolean));
  const tutMap = await loadTutorialConceptsBySlug(taskSlugs);
  const out = [];
  for (const s of visible) {
    const taskSlug = s.ACTIVITY_ID ? slugByActivity.get(s.ACTIVITY_ID) : '';
    const conceptIds = (taskSlug && tutMap.get(taskSlug)) || new Set();
    if (conceptIds.size) {
      out.push({ id: s.ID, title: s.TITLE, sessionCode: s.SESSIONCODE, taskSlug, conceptIds });
    }
  }
  return out;
}

// ── orchestrators (flag-gated, fail-open) ───────────────────────────────────

/**
 * Forward: lowercased tutorial slug → top related TechEd sessions. Empty map
 * when the flag is OFF, inputs are empty, or any read fails. Never throws.
 *
 * @param {Set<string>|string[]} taskSlugsLower Devtoberfest activity task slugs (lowercased)
 * @returns {Promise<Map<string, Array>>}
 */
export async function computeRelatedTechEdBySlug(taskSlugsLower) {
  try {
    if (!isFlagEnabled(FLAG)) return new Map();
    const slugs = taskSlugsLower instanceof Set ? taskSlugsLower : new Set(taskSlugsLower || []);
    if (!slugs.size) return new Map();
    await cds.connect.to('db');
    const [techEd, tutMap] = await Promise.all([
      loadTechEdSessionsWithConcepts(),
      loadTutorialConceptsBySlug(slugs),
    ]);
    if (!techEd.length || tutMap.size === 0) return new Map();
    return buildRelatedTechEdBySlug(tutMap, techEd);
  } catch (err) {
    LOG.warn('computeRelatedTechEdBySlug failed; returning empty:', err?.message);
    return new Map();
  }
}

/**
 * Reverse: TechEd slug → top related Devtoberfest sessions. Empty map when the
 * flag is OFF, the planner facades are absent (unit SQLite), or any read fails.
 * Never throws.
 *
 * @returns {Promise<Map<string, Array>>}
 */
export async function computeRelatedDevtoberfestByTechEd() {
  try {
    if (!isFlagEnabled(FLAG)) return new Map();
    await cds.connect.to('db');
    const techEd = await loadTechEdSessionsWithConcepts();
    if (!techEd.length) return new Map();
    const dtf = await loadDevtoberfestSessionsWithConcepts();
    if (!dtf.length) return new Map();
    return buildRelatedDevtoberfestByTechEd(techEd, dtf);
  } catch (err) {
    LOG.warn('computeRelatedDevtoberfestByTechEd failed; returning empty:', err?.message);
    return new Map();
  }
}
