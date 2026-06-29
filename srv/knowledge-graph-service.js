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
import { computeCoCompletions } from './lib/co-completion.js';
import { mergeConceptPair } from './lib/kg-merge-pair.js';
import { findNearDuplicates } from './lib/kg-similarity.js';
import { loadConceptsWithEmbeddings } from './lib/kg-concept-loader.js';
import { resolveKnowledgeGraphSettings } from './lib/runtime-config/kg-settings.js';
import { mergeOtherResources, MAX_OTHER_RESOURCES } from './lib/kg-neighborhood-merge.js';
import { categoryLabel } from './lib/discovery-mission-categories.js';

const NAMESPACE = 'com.sap.developers.ims';

// SPARQL response IRI prefix for tutorials (from kg-projection.js +
// kg-queries.js). The neighborhood query already strips this via
// REPLACE(STR(?iri), prefix, '') BIND, but we hold the constant here for
// the parseNeighborhoodSparqlResponse helper if a caller passes a row
// where the BIND was skipped (e.g. the teaches branch carries a Concept
// IRI in the pre-bind variable).
const TUTORIAL_IRI_PREFIX = 'https://developers.sap.com/kg/tutorial/';

// Bound on the in-memory tutorialTeachesMap built per-request. Refer to
// the comment in `neighborhood` for the cardinality estimate.
const MAX_TEACHES_MAP_ROWS = 200_000;

// LRU cache (graphVersion-aware). The plan calls for one keyed by
// `${slug}:${graphVersion}` so repeated reads of the same tutorial avoid
// the SPARQL+co-completion+title-join round-trip. lru-cache is NOT a
// project dependency yet, so the read path is a TODO — capture the cache
// shape inline so swapping in lru-cache is a one-liner once Tom approves
// adding the dep.
//
// TODO(#381 PR 6): wire `lru-cache` here once added to package.json. Cache
// key: `${slug}:${graphVersion}` (so `graphRebuild` invalidates by minting
// a fresh ULID). Suggested size: 500 entries / 5MB. For now: zero caching;
// every read pays the full cost.
const _NEIGHBORHOOD_CACHE = null;

function isHana(db) {
  return db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
}

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
 * Build a Map<tutorialSlug, Set<conceptSlug>> for the subset-suppression
 * pass in the ranker. One row per (tutorial, concept) teaches link.
 *
 * Cost: one SQL round-trip; current dataset is ~1.4k tutorials × <10
 * concepts ≈ 14k rows. The MAX_TEACHES_MAP_ROWS guard logs a warning if
 * the result set ever explodes, so PR 6 can revisit caching at that
 * point. Returns an empty Map if the join is empty (cold start).
 */
