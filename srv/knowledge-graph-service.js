// srv/knowledge-graph-service.js
// KnowledgeGraphService handlers — PR 5 of issue #381.
//
// Phase 1 surface scope:
//   - function neighborhood(slug)     — flagship; uses rankNeighborhood below
//   - function pathBetween(...)       — Phase 2 stub (returns [])
//   - function conceptsForUser(...)   — Phase 2 stub (returns {learned:[],partial:[]})
//   - action runSparql(query)         — admin raw SPARQL passthrough
//   - action mergeConcepts/vetoConcept/vetoEdge/triggerGraphRebuild
//
// THIS DISPATCH (Tasks 5.1 + 5.2): only the pure ranker is in this file.
// The CDS-backed `cds.service` body, ORD annotations, and HTTP handlers land
// in the next dispatch (Task 5.3). Keeping the ranker pure-function-testable
// without loading CDS lets it ship under Task 5.2 alone.

// ---------------------------------------------------------------------------
// rankNeighborhood — pure function over the SPARQL response
// ---------------------------------------------------------------------------

const GROUP_KEYS = Object.freeze([
  'teaches',
  'prerequisitesOf',
  'sharedConcepts',
  'whatToLearnNext',
]);

const TOP_N = 10;

// Default weight assigned to items whose UNION branch did not bind ?weight
// (sharedConcepts and whatToLearnNext). The handler/UI uses this for
// proportional rendering of progress chips, etc. Picked midway between
// teaches (1.0) and "no signal" so it sorts below prerequisitesOf (0.9).
const DEFAULT_WEIGHT = 0.5;

const REASON_BY_TYPE = Object.freeze({
  teaches:         'taught by this tutorial',
  prerequisitesOf: 'teaches a prerequisite concept',
  sharedConcepts:  'shares concepts with this tutorial',
  whatToLearnNext: 'next step — builds on what this tutorial teaches',
});

/**
 * Co-completion boost. We use 1 + log10(score + 1) so the boost grows
 * sub-linearly: score=0 → 1.0, score=9 → 2.0, score=99 → 3.0. This
 * prevents one mega-popular tutorial dominating the rail while still
 * nudging genuinely-correlated next steps to the top.
 */
function coCompletionBoost(score) {
  const s = Number(score) || 0;
  if (s <= 0) return 1.0;
  return 1 + Math.log10(s + 1);
}

// ============================================================
// PageRank blend (#916).
//
// Multiplicative blend on top of the arm's existing weight:
//   weight *= (1 + α × normalize(tutorialRank[slug]))
// where normalize maps the raw PageRank into [0, 1] via min-max scaling.
// α defaults to 1.0 → weights grow at most 2× (bounded, safe).
//
// Fail-open on every path:
//   - flag off               → EMPTY_RANK_MAPS, multiplier collapses to 1.0
//   - rankMaps.tutorialRank.get(slug) undefined → 0 → multiplier 1.0
//   - degenerate (max == min) → normalize returns 0 → multiplier 1.0
//   - loadRankMaps() throws  → EMPTY_RANK_MAPS returned by caller
//
// Applies uniformly to all three tutorial-targeted arms (prerequisitesOf,
// sharedConcepts, whatToLearnNext). The `teaches` arm ranks concepts —
// when conceptRank is populated it re-sorts by concept PageRank instead
// of pure lex order.
// ============================================================

const PAGERANK_ALPHA = Number(process.env.KG_PAGERANK_ALPHA) || 1.0;

const _EMPTY_MAP = new Map();
const EMPTY_RANK_MAPS = Object.freeze({
  conceptRank: _EMPTY_MAP,
  tutorialRank: _EMPTY_MAP,
  _normalizeTut: () => 0,
});

/**
 * Rank-maps shape recognizer for the backwards-compat shim on
 * rankNeighborhood's 5th positional arg. Recognizes both live-loaded
 * maps (from loadRankMaps in this file) and the frozen EMPTY_RANK_MAPS.
 * Anything else that lacks the shape falls through to being treated
 * as maxResults (a number) or ignored.
 */
function isRankMapsLike(x) {
  return (
    x &&
    typeof x === 'object' &&
    x.conceptRank instanceof Map &&
    x.tutorialRank instanceof Map &&
    typeof x._normalizeTut === 'function'
  );
}

/**
 * Determine whether `candidateTeaches` is a non-trivial subset of
 * `inputTeaches` — i.e. every concept the candidate teaches is also taught
 * by the input AND the candidate teaches at least one concept. Used to
 * push candidates with zero new learning value to the bottom of
 * `sharedConcepts`. Empty teaches-set is not flagged (we don't know).
 */
function isFullySubset(inputTeaches, candidateTeaches) {
  if (!inputTeaches || !candidateTeaches) return false;
  if (candidateTeaches.size === 0) return false;
  for (const c of candidateTeaches) {
    if (!inputTeaches.has(c)) return false;
  }
  return true;
}

/**
 * Pure-function neighborhood ranker.
 *
 * @param {Array<{type:string, targetSlug:string, targetLabel?:string, weight?:number}>} rows
 *   Output of the SPARQL NEIGHBORHOOD_QUERY, one row per (type, target). The
 *   four UNION branches bind different vars; unbound vars arrive as undefined
 *   or null.
 * @param {string} slug — the input tutorial slug. Used as a defense-in-depth
 *   self-filter; SPARQL FILTER already excludes self-rows.
 * @param {Map<string, number>} [coCompletionMap] — slug → co-completion score.
 *   Boosts whatToLearnNext ranking. When undefined or empty, no boost.
 * @param {Map<string, Set<string>>} [tutorialTeachesMap] — slug → set of
 *   concept-slugs the tutorial teaches. When provided, sharedConcepts items
 *   whose teaches-set is fully a subset of `slug`'s teaches-set are pushed
 *   to the bottom (no learning value). Skipped when undefined.
 * @param {object|number} [rankMapsOrMaxResults] — polymorphic 5th arg:
 *   - When shaped like `{conceptRank, tutorialRank, _normalizeTut}` (from
 *     loadRankMaps below), used to blend PageRank into all four arm weights
 *     (#916). Requires KG_PAGERANK_ENABLED to be gated at the caller.
 *   - When a number, treated as the maxResults cap (backwards-compat with
 *     the pre-#916 signature `rankNeighborhood(rows, slug, coMap,
 *     teachesMap, maxResults)`).
 *   - Anything else is ignored (fail-open — no blend, defaults to TOP_N).
 * @param {number} [maxResults] — per-section cap. Defaults to TOP_N (10)
 *   for the sidebar path; the /graph/neighborhoodFull handler passes 30
 *   for the expanded panel. Also accepts the cap via the 5th positional
 *   arg when the 5th arg is numeric (see above).
 * @returns {{teaches:Array, prerequisitesOf:Array, sharedConcepts:Array, whatToLearnNext:Array}}
 *   - teaches items:           { slug, name }
 *   - tutorial-targeted items: { slug, weight, reason }
 *     (`title` is left undefined; the handler enriches via Tutorials.title)
 */
