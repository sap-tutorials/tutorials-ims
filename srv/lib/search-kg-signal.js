// srv/lib/search-kg-signal.js
//
// Server-side KG signal for search rank blending (#945). One helper serves
// two callers:
//
//   1. SearchService.before('READ') on /search/SearchableItems — appends
//      `+ 2.0 * CASE slug WHEN ... END` to the _searchRank CASE expression
//      so DB-side ordering blends fuzzy match score with KG concept overlap.
//   2. searchTutorials Joule tool in chat-orchestrator.js — attaches
//      per-hit `rationale` strings from the same cache entry so the LLM
//      sees a pre-ranked, pre-annotated result list in one signal.
//
// Both entry points share a single in-process LRU cache keyed by the
// lowercased+trimmed query. A single-flight promise map prevents embed-storms
// when two concurrent requests share the same query.
//
// The KG algorithm itself (embed → cosine → 1-hop edge walk → link fetch →
// per-tutorial aggregate) is unchanged from srv/lib/kg/joule-tool-expand-concepts.js.
// DB fetch helpers live in srv/lib/kg/_search-fetches.js and are imported by
// both files so the two paths stay in lock-step.
//
// Rank formula:
//     final_rank = existing_fuzzy_rank + KG_WEIGHT * kg_score
// where KG_WEIGHT = 2.0 (fixed) and kg_score is Σ(concept_score × link_confidence).

import { embed as embedInputs } from './embedding-client.js';
import { topConceptsByCosine } from './kg/concept-embedding-query.js';
import { fetchEdges, fetchConceptsByIds, fetchLinks } from './kg/_search-fetches.js';
import * as metrics from './metrics.js';
import cds from '@sap/cds';

const LOG = cds.log('search-kg-signal');

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// Blend weight — the KG contribution factor for the additive rank term.
// 2.0 places a strong KG match (score ~1.0) between description (2) and
// title (3) hits, so KG can rescue a semantically relevant tutorial that
// misses on keywords while never dominating a title match.
export const KG_WEIGHT = 2.0;

// Max concepts to seed / walk-out from. Matches the expandSearchConcepts tool
// default so the two paths return the same-shaped concept universe.
const MAX_SEED_CONCEPTS = 5;

// Wall-clock cap on the whole signal computation (embed + cosine + walk +
// link fetch). If exceeded, an empty signal is returned and the search
// falls through to fuzzy-only ranking.
const DEFAULT_TIMEOUT_MS = 5000;

// LRU cache config.
const CACHE_MAX_ENTRIES = 500;
const CACHE_TTL_MS = 5 * 60 * 1000;              // Successful signals
const CACHE_TTL_EMPTY_MS = 60 * 1000;            // Empty / zero-concept results (shorter TTL — data may fill in)

// Concept-to-tutorial walk boost (mirrors joule-tool-expand-concepts.js).
const WALK_BOOST = 0.5;

// ---------------------------------------------------------------------------
// LRU cache (Map insertion-order = LRU order)
// ---------------------------------------------------------------------------

const cache = new Map();          // key → { signal, expiresAt }
const inFlight = new Map();       // key → Promise<signal>  (single-flight)

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  // Refresh LRU order.
  cache.delete(key);
  cache.set(key, entry);
  return entry.signal;
}