async function buildTutorialTeachesMap(db, log) {
  const rows = isHana(db)
    ? await db.run(
        `SELECT t."SLUG" AS "TUT_SLUG", c."SLUG" AS "CONCEPT_SLUG"
         FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS" l
         JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t ON t."ID" = l."TUTORIAL_ID"
         JOIN "COM_SAP_DEVELOPERS_IMS_CONCEPTS" c   ON c."ID" = l."CONCEPT_ID"
         WHERE l."PREDICATE" = 'teaches' AND c."STATUS" = 'ACTIVE'`,
      )
    : await (async () => {
        const { TutorialConceptLinks, Tutorials, Concepts } = cds.entities(NAMESPACE);
        // SQLite test path: small enough that a 3-way fetch+join in JS is fine.
        const links = await SELECT.from(TutorialConceptLinks)
          .columns('tutorial_ID', 'concept_ID')
          .where({ predicate: 'teaches' });
        const tutIds = [...new Set(links.map((l) => l.tutorial_ID).filter(Boolean))];
        const conceptIds = [...new Set(links.map((l) => l.concept_ID).filter(Boolean))];
        const [tuts, concepts] = await Promise.all([
          tutIds.length
            ? SELECT.from(Tutorials).columns('ID', 'slug').where({ ID: { in: tutIds } })
            : Promise.resolve([]),
          conceptIds.length
            ? SELECT.from(Concepts).columns('ID', 'slug', 'status').where({ ID: { in: conceptIds }, status: 'ACTIVE' })
            : Promise.resolve([]),
        ]);
        const tutSlug = new Map(tuts.map((t) => [t.ID, t.slug]));
        const conSlug = new Map(concepts.map((c) => [c.ID, c.slug]));
        return links.map((l) => ({
          TUT_SLUG: tutSlug.get(l.tutorial_ID),
          CONCEPT_SLUG: conSlug.get(l.concept_ID),
        }));
      })();

  const map = new Map();
  let count = 0;
  for (const r of rows) {
    const tut = r.TUT_SLUG ?? r.tut_slug;
    const con = r.CONCEPT_SLUG ?? r.concept_slug;
    if (!tut || !con) continue;
    if (++count > MAX_TEACHES_MAP_ROWS) {
      log.warn(
        `kg-service: tutorialTeachesMap exceeded ${MAX_TEACHES_MAP_ROWS} rows; truncating — PR 6 should add caching`,
      );
      break;
    }
    if (!map.has(tut)) map.set(tut, new Set());
    map.get(tut).add(con);
  }
  return map;
}

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

    // 3. (Cache lookup would happen here — see _NEIGHBORHOOD_CACHE TODO.)

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

    // 7. Load co-completion map for whatToLearnNext boost.
    let coMap = new Map();
    try {
      const coCompletions = await computeCoCompletions();
      coMap = new Map((coCompletions[slug] ?? []).map((e) => [e.slug, e.score]));
    } catch (err) {
      log.warn(`kg-service: computeCoCompletions failed (${err.message ?? err}); proceeding without boost`);
    }

    // 8. Build tutorial-teaches map for sharedConcepts subset suppression.
    let tutorialTeachesMap;
    try {
      tutorialTeachesMap = await buildTutorialTeachesMap(db, log);
    } catch (err) {
      log.warn(`kg-service: buildTutorialTeachesMap failed (${err.message ?? err}); proceeding without subset suppression`);
      tutorialTeachesMap = undefined;
    }

    // 9. Run the pure ranker.
    const ranked = rankNeighborhood(rows, slug, coMap, tutorialTeachesMap);

    // 10. Enrich tutorial-targeted items with title from Tutorials table.
    //     ALSO: drop items whose target tutorial doesn't exist or is marked
    //     non-ACTIVE. The KG can hold stale references when a tutorial is
    //     unpublished without invalidating downstream concept links —
    //     verified 2026-06-22 on DEV, slug
    //     `devtoberfest-2025-create-business-configuration-maintenance-object`
    //     was referenced by neighborhood() but had zero rows in Tutorials,
    //     so the sidebar surfaced a slug-as-title link with no destination.
    //     Filtering here keeps the UI clean and the slug→404 trap closed.
    const candidateSlugs = new Set();
    for (const item of ranked.prerequisitesOf) candidateSlugs.add(item.slug);
    for (const item of ranked.sharedConcepts)  candidateSlugs.add(item.slug);
    for (const item of ranked.whatToLearnNext) candidateSlugs.add(item.slug);

    let titleBySlug = new Map();
    if (candidateSlugs.size > 0) {
      const titleRows = await SELECT.from(Tutorials)
        .columns('slug', 'title', 'status')
        .where({ slug: { in: [...candidateSlugs] } });
      titleBySlug = buildLiveTitleMap(titleRows);
    }
    const enrich = (arr) => enrichLiveTutorials(arr, titleBySlug);

    // 10b. Look up which teaches[] concepts are currently published so the
    //      sidebar island can render <a> vs <span> per concept (PR 2/3).
    const teachesSlugs = ranked.teaches.map((c) => c.slug);
    let publishedSet = new Set();
    if (teachesSlugs.length) {
      const { Concepts } = cds.entities(NAMESPACE);
      const rows = await SELECT.from(Concepts)
        .columns('slug')
        .where({ slug: { in: teachesSlugs }, publishedAt: { '!=': null }, status: 'ACTIVE' });
      publishedSet = new Set(rows.map((r) => r.slug));
    }

    // Phase 4.1 (#447 §2.6): enrich otherResources with learning journeys
    // covering any concept the tutorial teaches. Ranked by overlap count.
    // Phase 4.2 (#447 §9): also widens to include blog-post overlap rows.
    // Phase 4.3 (#447 §8): also widens to include discovery-mission overlap
    // rows. All three arrays merge and cap top-5 total across types (no
    // per-type diversity quota).
    //
    // Implementation choices:
    // - Resolve teaches→concept_ID first (so we can filter the link table by
    //   FK rather than by deep-association — sidesteps CDS QL deep-assoc
    //   quirks on SQLite the plan flagged for Task 2).
    // - JS-side group-by + sort; fewer round trips than per-journey rank.
    // - Graceful fallback to empty array on any error.
    let otherResources = [];
    try {
      const teachesSlugs = ranked.teaches.map((c) => c.slug);
      let journeyOtherResources = [];
      let blogOtherResources = [];
      let missionOtherResources = [];
      let videoOtherResources = [];
      if (teachesSlugs.length > 0) {
        const { LearningJourneys, LearningJourneyConceptLinks, BlogPosts, BlogPostConceptLinks,
          DiscoveryMissions, DiscoveryMissionConceptLinks,
          Videos, VideoConceptLinks } =
          cds.entities('com.sap.developers.ims.external');
        const { Concepts } = cds.entities(NAMESPACE);

        const conceptRows = await SELECT.from(Concepts)
          .columns('ID', 'slug')
          .where({ slug: { in: teachesSlugs } });
        const conceptIds = conceptRows.map((c) => c.ID);

        if (conceptIds.length > 0) {
          const overlapRows = await SELECT.from(LearningJourneyConceptLinks)
            .columns('journey_ID', 'concept_ID')
            .where({ concept_ID: { in: conceptIds } });

          const overlapByJourney = new Map();
          for (const row of overlapRows) {
            overlapByJourney.set(
              row.journey_ID,
              (overlapByJourney.get(row.journey_ID) ?? 0) + 1
            );
          }

          if (overlapByJourney.size > 0) {
            const topJourneyIds = [...overlapByJourney.entries()]
              .sort(([, a], [, b]) => b - a)
              .slice(0, MAX_OTHER_RESOURCES)
              .map(([id]) => id);

            const journeys = await SELECT.from(LearningJourneys)
              .columns('ID', 'slug', 'title', 'url', 'level', 'durationHours')
              .where({ ID: { in: topJourneyIds } });

            const byId = new Map(journeys.map((j) => [j.ID, j]));
            // Preserve overlap-count ordering (the SELECT may return rows
            // in a different order than topJourneyIds).
            journeyOtherResources = topJourneyIds
              .map((id) => byId.get(id))
              .filter(Boolean)
              .map((j) => ({
                type: 'learning-journey',
                slug: j.slug,
                title: j.title,
                url: j.url,
                level: j.level,
                durationHours: j.durationHours,
                overlapCount: overlapByJourney.get(j.ID),
              }));
          }

          // Phase 4.2 (#447): blog-post overlap rows.
          const blogOverlaps = await SELECT.from(BlogPostConceptLinks)
            .columns('post_ID', 'concept_ID')
            .where({ concept_ID: { in: conceptIds } });

          const overlapByPost = new Map();
          for (const row of blogOverlaps) {
            overlapByPost.set(row.post_ID, (overlapByPost.get(row.post_ID) ?? 0) + 1);
          }

          if (overlapByPost.size > 0) {
            const topPostIds = [...overlapByPost.entries()]
              .sort(([, a], [, b]) => b - a)
              .slice(0, MAX_OTHER_RESOURCES)
              .map(([id]) => id);

            const posts = await SELECT.from(BlogPosts)
              .columns('ID', 'slug', 'title', 'url', 'authorName', 'postedAt')
              .where({ ID: { in: topPostIds } });

            const byPostId = new Map(posts.map((p) => [p.ID, p]));
            blogOtherResources = topPostIds
              .map((id) => byPostId.get(id))
              .filter(Boolean)
              .map((p) => ({
                type: 'blog-post',
                slug: p.slug,
                title: p.title,
                url: p.url,
                authorName: p.authorName,
                postedAt: p.postedAt,
                overlapCount: overlapByPost.get(p.ID),
              }));
          }

          // Phase 4.3 (#447): discovery-mission overlap rows.
          const missionOverlaps = await SELECT.from(DiscoveryMissionConceptLinks)
            .columns('mission_ID', 'concept_ID')
            .where({ concept_ID: { in: conceptIds } });

          const overlapByMission = new Map();
          for (const row of missionOverlaps) {
            overlapByMission.set(
              row.mission_ID,
              (overlapByMission.get(row.mission_ID) ?? 0) + 1
            );
          }

          if (overlapByMission.size > 0) {
            const topMissionIds = [...overlapByMission.entries()]
              .sort(([, a], [, b]) => b - a)
              .slice(0, MAX_OTHER_RESOURCES)
              .map(([id]) => id);

            const missions = await SELECT.from(DiscoveryMissions)
              .columns('ID', 'slug', 'title', 'url', 'effortLevel', 'categorySlug')
              .where({ ID: { in: topMissionIds } });

            const byMissionId = new Map(missions.map((m) => [m.ID, m]));
            missionOtherResources = topMissionIds
              .map((id) => byMissionId.get(id))
              .filter(Boolean)
              .map((m) => ({
                type: 'discovery-mission',
                slug: m.slug,
                title: m.title,
                url: m.url,
                effortLevel: m.effortLevel,
                categoryLabel: categoryLabel(m.categorySlug),
                overlapCount: overlapByMission.get(m.ID),
              }));
          }

          // Phase 4.4 (#447): video overlap rows.
          // NOTE: Videos.description is LargeString (NCLOB) — DO NOT include
          // it here. The sidebar payload only needs scalar metadata.
          const videoOverlaps = await SELECT.from(VideoConceptLinks)
            .columns('video_ID', 'concept_ID')
            .where({ concept_ID: { in: conceptIds } });

          const overlapByVideo = new Map();
          for (const row of videoOverlaps) {
            overlapByVideo.set(
              row.video_ID,
              (overlapByVideo.get(row.video_ID) ?? 0) + 1
            );
          }

          if (overlapByVideo.size > 0) {
            const topVideoIds = [...overlapByVideo.entries()]
              .sort(([, a], [, b]) => b - a)
              .slice(0, MAX_OTHER_RESOURCES)
              .map(([id]) => id);

            const videos = await SELECT.from(Videos)
              .columns('ID', 'slug', 'title', 'url', 'channelTitle', 'publishedAt', 'thumbnailUrl')
              .where({ ID: { in: topVideoIds } });

            const byVideoId = new Map(videos.map((v) => [v.ID, v]));
            videoOtherResources = topVideoIds
              .map((id) => byVideoId.get(id))
              .filter(Boolean)
              .map((v) => ({
                type: 'video',
                slug: v.slug,
                title: v.title,
                url: v.url,
                channelTitle: v.channelTitle,
                publishedAt: v.publishedAt,
                thumbnailUrl: v.thumbnailUrl,
                overlapCount: overlapByVideo.get(v.ID),
              }));
          }
        }
      }

      // Merge journey + blog + mission + video rows; sort by overlap desc;
      // cap top-5 TOTAL. Top-5 is across ALL FOUR types (no per-type diversity
      // quota) per spec §9. Phase 4.4 widens to a 4-array merge — the
      // mergeOtherResources helper is already variadic (Phase 4.3 widening).
      otherResources = mergeOtherResources(
        journeyOtherResources,
        blogOtherResources,
        missionOtherResources,
        videoOtherResources,
      );
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
    };

    // 11. (Cache-store would happen here — see _NEIGHBORHOOD_CACHE TODO.)
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