export function rankNeighborhood(
  rows,
  slug,
  coCompletionMap,
  tutorialTeachesMap,
  rankMapsOrMaxResults,
  maxResults,
) {
  const coMap = coCompletionMap instanceof Map ? coCompletionMap : new Map();

  // Backwards-compat shim: 5th positional arg polymorphism (#916).
  // Callers pre-dating the PageRank blend pass maxResults here. New callers
  // (in this file's own handlers post-#916) pass rankMaps and use the 6th
  // arg for maxResults. Anything unrecognized fails-open to EMPTY.
  let rankMaps = EMPTY_RANK_MAPS;
  let capArg = maxResults;
  if (isRankMapsLike(rankMapsOrMaxResults)) {
    rankMaps = rankMapsOrMaxResults;
  } else if (typeof rankMapsOrMaxResults === 'number' && Number.isFinite(rankMapsOrMaxResults)) {
    capArg = rankMapsOrMaxResults;
  }
  const capN =
    typeof capArg === 'number' && Number.isFinite(capArg) && capArg > 0
      ? Math.floor(capArg)
      : TOP_N;

  // Bucket by type, deduped by (type, targetSlug). Skip rows with unknown
  // type or missing slug. Defense-in-depth self-filter.
  const buckets = {
    teaches:         new Map(),
    prerequisitesOf: new Map(),
    sharedConcepts:  new Map(),
    whatToLearnNext: new Map(),
  };

  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    const type = row.type;
    if (!Object.prototype.hasOwnProperty.call(buckets, type)) continue;
    const targetSlug = row.targetSlug;
    if (typeof targetSlug !== 'string' || targetSlug.length === 0) continue;
    if (targetSlug === slug) continue;
    if (buckets[type].has(targetSlug)) continue;
    buckets[type].set(targetSlug, row);
  }

  // teaches: { slug, name } — concepts only.
  const teaches = [];
  for (const [targetSlug, row] of buckets.teaches) {
    teaches.push({ slug: targetSlug, name: row.targetLabel || targetSlug });
  }
  // When conceptRank is populated (#916 flag on and job has run), sort by
  // PageRank desc with lex as tiebreaker. Otherwise stable lex order.
  // teaches has no other ranking signal (there's no ?weight from SPARQL
  // on this arm), so PageRank is the only tie-breaker we get.
  if (rankMaps.conceptRank.size > 0) {
    teaches.sort((a, b) => {
      const sa = rankMaps.conceptRank.get(a.slug) ?? 0;
      const sb = rankMaps.conceptRank.get(b.slug) ?? 0;
      if (sa !== sb) return sb - sa;
      return a.slug.localeCompare(b.slug);
    });
  } else {
    teaches.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  // PageRank blend for tutorial-targeted items (all three arms below).
  // Fail-open: unknown slug → 0 → multiplier 1.0.
  //   weight *= (1 + α × normalize(tutorialRank[slug]))
  function blendTutRank(item) {
    const s = rankMaps.tutorialRank.get(item.slug);
    if (typeof s !== 'number' || !Number.isFinite(s)) return;
    const norm = rankMaps._normalizeTut(s);
    if (!Number.isFinite(norm) || norm <= 0) return;
    item.weight = item.weight * (1 + PAGERANK_ALPHA * norm);
  }

  // Helper: build a tutorial-targeted item.
  function makeTutItem(type, targetSlug, row) {
    const w = typeof row.weight === 'number' && Number.isFinite(row.weight)
      ? row.weight
      : DEFAULT_WEIGHT;
    return {
      slug: targetSlug,
      weight: w,
      reason: REASON_BY_TYPE[type],
    };
  }

  // prerequisitesOf — already weight-bound by SPARQL (0.9). PageRank blend
  // lifts globally-central tutorials above equal-weighted peers, then sort
  // by (final weight desc, slug asc).
  const prerequisitesOf = [];
  for (const [targetSlug, row] of buckets.prerequisitesOf) {
    prerequisitesOf.push(makeTutItem('prerequisitesOf', targetSlug, row));
  }
  for (const item of prerequisitesOf) blendTutRank(item);
  prerequisitesOf.sort((a, b) => (b.weight - a.weight) || a.slug.localeCompare(b.slug));

  // sharedConcepts — apply subset suppression if tutorialTeachesMap given.
  // Items with no learning value are pushed to the bottom by halving their
  // weight (still sorted). Otherwise plain lex.
  const inputTeaches = tutorialTeachesMap instanceof Map
    ? tutorialTeachesMap.get(slug)
    : null;

  const sharedConcepts = [];
  for (const [targetSlug, row] of buckets.sharedConcepts) {
    const item = makeTutItem('sharedConcepts', targetSlug, row);
    if (inputTeaches) {
      const candTeaches = tutorialTeachesMap.get(targetSlug);
      if (isFullySubset(inputTeaches, candTeaches)) {
        item.weight = item.weight * 0.1; // de-prioritise but keep visible
      }
    }
    sharedConcepts.push(item);
  }
  for (const item of sharedConcepts) blendTutRank(item);
  sharedConcepts.sort((a, b) => (b.weight - a.weight) || a.slug.localeCompare(b.slug));

  // whatToLearnNext — boost by coCompletion AND blend PageRank. The two
  // signals compose multiplicatively: co-completion (behavioral) × PageRank
  // (structural). A tutorial that's both cohort-linked to the input and
  // globally central rises fastest.
  const whatToLearnNext = [];
  for (const [targetSlug, row] of buckets.whatToLearnNext) {
    const base = makeTutItem('whatToLearnNext', targetSlug, row);
    const boost = coCompletionBoost(coMap.get(targetSlug));
    base.weight = base.weight * boost;
    whatToLearnNext.push(base);
  }
  for (const item of whatToLearnNext) blendTutRank(item);
  whatToLearnNext.sort((a, b) => (b.weight - a.weight) || a.slug.localeCompare(b.slug));

  // Cap each group at capN (defaults to TOP_N; /graph/neighborhoodFull
  // passes 30 for the expanded panel — Task 5 of #850).
  return {
    teaches:         teaches.slice(0, capN),
    prerequisitesOf: prerequisitesOf.slice(0, capN),
    sharedConcepts:  sharedConcepts.slice(0, capN),
    whatToLearnNext: whatToLearnNext.slice(0, capN),
  };
}

// Re-exported for the (next-dispatch) handler to consume without re-deriving.
export const _internals = { GROUP_KEYS, TOP_N, DEFAULT_WEIGHT, coCompletionBoost, isFullySubset };

// ============================================================
// rewriteIsPublishedFilter — #1080
//
// Walks a CQN `where` array in place and rewrites any comparison of the
// virtual `isPublished` column into a `publishedAt IS (NOT) NULL` check.
// The virtual has no SQL column backing it, so the default push-down
// would emit `WHERE "isPublished" = TRUE` and HANA would reject the
// query with "column not found."
//
// CQN grammar recap: a `where` array is a flat list of tokens interleaved
// with `'and' | 'or' | 'not'` connectives. Comparison triples appear as
//   [{ ref: [...] }, 'eq' | 'ne' | '=' | '!=', { val: ... }]
// Nested groups appear as `{ xpr: [...] }` — recurse into those too so
// FE-composed filters like `(status eq 'ACTIVE' and isPublished eq false)`
// are covered.
//
// Only literal booleans are rewritten. Anything else (e.g. `isPublished
// eq null`) is left alone — the DB error surface will be a clear
// column-not-found rather than a silent semantic swap.
//
// Exported so unit tests can assert against the transformed CQN without
// standing up a full CAP server.
// ============================================================
export function rewriteIsPublishedFilter(where) {
  if (!Array.isArray(where)) return;
  for (let i = 0; i < where.length; i++) {
    const node = where[i];
    // Recurse into nested groups: `{ xpr: [...] }`
    if (node && Array.isArray(node.xpr)) {
      rewriteIsPublishedFilter(node.xpr);
      continue;
    }
    // Triple detection: token at i is `{ ref: ['isPublished'] }` and
    // the next two form the operator + value.
    if (
      node && Array.isArray(node.ref) && node.ref.length === 1 &&
      node.ref[0] === 'isPublished'
    ) {
      const op = where[i + 1];
      const rhs = where[i + 2];
      if (
        (op === 'eq' || op === '=' || op === 'ne' || op === '!=') &&
        rhs && typeof rhs.val === 'boolean'
      ) {
        // `isPublished eq true`  → publishedAt != null  (compiled to IS NOT NULL)
        // `isPublished eq false` → publishedAt =  null  (compiled to IS NULL)
        // `isPublished ne true`  → publishedAt =  null
        // `isPublished ne false` → publishedAt != null
        //
        // CAP's SQL builder maps `= null` / `!= null` to
        // `IS NULL` / `IS NOT NULL` at compile time — see @sap/cds
        // db-service SQL emitters. Emitting the sugar-CQN shape is
        // safer than hand-rolling `[ref, 'is', 'not', 'null']` tokens,
        // whose spelling varies across CAP minor versions.
        const wantPublished =
          (op === 'eq' || op === '=') ? rhs.val : !rhs.val;
        where.splice(i, 3,
          { ref: ['publishedAt'] },
          wantPublished ? '!=' : '=',
          { val: null },
        );
        // Advance past the replacement so we don't rescan the rewritten
        // triple. splice inserted 3 elements starting at i.
        i += 2;
      }
    }
  }
}

// ============================================================
// PageRank rank-map loader (#916).
//
// Reads ConceptRank + TutorialRank sidecars and returns a shape the
// rankNeighborhood shim accepts as its 5th arg:
//   { conceptRank: Map<slug, score>,
//     tutorialRank: Map<slug, score>,
//     _normalizeTut: (score) => number in [0, 1] }
//
// Wrapped in a per-instance LRU (5-minute TTL) with a single-flight guard:
// concurrent neighborhood handlers share the in-flight promise, so N
// simultaneous request-time misses fire only ONE `SELECT * FROM
// ConceptRank / TutorialRank` pair.
//
// Every fault path returns EMPTY_RANK_MAPS. The ranker's multiplier
// collapses to 1.0 on empty maps, so any error here is equivalent to
// flag-off — no request-time throw ever propagates to the client.
// ============================================================

const RANK_MAP_TTL_MS = 5 * 60 * 1000;

// Late import: `cds` and `metrics` are already imported at the top of
// this file (lines ~259 and ~284 respectively) so we reference them
// directly below. The pure ranker tests never exercise this code path.

let _rankMapsCache = null;      // { at: number, value: {...} }
let _rankMapsInFlight = null;   // Promise or null

// Exposed for tests. Not for production callers.
export function _resetRankMapsCacheForTest() {
  _rankMapsCache = null;
  _rankMapsInFlight = null;
}

