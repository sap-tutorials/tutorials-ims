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
 * @returns {{teaches:Array, prerequisitesOf:Array, sharedConcepts:Array, whatToLearnNext:Array}}
 *   - teaches items:           { slug, name }
 *   - tutorial-targeted items: { slug, weight, reason }
 *     (`title` is left undefined; the handler enriches via Tutorials.title)
 */
export function rankNeighborhood(rows, slug, coCompletionMap, tutorialTeachesMap) {
  const coMap = coCompletionMap instanceof Map ? coCompletionMap : new Map();

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
  // Stable lex order — teaches has no other ranking signal in Phase 1.
  teaches.sort((a, b) => a.slug.localeCompare(b.slug));

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

  // prerequisitesOf — already weight-bound by SPARQL (0.9). Sort by weight
  // desc, then slug.
  const prerequisitesOf = [];
  for (const [targetSlug, row] of buckets.prerequisitesOf) {
    prerequisitesOf.push(makeTutItem('prerequisitesOf', targetSlug, row));
  }
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
  sharedConcepts.sort((a, b) => (b.weight - a.weight) || a.slug.localeCompare(b.slug));

  // whatToLearnNext — boost by coCompletion. Sort by boosted weight desc,
  // then slug.
  const whatToLearnNext = [];
  for (const [targetSlug, row] of buckets.whatToLearnNext) {
    const base = makeTutItem('whatToLearnNext', targetSlug, row);
    const boost = coCompletionBoost(coMap.get(targetSlug));
    base.weight = base.weight * boost;
    whatToLearnNext.push(base);
  }
  whatToLearnNext.sort((a, b) => (b.weight - a.weight) || a.slug.localeCompare(b.slug));

  // Cap each group at TOP_N.
  return {
    teaches:         teaches.slice(0, TOP_N),
    prerequisitesOf: prerequisitesOf.slice(0, TOP_N),
    sharedConcepts:  sharedConcepts.slice(0, TOP_N),
    whatToLearnNext: whatToLearnNext.slice(0, TOP_N),
  };
}

// Re-exported for the (next-dispatch) handler to consume without re-deriving.
export const _internals = { GROUP_KEYS, TOP_N, DEFAULT_WEIGHT, coCompletionBoost, isFullySubset };
