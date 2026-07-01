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
import { categoryLabel } from './lib/discovery-mission-categories.js';
import { getTutorialTeachesMap } from './lib/kg-tutorial-teaches-map.js';
import { getCachedNeighborhood, setCachedNeighborhood } from './lib/kg-neighborhood-cache.js';

const NAMESPACE = 'com.sap.developers.ims';

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
    const ranked = rankNeighborhood(rows, slug, coMap, tutorialTeachesMap);

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
        const { LearningJourneys, LearningJourneyConceptLinks, BlogPosts, BlogPostConceptLinks,
          DiscoveryMissions, DiscoveryMissionConceptLinks,
          Videos, VideoConceptLinks,
          ApiDocs, ApiDocConceptLinks,
          Samples, SampleConceptLinks } =
          cds.entities('com.sap.developers.ims.external');

        const conceptRows = await SELECT.from(Concepts)
          .columns('ID', 'slug')
          .where({ slug: { in: teachesSlugs } });
        const conceptIds = conceptRows.map((c) => c.ID);

        if (conceptIds.length > 0) {
          // Step 1: fetch all 6 overlap-link tables in parallel. Each
          // returns Array<{fkID, concept_ID}>. Small rows, cheap network.
          const [journeyLinks, blogLinks, missionLinks, videoLinks, apiDocLinks, sampleLinks] =
            await Promise.all([
              SELECT.from(LearningJourneyConceptLinks)
                .columns('journey_ID', 'concept_ID')
                .where({ concept_ID: { in: conceptIds } }),
              SELECT.from(BlogPostConceptLinks)
                .columns('post_ID', 'concept_ID')
                .where({ concept_ID: { in: conceptIds } }),
              SELECT.from(DiscoveryMissionConceptLinks)
                .columns('mission_ID', 'concept_ID')
                .where({ concept_ID: { in: conceptIds } }),
              SELECT.from(VideoConceptLinks)
                .columns('video_ID', 'concept_ID')
                .where({ concept_ID: { in: conceptIds } }),
              SELECT.from(ApiDocConceptLinks)
                .columns('apiDoc_ID', 'concept_ID')
                .where({ concept_ID: { in: conceptIds } }),
              SELECT.from(SampleConceptLinks)
                .columns('sample_ID', 'concept_ID')
                .where({ concept_ID: { in: conceptIds } }),
            ]);

          // Step 2: JS-side per-corpus overlap tallies (microseconds).
          const tally = (rows, fkField) => {
            const overlapByFk = new Map();
            for (const row of rows) {
              overlapByFk.set(row[fkField], (overlapByFk.get(row[fkField]) ?? 0) + 1);
            }
            const topIds = [...overlapByFk.entries()]
              .sort(([, a], [, b]) => b - a)
              .slice(0, MAX_OTHER_RESOURCES)
              .map(([id]) => id);
            return { overlapByFk, topIds };
          };
          const journeyT  = tally(journeyLinks, 'journey_ID');
          const blogT     = tally(blogLinks,    'post_ID');
          const missionT  = tally(missionLinks, 'mission_ID');
          const videoT    = tally(videoLinks,   'video_ID');
          const apiDocT   = tally(apiDocLinks,  'apiDoc_ID');
          const sampleT   = tally(sampleLinks,  'sample_ID');

          // Step 3: fetch metadata for each top-N set in parallel.
          // Guarded per-corpus: if a corpus has zero overlap we skip its
          // SELECT so the empty-corpus case doesn't cost a round-trip.
          //
          // NOTE on LOB safety (spec §10.1): Videos/ApiDocs/Samples all
          // have LargeString `description` columns — we deliberately
          // exclude them from the projection to keep the sidebar payload
          // scalar-only.
          const [journeys, posts, missions, videos, apiDocs, samples] = await Promise.all([
            journeyT.topIds.length
              ? SELECT.from(LearningJourneys)
                  .columns('ID', 'slug', 'title', 'url', 'level', 'durationHours')
                  .where({ ID: { in: journeyT.topIds } })
              : Promise.resolve([]),
            blogT.topIds.length
              ? SELECT.from(BlogPosts)
                  .columns('ID', 'slug', 'title', 'url', 'authorName', 'postedAt')
                  .where({ ID: { in: blogT.topIds } })
              : Promise.resolve([]),
            missionT.topIds.length
              ? SELECT.from(DiscoveryMissions)
                  .columns('ID', 'slug', 'title', 'url', 'effortLevel', 'categorySlug')
                  .where({ ID: { in: missionT.topIds } })
              : Promise.resolve([]),
            videoT.topIds.length
              ? SELECT.from(Videos)
                  .columns('ID', 'slug', 'title', 'url', 'channelTitle', 'publishedAt', 'thumbnailUrl')
                  .where({ ID: { in: videoT.topIds } })
              : Promise.resolve([]),
            apiDocT.topIds.length
              ? SELECT.from(ApiDocs)
                  .columns('ID', 'slug', 'title', 'url', 'category', 'apiType')
                  .where({ ID: { in: apiDocT.topIds } })
              : Promise.resolve([]),
            sampleT.topIds.length
              ? SELECT.from(Samples)
                  .columns('ID', 'slug', 'title', 'url', 'language', 'stars', 'lastCommitAt')
                  .where({ ID: { in: sampleT.topIds } })
              : Promise.resolve([]),
          ]);

          // Step 4: shape each corpus's rows into the OtherResource wire
          // shape, preserving overlap-count ordering.
          const journeyById = new Map(journeys.map((j) => [j.ID, j]));
          const journeyOtherResources = journeyT.topIds
            .map((id) => journeyById.get(id))
            .filter(Boolean)
            .map((j) => ({
              type: 'learning-journey',
              slug: j.slug, title: j.title, url: j.url,
              level: j.level, durationHours: j.durationHours,
              overlapCount: journeyT.overlapByFk.get(j.ID),
            }));
          const postById = new Map(posts.map((p) => [p.ID, p]));
          const blogOtherResources = blogT.topIds
            .map((id) => postById.get(id))
            .filter(Boolean)
            .map((p) => ({
              type: 'blog-post',
              slug: p.slug, title: p.title, url: p.url,
              authorName: p.authorName, postedAt: p.postedAt,
              overlapCount: blogT.overlapByFk.get(p.ID),
            }));
          const missionById = new Map(missions.map((m) => [m.ID, m]));
          const missionOtherResources = missionT.topIds
            .map((id) => missionById.get(id))
            .filter(Boolean)
            .map((m) => ({
              type: 'discovery-mission',
              slug: m.slug, title: m.title, url: m.url,
              effortLevel: m.effortLevel, categoryLabel: categoryLabel(m.categorySlug),
              overlapCount: missionT.overlapByFk.get(m.ID),
            }));
          const videoById = new Map(videos.map((v) => [v.ID, v]));
          const videoOtherResources = videoT.topIds
            .map((id) => videoById.get(id))
            .filter(Boolean)
            .map((v) => ({
              type: 'video',
              slug: v.slug, title: v.title, url: v.url,
              channelTitle: v.channelTitle, publishedAt: v.publishedAt, thumbnailUrl: v.thumbnailUrl,
              overlapCount: videoT.overlapByFk.get(v.ID),
            }));
          const apiDocById = new Map(apiDocs.map((a) => [a.ID, a]));
          const apiDocOtherResources = apiDocT.topIds
            .map((id) => apiDocById.get(id))
            .filter(Boolean)
            .map((a) => ({
              type: 'api-doc',
              slug: a.slug, title: a.title, url: a.url,
              category: a.category, apiType: a.apiType,
              overlapCount: apiDocT.overlapByFk.get(a.ID),
            }));
          const sampleById = new Map(samples.map((s) => [s.ID, s]));
          const sampleOtherResources = sampleT.topIds
            .map((id) => sampleById.get(id))
            .filter(Boolean)
            .map((s) => ({
              type: 'sample',
              slug: s.slug, title: s.title, url: s.url,
              language: s.language, stars: s.stars, lastCommitAt: s.lastCommitAt,
              overlapCount: sampleT.overlapByFk.get(s.ID),
            }));

          // Step 5: merge + cap top-5 across all 6 types.
          otherResources = mergeOtherResources(
            journeyOtherResources,
            blogOtherResources,
            missionOtherResources,
            videoOtherResources,
            apiDocOtherResources,
            sampleOtherResources,
          );

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

  // ─── pathBetween — Phase 2 stub ────────────────────────────────────────
  this.on('pathBetween', async (req) => {
    const { fromSlug, toSlug } = req.data;
    log.warn(`kg-service: pathBetween(${fromSlug} → ${toSlug}) — Phase 2 stub, returning []`);
    return [];
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

  // ─── runSparql — admin raw SPARQL passthrough ──────────────────────────
  this.on('runSparql', async (req) => {
    const { query } = req.data;
    if (typeof query !== 'string' || query.length === 0) {
      return req.error(400, 'Query required');
    }
    if (query.length > 8 * 1024) {
      return req.error(400, 'Query too long (max 8KB)');
    }

    const truncatedForLog = query.length > 1024 ? query.slice(0, 1024) + '…' : query;
    const isUpdate = detectUpdate(query);
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