async function _loadRankMapsFromDb() {
  // Late-bind cds and metrics via dynamic import so this file's ranker
  // remains loadable in the CDS-model-free test workspace at
  // test/unit/kg-neighborhood-ranking.test.js. The (top-of-file) static
  // imports are only used inside the cds.service.impl callback, which
  // isn't reached by the ranker unit tests.
  const cdsMod = await import('@sap/cds');
  const db = await cdsMod.default.connect.to('db');
  const [conceptRows, tutorialRows] = await Promise.all([
    db.run('SELECT "SLUG", "SCORE" FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTRANK"'),
    db.run('SELECT "SLUG", "SCORE" FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALRANK"'),
  ]);

  const conceptRank = new Map(
    conceptRows.map(r => [r.SLUG, Number(r.SCORE) || 0]),
  );
  const tutorialRank = new Map(
    tutorialRows.map(r => [r.SLUG, Number(r.SCORE) || 0]),
  );

  // Precompute min/max of tutorialRank once per cache load so the
  // per-item blendTutRank callback is O(1).
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const s of tutorialRank.values()) {
    if (s < tMin) tMin = s;
    if (s > tMax) tMax = s;
  }
  const range = tMax - tMin;
  const _normalizeTut = range > 0
    ? (s) => (s - tMin) / range
    : () => 0;

  return { conceptRank, tutorialRank, _normalizeTut };
}

export async function loadRankMaps() {
  const now = Date.now();
  if (_rankMapsCache && now - _rankMapsCache.at < RANK_MAP_TTL_MS) {
    return _rankMapsCache.value;
  }
  if (_rankMapsInFlight) return _rankMapsInFlight;

  _rankMapsInFlight = (async () => {
    try {
      const value = await _loadRankMapsFromDb();
      _rankMapsCache = { at: Date.now(), value };
      return value;
    } catch (err) {
      // Late-imported metrics — same reason as _loadRankMapsFromDb.
      try {
        const m = await import('./lib/metrics.js');
        m.counter('kg_pagerank_read_failures');
      } catch { /* metrics unavailable — swallow */ }
      // Fail-open. Do NOT cache the failure — next request retries.
      return EMPTY_RANK_MAPS;
    } finally {
      _rankMapsInFlight = null;
    }
  })();

  return _rankMapsInFlight;
}

// ---------------------------------------------------------------------------
// Title-enrichment + dead-reference filter (PR #558 — KG sidebar UX)
//
// Background: the KG can reference tutorial slugs that no longer have a
// matching row in Tutorials (rename, hard delete, or status-flip without
// downstream cleanup). The original enrichment fell through to slug-as-title
// silently, producing UI links that landed on 404. Now we filter out those
// items entirely so the sidebar only surfaces live, ACTIVE tutorials.
//
// Both helpers are pure functions, exported for unit testing. They take
// pre-fetched data so the caller controls the DB query.
// ---------------------------------------------------------------------------

/**
 * Build a slug→title map from Tutorials rows, KEEPING only ACTIVE rows.
 * A NULL or missing `status` is treated as ACTIVE (the default before any
 * admin edit). Rows with any other status (DELETED, INACTIVE) are dropped.
 *
 * @param {Array<{slug:string, title?:string, status?:string}>} titleRows
 * @returns {Map<string, string>}
 */
export function buildLiveTitleMap(titleRows) {
  const out = new Map();
  for (const r of titleRows) {
    if (r.status && r.status !== 'ACTIVE') continue;
    out.set(r.slug, r.title ?? r.slug);
  }
  return out;
}

/**
 * Enrich a list of ranked tutorial-targeted items with their titles AND
 * filter out any item whose target slug isn't in the live-title map.
 *
 * @param {Array<{slug:string,...}>} items — ranked items from rankNeighborhood
 * @param {Map<string, string>} titleBySlug — from buildLiveTitleMap
 * @returns {Array<{slug, title, ...rest}>}
 */
export function enrichLiveTutorials(items, titleBySlug) {
  return items
    .filter((item) => titleBySlug.has(item.slug))
    .map((item) => ({ ...item, title: titleBySlug.get(item.slug) }));
}

// ---------------------------------------------------------------------------
// CAP service-impl — Task 5.3
// ---------------------------------------------------------------------------
//
// Routes:
//   GET  /graph/Concepts                — readonly projection (authenticated)
//   GET  /graph/ConceptEdges            — readonly projection (authenticated)
//   GET  /graph/TutorialConceptLinks    — readonly projection (authenticated)
//   GET  /graph/neighborhood(slug=...)  — flagship typed query (authenticated)
//   GET  /graph/pathBetween(...)        — Phase 2 stub (authenticated)
//   GET  /graph/conceptsForUser(...)    — Phase 2 stub (authenticated)
//   POST /graph/runSparql               — admin raw SPARQL passthrough
//   POST /graph/mergeConcepts           — admin curation
//   POST /graph/vetoConcept             — admin curation
//   POST /graph/vetoEdge                — admin curation
//   POST /graph/triggerGraphRebuild     — admin force-rebuild
//
// Feature-flag: process.env.KNOWLEDGE_GRAPH_ENABLED must equal 'true' or
// every operation on the service is rejected with HTTP 503. Gates the entire
// surface (reads + admin actions) for the simplest first-cut. Toggling at
// runtime requires a CAP restart only if the env var is read at boot — we
// re-check on every request so a `cf set-env` + `cf restart` flips it cleanly.

import cds from '@sap/cds';
import { SLUG_RE } from './lib/kg-queries.js';
import {
  kgQuery,
  kgAdminRunSparql,
  SparqlPrivilegeError,
  SparqlSyntaxError,
  SparqlTimeoutError,
} from './lib/kg-sparql-client.js';
import { graphRebuild } from './lib/kg-graph-rebuild.js';
import { loadCoCompletionsFor } from './lib/co-completion.js';
import { mergeConceptPair } from './lib/kg-merge-pair.js';
import { findNearDuplicates } from './lib/kg-similarity.js';
import { loadConceptsWithEmbeddings } from './lib/kg-concept-loader.js';
import { resolveKnowledgeGraphSettings } from './lib/runtime-config/kg-settings.js';
import { mergeOtherResources, MAX_OTHER_RESOURCES } from './lib/kg-neighborhood-merge.js';
import { stampMetaText, typeConfigForWire } from './lib/kg-stamp-meta-text.js';
import { loadOtherResourcesByType } from './lib/kg-other-resources-loader.js';
import {
  buildOtherResourcesByType,
  KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT_DEFAULT,
} from './lib/kg-neighborhood-full-helpers.js';
import { getTutorialTeachesMap } from './lib/kg-tutorial-teaches-map.js';
import { getCachedNeighborhood, setCachedNeighborhood } from './lib/kg-neighborhood-cache.js';
import { kgPathV2 } from './lib/kg-path-v2-client.js';
import { searchKgHandler } from './lib/kg/search-kg-handler.js';
import { embed as embedInputs } from './lib/embedding-client.js';
import { resolveEmbeddingSettings } from './lib/chat-settings-resolver.js';
import * as metrics from './lib/metrics.js';

const NAMESPACE = 'com.sap.developers.ims';

// Task 5 of #850: per-type cap for /graph/neighborhoodFull's expanded
// panel. Overridable via env; falls back to the module default (15) on
// invalid / missing values, logging at boot so operators see the fallback.
function resolveNeighborhoodFullPerTypeLimit() {
  const raw = process.env.KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT;
  if (raw === undefined || raw === null || raw === '') {
    return KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT_DEFAULT;
  }
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) {
    // eslint-disable-next-line no-console
    console.warn(
      `[kg] KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT=${JSON.stringify(raw)} invalid; ` +
        `falling back to ${KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT_DEFAULT}`,
    );
    return KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT_DEFAULT;
  }
  return n;
}
const KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT = resolveNeighborhoodFullPerTypeLimit();
cds.log('knowledge-graph-service').info(
  `[kg] KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT = ${KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT}`,
);

// Task 5 of #850: raised per-section cap for the expanded panel (vs the
// sidebar's TOP_N=10). Passed to rankNeighborhood via the new maxResults
// arg; falls back to TOP_N for the sidebar path.
const NEIGHBORHOOD_FULL_MAX_PER_SECTION = 30;

// SPARQL response IRI prefix for tutorials (from kg-projection.js +
// kg-queries.js). The neighborhood query already strips this via
// REPLACE(STR(?iri), prefix, '') BIND, but we hold the constant here for
// the parseNeighborhoodSparqlResponse helper if a caller passes a row
// where the BIND was skipped (e.g. the teaches branch carries a Concept
// IRI in the pre-bind variable).
const TUTORIAL_IRI_PREFIX = 'https://developers.sap.com/kg/tutorial/';

// LRU cache for (slug, graphVersion) → NeighborhoodResult. Wired in the
// KG-widget-perf PR — see srv/lib/kg-neighborhood-cache.js. Handler hits
// this before doing any DB work (line ~580) and stores the full result on
// exit (line ~972). Bust on graphRebuild via bustNeighborhoodCache().
//
// Historic note: this used to be `const _NEIGHBORHOOD_CACHE = null;` with
// two TODO markers in the handler body. The perf PR replaces both markers
// with real lookup/store calls against the new dedicated module.

// Detect whether a SPARQL statement is a state-mutating UPDATE.
// Used to flag the audit payload (KnowledgeGraphRunSparql.isUpdate)
// and to set the procedure's audit flag.
const SPARQL_UPDATE_RE = /^\s*(INSERT|DELETE|CLEAR|DROP|CREATE|LOAD|COPY|MOVE|ADD)\b/i;
function detectUpdate(sparql) {
  return SPARQL_UPDATE_RE.test(sparql);
}