function cachePut(key, signal, ttlMs) {
  cache.set(key, { signal, expiresAt: Date.now() + ttlMs });
  // Evict oldest entries until we're back under cap.
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

/** Reset internal state — test-only. */
export function _resetForTest() {
  cache.clear();
  inFlight.clear();
  _testEmbedClient = null;
}

/**
 * Install a global embed-client override for tests. Bypasses AI Core so
 * cds.test('serve') suites can exercise the SearchService blend path without
 * a real service binding. When set, replaces the default `embedInputs` call
 * inside _computeUncached for every future call, regardless of whether the
 * caller passes an `embedClient` argument. Pair with `_resetForTest()` in
 * `beforeAll`/`afterAll` to avoid cross-test leakage.
 */
let _testEmbedClient = null;
export function _setTestEmbedClient(client) {
  _testEmbedClient = client;
}

// ---------------------------------------------------------------------------
// Signal shape (returned to callers)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} KgSignal
 * @property {Map<string, number>}  slugScores      slug → aggregate KG score (~0..1.5)
 * @property {Map<string, string>}  slugRationale   slug → "Teaches A and B"
 * @property {Map<string, string>}  slugTitle       slug → tutorial title (added #1111 so
 *                                                  expandSearchConcepts can reuse the
 *                                                  cached signal without a second DB round-trip)
 * @property {Array<{slug:string,name:string,score:number}>} topConcepts
 * @property {number}               computedAt      ms epoch
 * @property {number}               latencyMs
 * @property {string=}              warning         'timeout' | 'embed_failed' | 'db_error' | 'kg_empty' | 'disabled'
 */

const EMPTY_SIGNAL = Object.freeze({
  slugScores: new Map(),
  slugRationale: new Map(),
  slugTitle: new Map(),
  topConcepts: [],
});

function makeEmpty(warning) {
  return {
    slugScores: new Map(),
    slugRationale: new Map(),
    slugTitle: new Map(),
    topConcepts: [],
    computedAt: Date.now(),
    latencyMs: 0,
    ...(warning ? { warning } : {}),
  };
}

/**
 * Return the cached signal for `phrase` without computing anything.
 * Used by callers that DON'T want to trigger an embed (e.g. the Joule blend
 * runs AFTER the OData path has already populated the cache in the same turn).
 * Returns null when there's no live cache entry.
 */
export function peekSignal(phrase) {
  const key = normalizeKey(phrase);
  if (!key) return null;
  return cacheGet(key);
}

function normalizeKey(phrase) {
  if (typeof phrase !== 'string') return null;
  const trimmed = phrase.trim().toLowerCase();
  return trimmed || null;
}

// ---------------------------------------------------------------------------
// Public: compute + cache
// ---------------------------------------------------------------------------

/**
 * Compute the KG signal for a query phrase, using cache + single-flight.
 *
 * @param {object} opts
 * @param {string} opts.phrase              raw user query (whitespace/case OK)
 * @param {object} opts.db                  CDS db handle (SQLite or HANA)
 * @param {object=} opts.embedClient        override for tests: { embed(text) => Promise<Float32Array> }
 * @param {string=} opts.embeddingModel     embedding model name (resolved upstream via resolveEmbeddingSettings)
 * @param {boolean=} opts.enabled           flag — when false, returns empty signal without any work
 * @param {number=} opts.timeoutMs          wall-clock cap (default 5000)
 * @returns {Promise<KgSignal>}
 */
export async function computeKgSignal({
  phrase,
  db,
  embedClient,
  embeddingModel,  // resolved upstream via resolveEmbeddingSettings()
  enabled = true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!enabled) return makeEmpty('disabled');
  const key = normalizeKey(phrase);
  if (!key) return makeEmpty();

  const cached = cacheGet(key);
  if (cached) {
    metrics.counter('search.kg.cache.hit');
    return cached;
  }
  metrics.counter('search.kg.cache.miss');

  // Single-flight — coalesce concurrent identical calls onto one embed.
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = _computeUncached({ key, phrase: key, db, embedClient, embeddingModel, timeoutMs })
    .catch((err) => {
      LOG.warn('computeKgSignal failed', err.message);
      metrics.counter('search.kg.error');
      return makeEmpty('db_error');
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

async function _computeUncached({ key, phrase, db, embedClient, embeddingModel, timeoutMs }) {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('search-kg-signal timeout')), timeoutMs);
  const timedOut = () => Date.now() >= deadline;

  try {
    // ---- 1. Embed the query.
    let queryVector;
    try {
      const clientToUse = embedClient || _testEmbedClient;
      if (clientToUse) {
        queryVector = await clientToUse.embed(phrase, { signal: abort.signal });
      } else {
        const [v] = await embedInputs([phrase], embeddingModel);
        queryVector = v;
      }
    } catch (err) {
      if (abort.signal.aborted) {
        const empty = makeEmpty('timeout');
        empty.latencyMs = Date.now() - t0;
        cachePut(key, empty, CACHE_TTL_EMPTY_MS);
        metrics.observe('search.kg.rerank.ms', empty.latencyMs);
        return empty;
      }
      LOG.warn('search-kg-signal embed failed', err.message);
      metrics.counter('search.kg.error');
      // Do NOT cache non-timeout embed failures — transient errors deserve retry.
      const empty = makeEmpty('embed_failed');
      empty.latencyMs = Date.now() - t0;
      metrics.observe('search.kg.rerank.ms', empty.latencyMs);
      return empty;
    }
    if (timedOut()) return _finalizeTimeout({ key, t0 });

    // ---- 2. Top-N cosine over Concepts.embedding (publish gate inside helper).
    const seeds = await topConceptsByCosine({ db, queryVector, limit: MAX_SEED_CONCEPTS });
    if (timedOut()) return _finalizeTimeout({ key, t0 });
    if (!seeds || seeds.length === 0) {
      const empty = makeEmpty('kg_empty');
      empty.latencyMs = Date.now() - t0;
      cachePut(key, empty, CACHE_TTL_EMPTY_MS);
      metrics.observe('search.kg.rerank.ms', empty.latencyMs);
      metrics.gauge('search.kg.tutorial_count', 0);
      return empty;
    }

    // ---- 3. 1-hop walk on ConceptEdges (requires, relatedTo).
    const seedById = new Map(seeds.map((s) => [s.id, s]));
    const edges = await fetchEdges(db, seeds.map((s) => s.id));
    if (timedOut()) return _finalizeTimeout({ key, t0 });

    const boosted = new Map(seeds.map((s) => [s.id, { ...s }]));
    const neighbourIds = new Set();
    for (const e of edges) {
      // Don't re-boost a seed that happens to be another seed's target.
      if (boosted.has(e.target_id) && seedById.has(e.target_id)) continue;
      const src = seedById.get(e.source_id);
      if (!src) continue;
      const boost = WALK_BOOST * src.score * (Number(e.confidence) || 0);
      neighbourIds.add(e.target_id);
      const existing = boosted.get(e.target_id);
      if (existing) {
        existing.score = Math.max(existing.score, boost);
      } else {
        boosted.set(e.target_id, { id: e.target_id, score: boost });
      }
    }

    // Hydrate neighbour metadata (publish gate applies again — drops non-ACTIVE).
    if (neighbourIds.size > 0) {
      const hydrated = await fetchConceptsByIds(db, [...neighbourIds]);
      if (timedOut()) return _finalizeTimeout({ key, t0 });
      const hydratedMap = new Map(hydrated.map((h) => [h.id, h]));
      for (const id of neighbourIds) {
        const meta = hydratedMap.get(id);
        const entry = boosted.get(id);
        if (!meta) { boosted.delete(id); continue; }
        entry.slug = meta.slug;
        entry.name = meta.name;
      }
    }

    const allConcepts = [...boosted.values()]
      .filter((c) => c.slug && c.name)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SEED_CONCEPTS);

    if (allConcepts.length === 0) {
      const empty = makeEmpty('kg_empty');
      empty.latencyMs = Date.now() - t0;
      cachePut(key, empty, CACHE_TTL_EMPTY_MS);
      metrics.observe('search.kg.rerank.ms', empty.latencyMs);
      metrics.gauge('search.kg.tutorial_count', 0);
      return empty;
    }

    // ---- 4. Join TutorialConceptLinks; aggregate per tutorial.
    const links = await fetchLinks(db, allConcepts.map((c) => c.id));
    if (timedOut()) return _finalizeTimeout({ key, t0 });

    const conceptScoreById = new Map(allConcepts.map((c) => [c.id, c.score]));
    const conceptNameById = new Map(allConcepts.map((c) => [c.id, c.name]));

    const perTutorial = new Map(); // tutorial_id → { slug, title, score, contribs: [{ conceptId, contribution }] }
    for (const l of links) {
      const cs = conceptScoreById.get(l.concept_id) ?? 0;
      const contribution = cs * (Number(l.confidence) || 0);
      let bucket = perTutorial.get(l.tutorial_id);
      if (!bucket) {
        bucket = { slug: l.tutorial_slug, title: l.title, score: 0, contribs: [] };
        perTutorial.set(l.tutorial_id, bucket);
      }
      bucket.score += contribution;
      bucket.contribs.push({ conceptId: l.concept_id, contribution });
    }

    // ---- 5. Build slugScores + slugRationale + slugTitle maps.
    const slugScores = new Map();
    const slugRationale = new Map();
    const slugTitle = new Map();
    for (const bucket of perTutorial.values()) {
      if (!bucket.slug || typeof bucket.slug !== 'string') continue;
      slugScores.set(bucket.slug, Number(bucket.score.toFixed(4)));
      if (bucket.title) slugTitle.set(bucket.slug, bucket.title);

      const topTwo = bucket.contribs
        .sort((x, y) => y.contribution - x.contribution)
        .slice(0, 2)
        .map((c) => conceptNameById.get(c.conceptId))
        .filter(Boolean);
      const rationale = topTwo.length === 0
        ? ''
        : topTwo.length === 1
          ? `Teaches ${topTwo[0]}`
          : `Teaches ${topTwo[0]} and ${topTwo[1]}`;
      if (rationale) slugRationale.set(bucket.slug, rationale);
    }

    const signal = {
      slugScores,
      slugRationale,
      slugTitle,
      topConcepts: allConcepts.map((c) => ({
        slug: c.slug,
        name: c.name,
        score: Number(c.score.toFixed(4)),
      })),
      computedAt: Date.now(),
      latencyMs: Date.now() - t0,
    };

    cachePut(key, signal, CACHE_TTL_MS);
    metrics.observe('search.kg.rerank.ms', signal.latencyMs);
    metrics.gauge('search.kg.tutorial_count', slugScores.size);
    return signal;
  } finally {
    clearTimeout(timer);
  }
}

function _finalizeTimeout({ key, t0 }) {
  const empty = makeEmpty('timeout');
  empty.latencyMs = Date.now() - t0;
  cachePut(key, empty, CACHE_TTL_EMPTY_MS);
  metrics.observe('search.kg.rerank.ms', empty.latencyMs);
  return empty;
}

// ---------------------------------------------------------------------------
// SQL fragment builder — inline CASE-WHEN emitted into search-service.js rank.
// ---------------------------------------------------------------------------

// Slugs that reach the SQL fragment are DB-constrained to lowercase kebab
// (`Tutorials.slug` via `_tutorials-table.js`). This regex is a defence-in-depth
// check — if a bad slug ever appears in `slugScores`, we skip it rather than
// trust the DB layer. Never inlines a slug with quotes / percents / backslashes.
const SAFE_SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Build the `+ KG_WEIGHT * (case slug when 'x' then 0.8100 ... else 0 end)`
 * SQL fragment for insertion into the _searchRank CASE expression.
 *
 * Returns an empty string when there's nothing to add (empty signal, all
 * slugs rejected by the sanitizer). Callers concatenate the return value
 * directly into their rank SQL string.
 *
 * @param {KgSignal} signal
 * @returns {string} SQL fragment (or '' when no KG contribution)
 */
export function buildKgRankFragment(signal) {
  if (!signal || !signal.slugScores || signal.slugScores.size === 0) return '';
  const parts = [];
  for (const [slug, score] of signal.slugScores) {
    if (typeof slug !== 'string' || !SAFE_SLUG_RE.test(slug)) continue;
    // Score already Number.toFixed(4)'d at signal-build time; belt-and-braces here.
    const s = Number(score);
    if (!Number.isFinite(s) || s <= 0) continue;
    parts.push(`when '${slug}' then ${s.toFixed(4)}`);
  }
  if (parts.length === 0) return '';
  return `+ ${KG_WEIGHT.toFixed(2)} * (case slug ${parts.join(' ')} else 0 end)`;
}