/**
 * Minimal embed-client factory for actions that need a vector but should NOT
 * pull in the Joule orchestrator. Mirrors the identical helper in
 * srv/lib/chat-orchestrator.js — kept separate to avoid a cross-service import.
 * Used by the searchKG palette handler (issue #1036).
 */
function defaultEmbedClient(model) {
  return {
    async embed(text /* , opts */) {
      const [vec] = await embedInputs([text], model);
      return vec;
    },
  };
}

/**
 * Set a response header on a CAP request. Reaches into CAP's underlying
 * express response via `req._.req.res`, which is undocumented — if a future
 * @sap/cds release changes the layout, this becomes a no-op (the optional
 * chaining ensures graceful degradation rather than a TypeError). Centralised
 * here so any future fix only needs to touch one site.
 */
function setResponseHeader(req, name, value) {
  try {
    req._?.req?.res?.set?.(name, value);
  } catch {
    // Never let header-setting break the response — silent fallback.
  }
}

/**
 * Parse the SPARQL JSON response emitted by SYS.SPARQL_EXECUTE for the
 * NEIGHBORHOOD_QUERY (4-way UNION SELECT DISTINCT). Each binding has at
 * most these vars: ?type, ?targetSlug, ?targetLabel (teaches branch
 * only), ?weight (teaches + prerequisitesOf branches).
 *
 * SPARQL emits unbound projection vars as missing keys in the binding
 * object, NOT as null. We coerce missing → null for downstream simplicity.
 *
 * Exported for unit testing — kept here (rather than in kg-queries.js)
 * because the response shape is co-located with the handler that consumes
 * it.
 *
 * @param {string} jsonStr — raw JSON from SPARQL_EXECUTE's response NCLOB
 * @param {string} _slug   — the input tutorial slug; reserved for future
 *   defensive validation of bound IRIs (currently unused, the SPARQL
 *   query already filters self-rows).
 * @returns {Array<{type:?string, targetSlug:?string, targetLabel:?string, weight:?number}>}
 * @throws {SyntaxError} on malformed JSON
 */
export function parseNeighborhoodSparqlResponse(jsonStr, _slug) {
  const parsed = JSON.parse(jsonStr);
  const bindings = parsed?.results?.bindings;
  if (!Array.isArray(bindings)) return [];
  return bindings.map((b) => ({
    type:        b?.type?.value ?? null,
    targetSlug:  b?.targetSlug?.value ?? null,
    targetLabel: b?.targetLabel?.value ?? null,
    weight:
      b?.weight?.value !== undefined && b?.weight?.value !== null
        ? Number(b.weight.value)
        : null,
  }));
}

/**
 * Map the kg-sparql-client error classes onto CAP req.error codes. Privilege
 * errors are 503 (ops issue, not the user's fault); syntax errors are 500
 * (we constructed the SPARQL — never the caller); timeouts are 504.
 */
function mapSparqlError(err, req, log) {
  if (err instanceof SparqlPrivilegeError) {
    log.error('SPARQL privilege missing', { remediation: err.remediation });
    return req.error(503, 'Knowledge graph temporarily unavailable');
  }
  if (err instanceof SparqlSyntaxError) {
    log.error('SPARQL syntax error in generated query', {
      sparql: err.sparql,
      cause: err.message,
    });
    return req.error(500, 'Internal knowledge-graph query error');
  }
  if (err instanceof SparqlTimeoutError) {
    return req.error(504, 'Knowledge-graph query timed out');
  }
  log.error('kg-service: unexpected SPARQL error class — falling through to framework default', {
    name: err?.constructor?.name,
    message: err?.message,
  });
  throw err;
}

// ─── pathBetween wire-shape mappers (#913) ────────────────────────────────
// Both mappers reduce the underlying result to the CDS return type
// `array of String`, i.e. bare tutorial slugs. Kept side-by-side so a
// reviewer can eyeball the v1/v2 parity at a glance.
function mapPgPathsToWireShape(paths) {
  const best = paths[0];
  if (!best) return [];
  // `?? []` guards against a future kgPathV2 shape that ever omits `vertices`;
  // today the wrapper always emits it, but the mapper stays defensive since
  // it's called from the pathBetween hot path.
  return (best.vertices ?? [])
    .filter(v => typeof v === 'string' && v.startsWith('tutorial:'))
    .map(v => v.slice('tutorial:'.length));
}

// Extract the bridging tutorial slugs from a SPARQL PATH_BETWEEN response.
// Mirrors the wire shape of the property-graph mapper above.
function mapV1SparqlToWireShape(response) {
  let parsed;
  try { parsed = JSON.parse(response); } catch { return []; }
  const bindings = parsed?.results?.bindings ?? [];
  // The PATH_BETWEEN SPARQL binds ?b (bridging tutorial IRI) per db/src/procedures/KG_QUERY.hdbprocedure:205.
  return bindings
    .map(b => b?.b?.value ?? '')
    .filter(v => v.startsWith('https://developers.sap.com/kg/tutorial/'))
    .map(v => v.slice('https://developers.sap.com/kg/tutorial/'.length));
}

/**
 * Legacy inline `buildTutorialTeachesMap` moved to
 * srv/lib/kg-tutorial-teaches-map.js in the KG-widget-perf PR. The new
 * module adds a 5-minute in-process TTL cache so the ~800ms full-table
 * scan runs at most once per five minutes instead of every request.
 * The graph-rebuild path also busts it explicitly.
 */

export default cds.service.impl(async function () {
  const log = cds.log('knowledge-graph-service');
  const db = await cds.connect.to('db');

  // Audit-log channel — used by curation actions. Best-effort: if the
  // audit-log service is not bound (local dev with no audit binding), skip
  // logging silently rather than failing the action.
  let auditLog = null;
  try {
    auditLog = await cds.connect.to('audit-log');
  } catch (err) {
    log.warn(`kg-service: audit-log binding unavailable (${err.message ?? err}); curation actions will not be audited`);
  }

  async function audit(action, data) {
    if (!auditLog) return;
    try {
      await auditLog.log('SecurityEvent', { data: { action, ...data } });
    } catch (err) {
      log.warn(`kg-service: audit log write failed (${err.message ?? err})`);
    }
  }

  /**
   * Fire-and-forget graphRebuild after a curation action. Logs structured
   * details on failure (so operators get a signal beyond a generic stack
   * trace) and best-effort emits a SecurityEvent audit entry. Never throws
   * — by design, the user response has already been sent.
   */
  function asyncRebuildAfterCuration(action, actorContext = {}) {
    graphRebuild({ db, log }).catch((err) => {
      log.error(`kg-service: async graphRebuild after ${action} failed`, {
        action,
        error: err?.message,
        stack: err?.stack,
        ...actorContext,
      });
      if (auditLog) {
        // Best-effort audit entry; never blocks or rethrows.
        audit('KnowledgeGraphAsyncRebuildFailed', {
          action,
          error: err?.message,
          ...actorContext,
        }).catch(() => {});
      }
    });
  }

  // ─── Feature flag — gate the entire surface ────────────────────────────
  this.before('*', async (req) => {
    const kg = await resolveKnowledgeGraphSettings();
    if (!kg.enabled) {
      req.reject(503, 'Knowledge graph is currently disabled');
    }
  });

  // ─── Concepts UPDATE guard — restrict the writable surface ─────────────
  // The Concepts projection is no longer @readonly so the Fiori Elements
  // admin app can PATCH `name` + `description`. Defense-in-depth: even with
  // @Common.FieldControl: #ReadOnly on the other fields, a hand-crafted
  // PATCH could try to mutate `slug`/`status`/`embedding` etc. — reject any
  // such attempt at the service layer. Status flips happen exclusively via
  // the vetoConcept / mergeConcepts actions.
  //
  // NOTE: at the OData path, FieldControl metadata strips read-only fields
  // before this handler runs, so the negative path is rarely exercised over
  // HTTP. This guard catches programmatic UPDATEs (cross-service calls,
  // jobs) where no metadata filter applies. req.reject ensures a hard
  // failure rather than silent error-queuing.
  // See test/unit/kg-concepts-update-guard.test.js for the editable-surface
  // smoke test (positive path only — negative-path testing is a TODO).
  const CONCEPTS_PATCH_ALLOWLIST = new Set(['name', 'description']);
  this.before('UPDATE', 'Concepts', (req) => {
    // Defence-in-depth: the CDS service-level @requires was dropped to make
    // the read surface public (Task 1 of the KG public-reader PR,
    // 2026-06-28). The writable Concepts projection still needs the admin
    // scope; assert it imperatively here so anonymous PATCH returns 403
    // before the field allowlist runs.
    if (!req.user?.is?.('KnowledgeGraph.Admin')) {
      return req.reject(403, 'KnowledgeGraph.Admin scope required to write Concepts.');
    }
    const data = req.data || {};
    for (const key of Object.keys(data)) {
      // CAP includes the entity key + audit fields automatically; skip those.
      if (key === 'ID') continue;
      if (key === 'createdAt' || key === 'createdBy') continue;
      if (key === 'modifiedAt' || key === 'modifiedBy') continue;
      if (CONCEPTS_PATCH_ALLOWLIST.has(key)) continue;
      return req.reject(403, `Field '${key}' is not editable on Concepts`);
    }
  });

  // ─── after(READ, Concepts) — #918 WCC isolation flag ───────────────────
  //
  // Populate the virtual `isolated : Boolean` field on each Concepts row
  // from the KgIsolation sidecar (populated nightly by
  // srv/jobs/kg-wcc-job.js). Batched per page — Fiori Elements requests
  // 30 rows/page by default, so this is one small IN-clause query per
  // list-report page load.
  //
  // Fail-quiet: on any error (sidecar missing, HANA hiccup, deploy skew),
  // leave `isolated` unset. Fiori renders `null` boolean as no badge —
  // same visual result as false. No request-time throw ever propagates
  // to the client.
  //
  // Spec: docs/superpowers/specs/2026-07-04-918-kg-wcc-isolation-design.md
  //
  // #1080 — this handler also stamps the virtual `isPublished : Boolean`
  // from the already-projected `publishedAt` column so admins get a Yes/No
  // filter on the Concepts list report (raw publishedAt gave them a date
  // picker). The paired before('READ') rewrite pushes the FE filter down
  // to HANA as `publishedAt IS (NOT) NULL`.
  this.after('READ', 'Concepts', async (rows, req) => {
    if (!Array.isArray(rows) || rows.length === 0) return;

    // isPublished projection — cheap, uses already-selected columns.
    // Only stamp when publishedAt is projected (FE selects it via
    // LineItem/HeaderInfo); leave unset otherwise so bespoke queries
    // that excluded publishedAt don't see a misleading `false`.
    for (const r of rows) {
      if (Object.prototype.hasOwnProperty.call(r, 'publishedAt')) {
        r.isPublished = r.publishedAt != null;
      }
    }

    // isolated lookup (#918).
    const slugs = rows.map((r) => r.slug).filter(Boolean);
    if (slugs.length === 0) return;
    try {
      const placeholders = slugs.map(() => '?').join(',');
      const flagged = await cds.tx(req).run(
        `SELECT SLUG FROM "COM_SAP_DEVELOPERS_IMS_KGISOLATION" ` +
          `WHERE VERTEXTYPE = ? AND SLUG IN (${placeholders})`,
        ['concept', ...slugs],
      );
      const set = new Set(flagged.map((r) => r.SLUG));
      for (const r of rows) {
        if (r.slug) r.isolated = set.has(r.slug);
      }
    } catch (err) {
      log.warn(
        `kg-service: isolated flag lookup failed on Concepts; leaving field unset (${err?.message ?? err})`,
      );
    }
  });

  // ─── before(READ, Concepts) — #1080 isPublished CQN rewrite ────────────
  //
  // Fiori's FilterBar sends `$filter=isPublished eq true|false` as a
  // regular comparison. Because `isPublished` is a virtual field (no SQL
  // column backing it), the default push-down would emit
  // `WHERE "isPublished" = TRUE` — HANA rejects with a column-not-found
  // at query time.
  //
  // Rewrite the CQN tree in-place: any `{ ref: ['isPublished'] } eq
  // { val: true|false }` triple becomes `publishedAt IS (NOT) NULL`. Walks
  // nested `and`/`or` groups produced by FE's filter composition. Non-
  // boolean values (defensive path — FE only emits booleans) are left
  // alone.
  this.before('READ', 'Concepts', (req) => {
    const where = req.query?.SELECT?.where;
    if (Array.isArray(where) && where.length > 0) {
      rewriteIsPublishedFilter(where);
    }
  });

  // ─── neighborhood(slug) ────────────────────────────────────────────────
  this.on('neighborhood', async (req) => {
    const { slug } = req.data;
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      return req.error(400, 'Invalid slug');
    }

    // 1. Read graphVersion. If null, the consolidator hasn't run yet —
    // return an empty-but-valid envelope so clients render gracefully.
    const { GraphMetadata, Tutorials } = cds.entities(NAMESPACE);
    const meta = await SELECT.one
      .from(GraphMetadata)
      .columns('graphVersion');
    const graphVersion = meta?.graphVersion ?? null;

    // ETag for client-side cache. Only meaningful once graphVersion exists.
    if (graphVersion) {
      setResponseHeader(req, 'ETag', `"${slug}:${graphVersion}"`);
    }

    // 2. Look up input tutorial title.
    const inputTutorial = await SELECT.one
      .from(Tutorials)
      .columns('slug', 'title')
      .where({ slug });
    const tutorialInfo = {
      slug,
      title: inputTutorial?.title ?? slug,
    };

    if (!graphVersion) {
      log.info(`kg-service: neighborhood(${slug}) — no graphVersion yet; returning empty envelope`);
      return {
        tutorial:        tutorialInfo,
        graphVersion:    null,
        teaches:         [],
        prerequisitesOf: [],
        sharedConcepts:  [],
        whatToLearnNext: [],
        otherResources:  [],  // Phase 4 chassis (#447). Empty in PR-1; PR-2 populates from journey overlap.
        // Task 4 of #850: ship typeConfig even on cold-start so new clients
        // don't fire a legacy-fallback warning before the consolidator runs.
        typeConfig:      typeConfigForWire(),
      };
    }

    // 3. Cache lookup — if we've already served this (slug, graphVersion)
    //    within the TTL window, return the cached result and skip ALL the
    //    downstream DB work. See srv/lib/kg-neighborhood-cache.js.
    const cached = getCachedNeighborhood(slug, graphVersion);
    if (cached) return cached;

    // 4. Run the named query via the KG_QUERY procedure.
    if (!SLUG_RE.test(slug)) {
      return req.error(400, `Invalid tutorial slug: "${slug}"`);
    }
    const tutorialIri = TUTORIAL_IRI_PREFIX + slug;

    // 5. Run the SPARQL query.
    let response;
    try {
      ({ response } = await kgQuery({
        db,
        queryName: 'NEIGHBORHOOD',
        params: { slug: tutorialIri },
      }));
    } catch (err) {
      return mapSparqlError(err, req, log);
    }

    // 6. Parse SPARQL response into the row shape rankNeighborhood expects.
    let rows;
    try {
      rows = parseNeighborhoodSparqlResponse(response, slug);
    } catch (err) {
      log.error(`kg-service: malformed SPARQL response: ${err.message}`);
      return req.error(500, 'Internal knowledge-graph query error');
    }

    // 7. Load co-completion neighbors from the pre-materialized table
    //    (see srv/jobs/materialize-co-completions.js — nightly cron, ~10ms
    //    read vs ~60s JIT). Falls back to empty on any error, mirroring
    //    the original behavior.
    let coMap = new Map();
    try {
      const neighbors = await loadCoCompletionsFor(slug, { db });
      coMap = new Map(neighbors.map((e) => [e.slug, e.score]));
    } catch (err) {
      log.warn(`kg-service: loadCoCompletionsFor failed (${err.message ?? err}); proceeding without boost`);
    }

    // 8. Get tutorial-teaches map (cached with 5-min TTL; see
    //    srv/lib/kg-tutorial-teaches-map.js). Cost:
    //    - Cache hit:  ~1ms
    //    - Cache miss: ~800ms (full-table scan, then cached)
    //    Bust hook fires on graphRebuild so a fresh publish is reflected
    //    without waiting for TTL.
    let tutorialTeachesMap;
    try {
      tutorialTeachesMap = await getTutorialTeachesMap(db, log);
    } catch (err) {
      log.warn(`kg-service: getTutorialTeachesMap failed (${err.message ?? err}); proceeding without subset suppression`);
      tutorialTeachesMap = undefined;
    }

    // 9. Run the pure ranker.
    // Flag-gated PageRank blend (#916). When on, load the sidecar maps
    // (LRU-cached, 5-min TTL, single-flight in-file) and pass as the 5th
    // positional arg. When off, EMPTY_RANK_MAPS collapses every multiplier
    // to 1.0, so the arm output is identical to pre-#916.
    const rankMaps = process.env.KG_PAGERANK_ENABLED === 'true'
      ? await loadRankMaps()
      : EMPTY_RANK_MAPS;
    const ranked = rankNeighborhood(rows, slug, coMap, tutorialTeachesMap, rankMaps);

    // 10 + 10b. Enrichment lookups. Run in parallel — they're independent.
    //   - Tutorial titles: from Tutorials table for prereqs/shared/next slugs.
    //     Drops non-ACTIVE tutorials (avoids surfacing broken links).
    //   - Concept publish set: which of the teaches[] concepts have a live
    //     /concepts/<slug>/ page. Sidebar renders <a> vs <span> per this.
    const candidateSlugs = new Set();
    for (const item of ranked.prerequisitesOf) candidateSlugs.add(item.slug);
    for (const item of ranked.sharedConcepts)  candidateSlugs.add(item.slug);
    for (const item of ranked.whatToLearnNext) candidateSlugs.add(item.slug);
    const teachesSlugs = ranked.teaches.map((c) => c.slug);
    const { Concepts } = cds.entities(NAMESPACE);

    const [titleRows, publishedRows] = await Promise.all([
      candidateSlugs.size > 0
        ? SELECT.from(Tutorials)
            .columns('slug', 'title', 'status')
            .where({ slug: { in: [...candidateSlugs] } })
        : Promise.resolve([]),
      teachesSlugs.length > 0
        ? SELECT.from(Concepts)
            .columns('slug')
            .where({ slug: { in: teachesSlugs }, publishedAt: { '!=': null }, status: 'ACTIVE' })
        : Promise.resolve([]),
    ]);
    const titleBySlug = buildLiveTitleMap(titleRows);
    const publishedSet = new Set(publishedRows.map((r) => r.slug));
    const enrich = (arr) => enrichLiveTutorials(arr, titleBySlug);

    // Phase 4.1-4.6: "Other resources" rail — up to MAX_OTHER_RESOURCES
    // rows total across 6 external-content corpora (journeys, blogs,
    // missions, videos, api-docs, samples). Each corpus contributes rows
    // ranked by shared-concept overlap with this tutorial's teaches[].
    //
    // Parallelization (KG-widget-perf): the 6 overlap-count queries and
    // the concept-ID lookup used to run SEQUENTIALLY (~1.86s total wall
    // clock on DEV). They're all independent — fire concurrently and
    // process in parallel. Expected: ~400-600ms bottleneck-limited.
    //
    // Structure: fetch all overlap rows in parallel, then compute + fetch
    // top-N metadata for each corpus in parallel, then merge. The JS-side
    // ranking is microseconds; only the DB round-trips matter for wall
    // clock.
    let otherResources = [];
    try {
      const teachesSlugs = ranked.teaches.map((c) => c.slug);
      if (teachesSlugs.length > 0) {
        const conceptRows = await SELECT.from(Concepts)
          .columns('ID', 'slug')
          .where({ slug: { in: teachesSlugs } });
        const conceptIds = conceptRows.map((c) => c.ID);

        if (conceptIds.length > 0) {
          // Load the per-corpus wire-shape rows grouped by type. The
          // loader is a pure extraction of the 6-corpus overlap query +
          // shape logic — extracted so the (upcoming Task 5) full-panel
          // handler can call it with a larger `perTypeLimit` and keep the
          // grouping instead of merging.
          const byType = await loadOtherResourcesByType(cds, conceptIds, MAX_OTHER_RESOURCES);

          // Sidebar: merge + cap top-5 across all 6 types (variadic).
          otherResources = mergeOtherResources(...byType.values());

          // Step 6 (Task 4 of #850): stamp metaText on each row via
          // RESOURCE_TYPE_CONFIG.renderMeta. Server owns the meta-text
          // string so the client renderer stays a pure per-row function
          // without a `v-if r.type === '…'` chain.
          stampMetaText(otherResources);
        }
      }
    } catch (err) {
      log.warn(`kg-service: neighborhood otherResources enrichment failed: ${err.message ?? err}`);
      otherResources = [];
    }

    const result = {
      tutorial:        tutorialInfo,
      graphVersion,
      teaches:         ranked.teaches.map((c) => ({
        slug: c.slug,
        name: c.name,
        description: '',  // Concepts.description not pulled by the ranker; left empty for Phase 1
        published: publishedSet.has(c.slug),
      })),
      prerequisitesOf: enrich(ranked.prerequisitesOf),
      sharedConcepts:  enrich(ranked.sharedConcepts),
      whatToLearnNext: enrich(ranked.whatToLearnNext),
      otherResources,  // Phase 4.1 (#447) — populated from journey overlap.
      // Task 4 of #850: server-owned type registry. Client renders icons +
      // section labels off this array; no v-if chain on r.type.
      typeConfig:      typeConfigForWire(),
    };

    // 11. Cache-store — key = (slug, graphVersion). Next request for this
    //     tutorial with the same graphVersion hits the cache and skips ALL
    //     the DB work above. See srv/lib/kg-neighborhood-cache.js.
    setCachedNeighborhood(slug, graphVersion, result);
    return result;
  });

  // ─── neighborhoodFull(slug) — Task 5 of #850 ─────────────────────────────
  // Sibling of `neighborhood`. Same feature-flag, ranker, loader, and
  // cache — but returns per-type buckets (not merged top-5) with larger
  // caps for the ExpandedPanel dialog. Response envelope carries no
  // `teaches` (redesign concentrates the concept list in the sidebar
  // only). Cached in the 'full' bucket so the sidebar and expanded
  // panel don't shadow each other.
  this.on('neighborhoodFull', async (req) => {
    const { slug } = req.data;
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      return req.error(400, 'Invalid slug');
    }

    // 1. graphVersion + input tutorial title.
    const { GraphMetadata, Tutorials } = cds.entities(NAMESPACE);
    const meta = await SELECT.one.from(GraphMetadata).columns('graphVersion');
    const graphVersion = meta?.graphVersion ?? null;

    // Empty-but-valid envelope helper. Used when graphVersion is null,
    // when the tutorial isn't found, or when no teaches[] concepts exist
    // so the loader has nothing to overlap against. Every branch ships
    // the same fields the wire schema declares so clients can render
    // unconditionally.
    const emptyEnvelope = (tutorialInfo, gv) => ({
      tutorial:              tutorialInfo,
      graphVersion:          gv,
      prerequisitesOf:       [],
      sharedConcepts:        [],
      whatToLearnNext:       [],
      otherResourcesByType:  [],
      typeConfig:            typeConfigForWire(),
    });

    if (graphVersion) {
      setResponseHeader(req, 'ETag', `"${slug}:${graphVersion}:full"`);
    }

    // 2. Look up input tutorial title.
    const inputTutorial = await SELECT.one
      .from(Tutorials)
      .columns('slug', 'title')
      .where({ slug });
    const tutorialInfo = {
      slug,
      title: inputTutorial?.title ?? slug,
    };

    if (!graphVersion) {
      log.info(
        `kg-service: neighborhoodFull(${slug}) — no graphVersion yet; returning empty envelope`,
      );
      return emptyEnvelope(tutorialInfo, null);
    }

    // 3. Cache lookup — 'full' bucket so we don't collide with the sidebar.
    const cached = getCachedNeighborhood(slug, graphVersion, 'full');
    if (cached) return cached;

    const tutorialIri = TUTORIAL_IRI_PREFIX + slug;

    // 4. Run SPARQL.
    let response;
    try {
      ({ response } = await kgQuery({
        db,
        queryName: 'NEIGHBORHOOD',
        params: { slug: tutorialIri },
      }));
    } catch (err) {
      return mapSparqlError(err, req, log);
    }

    // 5. Parse.
    let rows;
    try {
      rows = parseNeighborhoodSparqlResponse(response, slug);
    } catch (err) {
      log.error(`kg-service: malformed SPARQL response: ${err.message}`);
      return req.error(500, 'Internal knowledge-graph query error');
    }

    // 6. Co-completion boost + tutorial-teaches map (best-effort).
    let coMap = new Map();
    try {
      const neighbors = await loadCoCompletionsFor(slug, { db });
      coMap = new Map(neighbors.map((e) => [e.slug, e.score]));
    } catch (err) {
      log.warn(
        `kg-service: loadCoCompletionsFor failed (${err.message ?? err}); proceeding without boost`,
      );
    }
    let tutorialTeachesMap;
    try {
      tutorialTeachesMap = await getTutorialTeachesMap(db, log);
    } catch (err) {
      log.warn(
        `kg-service: getTutorialTeachesMap failed (${err.message ?? err}); proceeding without subset suppression`,
      );
      tutorialTeachesMap = undefined;
    }

    // 7. Rank with raised per-section cap (30 vs the sidebar's 10) AND
    //    flag-gated PageRank blend (#916). The 6th positional arg carries
    //    the cap; the 5th carries rankMaps (or EMPTY_RANK_MAPS when off).
    const rankMaps = process.env.KG_PAGERANK_ENABLED === 'true'
      ? await loadRankMaps()
      : EMPTY_RANK_MAPS;
    const ranked = rankNeighborhood(
      rows,
      slug,
      coMap,
      tutorialTeachesMap,
      rankMaps,
      NEIGHBORHOOD_FULL_MAX_PER_SECTION,
    );

    // 8. Enrichment lookups: tutorial titles for prereq/shared/next,
    //    concept IDs for the loader. Same pattern as `neighborhood`.
    const candidateSlugs = new Set();
    for (const item of ranked.prerequisitesOf) candidateSlugs.add(item.slug);
    for (const item of ranked.sharedConcepts)  candidateSlugs.add(item.slug);
    for (const item of ranked.whatToLearnNext) candidateSlugs.add(item.slug);
    const teachesSlugs = ranked.teaches.map((c) => c.slug);
    const { Concepts } = cds.entities(NAMESPACE);

    const [titleRows, conceptRows] = await Promise.all([
      candidateSlugs.size > 0
        ? SELECT.from(Tutorials)
            .columns('slug', 'title', 'status')
            .where({ slug: { in: [...candidateSlugs] } })
        : Promise.resolve([]),
      teachesSlugs.length > 0
        ? SELECT.from(Concepts)
            .columns('ID', 'slug')
            .where({ slug: { in: teachesSlugs } })
        : Promise.resolve([]),
    ]);
    const titleBySlug = buildLiveTitleMap(titleRows);
    const enrich = (arr) => enrichLiveTutorials(arr, titleBySlug);
    const conceptIds = conceptRows.map((c) => c.ID);

    // 9. Per-type buckets. Loader stays shared with the sidebar; the
    //    difference is the larger `perTypeLimit` and that we keep the
    //    grouping instead of merging. Empty-teaches path short-circuits.
    let otherResourcesByType = [];
    if (conceptIds.length > 0) {
      try {
        const byType = await loadOtherResourcesByType(
          cds,
          conceptIds,
          KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT,
        );
        otherResourcesByType = buildOtherResourcesByType(
          byType,
          KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT,
        );
      } catch (err) {
        log.warn(
          `kg-service: neighborhoodFull otherResourcesByType enrichment failed: ${err.message ?? err}`,
        );
        otherResourcesByType = [];
      }
    }

    const result = {
      tutorial:              tutorialInfo,
      graphVersion,
      prerequisitesOf:       enrich(ranked.prerequisitesOf),
      sharedConcepts:        enrich(ranked.sharedConcepts),
      whatToLearnNext:       enrich(ranked.whatToLearnNext),
      otherResourcesByType,
      typeConfig:            typeConfigForWire(),
    };

    setCachedNeighborhood(slug, graphVersion, result, 'full');
    return result;
  });

  // ─── pathBetween — property-graph v2 with fail-open v1 fallback (#913) ─
  this.on('pathBetween', async (req) => {
    const { fromSlug, toSlug } = req.data;
    const fromIri = `https://developers.sap.com/kg/tutorial/${fromSlug}`;
    const toIri   = `https://developers.sap.com/kg/tutorial/${toSlug}`;
    const t0 = Date.now();
    // Test-injection hooks (#913). cds.test('serve') pre-resolves this
    // module via cds.utils._import (dynamic file:// import on Windows),
    // which bypasses vi.mock's ESM interceptor. See the same pattern in
    // srv/lib/explainer-generator.js. Production code never sets these.
    const kgPathV2Impl = typeof globalThis.__KG_PATH_V2_TEST_IMPL__ === 'function'
      ? globalThis.__KG_PATH_V2_TEST_IMPL__
      : kgPathV2;
    const kgQueryImpl = typeof globalThis.__KG_QUERY_TEST_IMPL__ === 'function'
      ? globalThis.__KG_QUERY_TEST_IMPL__
      : kgQuery;

    if (process.env.KG_PATH_V2_ENABLED === 'true') {
      try {
        const paths = await kgPathV2Impl({ fromIri, toIri });
        if (paths.length > 0) {
          const wire = mapPgPathsToWireShape(paths);
          metrics.counter('kg_path_between_calls_v2_success_prereq');
          metrics.observe('kg_path_between_latency_ms_v2', Date.now() - t0);
          return wire;
        }
        metrics.counter('kg_path_v2_fallback_empty');
      } catch (err) {
        cds.log('kg').warn('kg_path_v2_failed', {
          code: err.code, message: err.message, fromSlug, toSlug,
        });
        metrics.counter('kg_path_v2_fallback_error');
      }
    } else {
      metrics.counter('kg_path_v2_fallback_flag_off');
    }

    // ── v1 SPARQL fallback: activates the PATH_BETWEEN dispatch in KG_QUERY.
    // ── Previously stubbed to []; now wired to the real named-query call.
    // `t1` captures the boundary between v2 fail-through and the v1 SPARQL
    // round-trip so `kg_path_between_latency_ms_v1` isn't polluted by v2
    // fallback-attempt time (v2 timeouts would otherwise show up in v1's
    // p95/p99 dashboard and confuse the decision-gate A/B numbers).
    //
    // IRI-vs-slug contract: KG_QUERY.hdbprocedure validates p1/p2 against
    // `^https://developers\.sap\.com/kg/tutorial/[a-z0-9-]{1,80}$` (line 182)
    // and SIGNALs KG_INVALID_TUTORIAL_IRI (10006) on mismatch. Callers MUST
    // pass full IRIs, not bare slugs. See srv/lib/kg-path.js:38-45 for the
    // canonical pattern. Live drill 2026-07-03 caught this: passing bare
    // slugs raised SIGNAL 10006 on every call, causing the handler to
    // return []. Not a regression from the spike — the pre-spike handler
    // was a Phase 2 stub that always returned []; the spike wired it up
    // for the first time and inherited the impedance mismatch.
    const t1 = Date.now();
    try {
      const { response } = await kgQueryImpl({
        db: cds.db,
        queryName: 'PATH_BETWEEN',
        params: { fromSlug: fromIri, toSlug: toIri },
      });
      const wire = mapV1SparqlToWireShape(response);
      metrics.counter(wire.length ? 'kg_path_between_calls_v1_success' : 'kg_path_between_calls_v1_empty');
      metrics.observe('kg_path_between_latency_ms_v1', Date.now() - t1);
      return wire;
    } catch (err) {
      log.warn(`kg-service: pathBetween v1 failed: ${err.message}`);
      metrics.counter('kg_path_between_calls_v1_error');
      return [];
    }
  });

  // ─── conceptsForUser — Phase 2 implementation (#445) ────────────────────
  // Delegates to srv/lib/kg/concepts-for-user.js. Gated by
  // ChatSettings.kgPathBetweenEnabled — when false, returns empty coverage
  // so the pathBetween handler (and any direct CDS callers) short-circuit
  // gracefully without hitting the SPARQL layer.
  this.on('conceptsForUser', async (req) => {
    const userId = req.data?.userId || req.user?.id;
    if (!userId) {
      return { learned: [], partial: [] };
    }
    try {
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      const settings = await SELECT.one.from(ChatSettings);
      if (!settings?.kgPathBetweenEnabled) {
        return { learned: [], partial: [] };
      }
      const { getConceptsForUser } = await import('./lib/kg/concepts-for-user.js');
      const result = await getConceptsForUser({ db: cds.db, userId });
      return { learned: result.learned, partial: result.partial };
    } catch (err) {
      log.warn(`kg-service: conceptsForUser failed: ${err.message}`);
      return { learned: [], partial: [] };
    }
  });

  // ─── searchKG — anonymous KG search for the ⌘K command palette ──────────
  // Delegates to the anonymous-safe handler; never imports on-demand-enqueue.
  // Auth: inherited service-level @requires:'any' — anonymous callers get 200.
  // (issue #1036)
  this.on('searchKG', async (req) => {
    const { model } = await resolveEmbeddingSettings();
    const embedClient = defaultEmbedClient(model);
    return searchKgHandler({
      db,
      embedClient,
      args: {
        term: req.data.term,
        maxConcepts: req.data.maxConcepts,
        maxTutorials: req.data.maxTutorials,
      },
    });
  });

  // ─── runSparql — admin raw SPARQL passthrough ──────────────────────────
  this.on('runSparql', async (req) => {
    log.info(`kg-service: runSparql by ${req.user?.id ?? 'unknown'} (${query.length} chars)`);
    await audit('KnowledgeGraphRunSparql', {
      user: req.user?.id ?? 'unknown',
      queryLength: query.length,
      query: truncatedForLog,
      isUpdate,
    });

    let response;
    try {
      ({ response } = await kgAdminRunSparql({ db, sparql: query, isUpdate }));
    } catch (err) {
      return mapSparqlError(err, req, log);
    }

    // Parse the SPARQL JSON results into { columns, rows-as-strings }.
    let parsed;
    try {
      parsed = JSON.parse(response);
    } catch (err) {
      log.error(`kg-service: SPARQL response not JSON (${err.message})`);
      return req.error(500, 'SPARQL response was not parseable');
    }
    const columns = Array.isArray(parsed?.head?.vars) ? parsed.head.vars : [];
    const bindings = Array.isArray(parsed?.results?.bindings) ? parsed.results.bindings : [];
    // Mirror AnalyticsService.runSelectQuery's wire shape: each row is a
    // JSON-stringified array of column-value strings. CDS type system
    // doesn't support `array of array of String` in type definitions.
    const rows = bindings.map((b) =>
      JSON.stringify(columns.map((c) => (b?.[c]?.value !== undefined ? String(b[c].value) : ''))),
    );
    return { columns, rows };
  });

  // ─── mergeConcepts — admin curation ────────────────────────────────────
  this.on('mergeConcepts', async (req) => {
    const { loser, canonical } = req.data;
    if (!loser || !canonical) return req.error(400, 'loser and canonical UUIDs required');
    if (loser === canonical) return req.error(400, 'loser and canonical must differ');

    try {
      const counts = await mergeConceptPair({ db, log, loserId: loser, canonicalId: canonical });
      await audit('KnowledgeGraphMergeConcepts', {
        user: req.user?.id ?? 'unknown',
        loser,
        canonical,
        ...counts,
      });
      // Fire-and-forget rebuild so the SPARQL graph reflects the change.
      asyncRebuildAfterCuration('mergeConcepts', {
        user: req.user?.id ?? 'unknown',
        loser,
        canonical,
      });
    } catch (err) {
      log.error(`kg-service: mergeConcepts failed: ${err.message ?? err}`);
      return req.error(500, `Merge failed: ${err.message ?? 'unknown error'}`);
    }
  });

  // ─── previewMerges — dry-run dedupe over ACTIVE concepts ───────────────
  // Thin wrapper around findNearDuplicates: loads every ACTIVE concept (with
  // its cached embedding decoded to Float32Array via the shared
  // kg-concept-loader), runs the same pairwise cosine-similarity scan the
  // weekly consolidator uses, and returns the candidate (loser, canonical,
  // similarity) triples without writing anything. Threshold mirrors the
  // consolidator: KG_MERGE_SIM_THRESHOLD env var (default 0.92).
  this.on('previewMerges', async (req) => {
    let concepts;
    try {
      concepts = await loadConceptsWithEmbeddings(db, log);
    } catch (err) {
      log.error(`kg-service: previewMerges loader failed: ${err.message ?? err}`);
      return req.error(500, `Preview failed: ${err.message ?? 'unknown error'}`);
    }

    const { mergeSimThreshold: threshold } = await resolveKnowledgeGraphSettings();
    const pairs = findNearDuplicates(concepts, threshold);
    log.info(
      `kg-service: previewMerges scanned ${concepts.length} ACTIVE concepts at threshold=${threshold}, found ${pairs.length} candidate pair(s)`,
    );
    await audit('KnowledgeGraphPreviewMerges', {
      user: req.user?.id ?? 'unknown',
      threshold,
      conceptsScanned: concepts.length,
      candidatePairs: pairs.length,
    });

    return pairs.map((p) => ({
      loserId: p.loser.ID,
      loserSlug: p.loser.slug,
      loserName: p.loser.name,
      canonicalId: p.canonical.ID,
      canonicalSlug: p.canonical.slug,
      canonicalName: p.canonical.name,
      // Round to 3 decimals to match the Decimal(4, 3) wire type.
      similarity: Number(p.sim.toFixed(3)),
    }));
  });

  // ─── vetoConcept — admin curation ──────────────────────────────────────
  this.on('vetoConcept', async (req) => {
    const { conceptId } = req.data;
    if (!conceptId) return req.error(400, 'conceptId required');

    const { Concepts } = cds.entities(NAMESPACE);
    try {
      await db.tx(async (tx) => {
        await tx.run(UPDATE(Concepts).set({ status: 'VETOED' }).where({ ID: conceptId }));
      });
      await audit('KnowledgeGraphVetoConcept', {
        user: req.user?.id ?? 'unknown',
        conceptId,
      });
      asyncRebuildAfterCuration('vetoConcept', {
        user: req.user?.id ?? 'unknown',
        conceptId,
      });
    } catch (err) {
      log.error(`kg-service: vetoConcept failed: ${err.message ?? err}`);
      return req.error(500, `Veto failed: ${err.message ?? 'unknown error'}`);
    }
  });

  // ─── vetoEdge — admin curation ─────────────────────────────────────────
  this.on('vetoEdge', async (req) => {
    const { edgeId } = req.data;
    if (!edgeId) return req.error(400, 'edgeId required');

    const { ConceptEdges } = cds.entities(NAMESPACE);
    try {
      await db.tx(async (tx) => {
        await tx.run(UPDATE(ConceptEdges).set({ status: 'VETOED' }).where({ ID: edgeId }));
      });
      await audit('KnowledgeGraphVetoEdge', {
        user: req.user?.id ?? 'unknown',
        edgeId,
      });
      asyncRebuildAfterCuration('vetoEdge', {
        user: req.user?.id ?? 'unknown',
        edgeId,
      });
    } catch (err) {
      log.error(`kg-service: vetoEdge failed: ${err.message ?? err}`);
      return req.error(500, `Veto failed: ${err.message ?? 'unknown error'}`);
    }
  });

  // ─── publishConcept — admin publication marker (bound on Concepts) ─────
  // Bound action: the entity key flows through req.params (one tuple per
  // step in the binding chain). For a Concepts-bound action req.params[0]
  // is the bound row's key object, e.g. { ID: '<uuid>' }. Same pattern as
  // AdminService.Users.clearKhorosLink (srv/admin-service.js:1592).
  this.on('publishConcept', 'Concepts', async (req) => {
    const { Concepts } = cds.entities(NAMESPACE);
    const conceptId = req.params?.[0]?.ID;
    if (!conceptId) return req.reject(400, 'Bound action invoked without entity context');
    const user = req.user?.id ?? 'anonymous';
    const now = new Date().toISOString();
    const count = await UPDATE(Concepts)
      .set({ publishedAt: now, publishedBy: user })
      .where({ ID: conceptId });
    if (!count) return req.reject(404, `Concept ${conceptId} not found`);
  });

  // ─── unpublishConcept — admin publication marker (clear) ───────────────
  this.on('unpublishConcept', 'Concepts', async (req) => {
    const { Concepts } = cds.entities(NAMESPACE);
    const conceptId = req.params?.[0]?.ID;
    if (!conceptId) return req.reject(400, 'Bound action invoked without entity context');
    const count = await UPDATE(Concepts)
      .set({ publishedAt: null, publishedBy: null })
      .where({ ID: conceptId });
    if (!count) return req.reject(404, `Concept ${conceptId} not found`);
  });

  // ─── publishAllConcepts — #1080 bulk publish ───────────────────────────
  //
  // Sets publishedAt=$now, publishedBy=<user> on every ACTIVE Concepts
  // row where publishedAt IS NULL. One UPDATE statement — idempotent
  // (already-published rows filtered out by WHERE). Concept extraction
  // generates ~60/day on DEV; per-row multi-select doesn't scale, so
  // admins get a "publish everything I've reviewed" escape hatch. Spot-
  // review via the isPublished=false filter before invoking.
  //
  // Aggregate audit (KnowledgeGraphPublishAllConcepts) with the row
  // count. Does NOT fan out per-row audit entries — publishConcept
  // itself doesn't audit anyway, and 5k+ per-row events would drown the
  // audit log.
  this.on('publishAllConcepts', async (req) => {
    const { Concepts } = cds.entities(NAMESPACE);
    const user = req.user?.id ?? 'anonymous';
    const now = new Date().toISOString();
    try {
      const publishedCount = await UPDATE(Concepts)
        .set({ publishedAt: now, publishedBy: user })
        .where({ status: 'ACTIVE', publishedAt: null });
      await audit('KnowledgeGraphPublishAllConcepts', {
        user,
        publishedCount: publishedCount ?? 0,
      });
      log.info(
        `kg-service: publishAllConcepts by ${user} — ${publishedCount ?? 0} concepts published`,
      );
      return { publishedCount: publishedCount ?? 0 };
    } catch (err) {
      log.error(`kg-service: publishAllConcepts failed: ${err.message ?? err}`);
      return req.error(500, `Bulk publish failed: ${err.message ?? 'unknown error'}`);
    }
  });

  // ─── triggerGraphRebuild — admin force-rebuild ─────────────────────────
  this.on('triggerGraphRebuild', async (req) => {
    log.info(`kg-service: triggerGraphRebuild by ${req.user?.id ?? 'unknown'}`);
    try {
      const result = await graphRebuild({ db, log });
      await audit('KnowledgeGraphTriggerRebuild', {
        user: req.user?.id ?? 'unknown',
        graphVersion: result.graphVersion,
        tripleCount: result.tripleCount,
        durationMs: result.durationMs,
      });
      // Transform predicateCounts (Map | plain object | array) into the
      // CDS-declared `array of { predicate, count }` shape so OData clients
      // see the per-predicate telemetry instead of having it projected away.
      let predicateCounts;
      if (result.predicateCounts instanceof Map) {
        predicateCounts = [...result.predicateCounts.entries()].map(([predicate, count]) => ({ predicate, count }));
      } else if (Array.isArray(result.predicateCounts)) {
        predicateCounts = result.predicateCounts;
      } else if (result.predicateCounts && typeof result.predicateCounts === 'object') {
        predicateCounts = Object.entries(result.predicateCounts).map(([predicate, count]) => ({ predicate, count }));
      } else {
        predicateCounts = [];
      }
      return {
        graphVersion: result.graphVersion,
        tripleCount: result.tripleCount,
        durationMs: result.durationMs,
        predicateCounts,
      };
    } catch (err) {
      log.error(`kg-service: triggerGraphRebuild failed: ${err.message ?? err}`);
      return req.error(500, `Rebuild failed: ${err.message ?? 'unknown error'}`);
    }
  });
});

// Re-export the parser constant so tests / future inspectors can verify
// the IRI prefix without re-deriving it from the SPARQL template.
export const __HANDLER_TESTING__ = { TUTORIAL_IRI_PREFIX, SLUG_RE };
