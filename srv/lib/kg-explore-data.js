// srv/lib/kg-explore-data.js
//
// Pure helper that builds the /graph/explore-data payload — the same
// JSON shape inlined into the /explore/ Hugo page for first-paint
// hydration of the Sigma.js graph.
//
// Issue #446, Phase 3 Track 3-B PR 4/9.
// Spec: docs/superpowers/specs/2026-06-27-446-knowledge-graph-phase3-design.md
//
// Why a separate helper from build-explore-data.js:
// - kg-explore-data.js is the PURE function: input = a CDS db service,
//   output = { nodes, edges, generatedAt }. No Express, no cache, no
//   logging side-effects. Trivially unit-testable by mocking kgQuery().
// - build-explore-data.js is the Express handler wrapper: TTL cache,
//   500 response on error, response logging.
//
// Entity type derivation:
// The projection in srv/lib/kg-projection.js emits explicit rdf:type only
// for Concepts. Tutorials/Missions/Groups/Products/Categories/Tags carry
// no type triple — their entity-type is encoded in the IRI prefix (e.g.
// .../tutorial/X → Tutorial). This helper derives type from the IRI prefix.

import { kgQuery } from './kg-sparql-client.js';
import { KG_IRI_PREFIXES } from './kg-projection.js';

const KG_PREFIX = 'https://developers.sap.com/kg/';

// Short node-id prefixes used to disambiguate the per-type graph nodes
// in {id} (e.g. 't:cap-handlers' vs 'c:cap-handlers'). Kept here because
// they're a presentation concern of the explore endpoint, not part of the
// canonical IRI registry in kg-projection.js.
//
// Exported so a lockstep test in kg-explore-data-iri-types.test.js can
// assert this map stays in sync with KG_IRI_PREFIXES.
export const SHORT_BY_TYPE = Object.freeze({
  tutorial: 't',
  concept:  'c',
  mission:  'm',
  group:    'g',
  product:  'p',
  category: 'k',
  tag:      'x',
  'learning-journey': 'lj',  // Phase 4.1 (#447). Without this entry,
  // parseEntityIri() would return id 'undefined:slug' once the projection
  // starts emitting learning-journey triples — caught by Task 2 lockstep.
  'blog-post': 'bp',  // Phase 4.2 (#447).
  'discovery-mission': 'dm',  // Phase 4.3 (#447).
  'video': 'vd',  // Phase 4.4 (#447).
  'api-doc': 'ad',  // Phase 4.5 (#746).
});

// IRI tail-segment → (entity type, short node-id prefix). Derived from
// KG_IRI_PREFIXES in kg-projection.js — single source of truth, no manual
// duplication. If a new entity type lands in the projection, this map
// picks it up automatically; the matching SHORT_BY_TYPE entry must be
// added by hand (caught by the lockstep test).
const IRI_TYPE_MAP = Object.freeze(
  Object.fromEntries(
    Object.entries(KG_IRI_PREFIXES).map(([type, fullPrefix]) => {
      const segment = fullPrefix.slice(KG_PREFIX.length); // e.g. 'tutorial/'
      return [segment, { type, short: SHORT_BY_TYPE[type] }];
    })
  )
);

/**
 * Parse an entity IRI (e.g. https://developers.sap.com/kg/tutorial/cap-handlers)
 * into { type, slug, id } where id is the (short:slug) form used as the
 * graph-node identity. Returns null for IRIs that don't match the kg/ prefix
 * or any known entity segment.
 */
function parseEntityIri(iri) {
  if (typeof iri !== 'string') return null;
  if (!iri.startsWith(KG_PREFIX)) return null;
  const tail = iri.slice(KG_PREFIX.length);
  for (const [segment, info] of Object.entries(IRI_TYPE_MAP)) {
    if (tail.startsWith(segment)) {
      const slug = tail.slice(segment.length);
      if (!slug) return null;
      return { type: info.type, slug, id: `${info.short}:${slug}` };
    }
  }
  return null;
}

/**
 * Strip the kg: predicate prefix to get the short edge label, e.g.
 * https://developers.sap.com/kg/teaches → "teaches". Falls back to the
 * raw IRI if it doesn't match the prefix (shouldn't happen — the
 * EXPLORE_GRAPH_BULK SPARQL filters to the 9 known predicates).
 */
function shortPredicate(iri) {
  if (typeof iri !== 'string') return '';
  if (iri.startsWith(KG_PREFIX)) return iri.slice(KG_PREFIX.length);
  return iri;
}

/**
 * Extract a binding value, defaulting to '' when the var is unbound.
 */
function bindingValue(binding, name) {
  const v = binding && binding[name];
  if (!v || typeof v.value !== 'string') return '';
  return v.value;
}

/**
 * Parse the EXPLORE_GRAPH_BULK SPARQL JSON response into rows of
 * { s, p, o, sName, oName } (raw strings).
 *
 * Returns [] for any non-JSON response — including XML, which is what
 * HANA SPARQL_EXECUTE emits if the DEFINER procedure forgets the
 * Accept: application/sparql-results+json header (caught 2026-06-28, see
 * db/src/procedures/KG_QUERY.hdbprocedure). The build-explore-data.js
 * wrapper logs a warn when the resulting payload has 0 nodes despite
 * a populated GraphMetadata.tripleCount — the canary for that regression.
 */
function parseExploreBindings(responseJson) {
  if (typeof responseJson !== 'string' || responseJson.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(responseJson);
  } catch {
    return [];
  }
  const bindings = parsed && parsed.results && Array.isArray(parsed.results.bindings)
    ? parsed.results.bindings
    : [];
  return bindings.map((b) => ({
    s:     bindingValue(b, 's'),
    p:     bindingValue(b, 'p'),
    o:     bindingValue(b, 'o'),
    sName: bindingValue(b, 'sName'),
    oName: bindingValue(b, 'oName'),
  }));
}

/**
 * Build the /graph/explore-data payload. Dispatches to EXPLORE_GRAPH_BULK
 * via kgQuery() and assembles a deduped {nodes, edges, generatedAt} shape.
 *
 * @param {object} db — CAP db service (from cds.connect.to('db')).
 * @param {object} [opts]
 * @param {string} [opts.overrideGraphIri] — when set, query against this
 *   graph instead of the production default. Used by hybrid tests.
 * @returns {Promise<{nodes: Array, edges: Array, generatedAt: string, droppedBindings: number}>}
 */
export async function buildExplorePayload(db, opts = {}) {
  const { overrideGraphIri } = opts;
  const { response } = await kgQuery({
    db,
    queryName: 'EXPLORE_GRAPH_BULK',
    params: {},
    overrideGraphIri,
  });

  const rows = parseExploreBindings(response);

  const nodesById = new Map();
  const edges = [];
  // Track bindings that arrived from SPARQL but failed to parse into an
  // entity IRI. A non-zero count signals schema drift (a new entity type
  // was added to the projection but IRI_TYPE_MAP wasn't updated) — see
  // memory [[feedback_silent_swallow_hides_dead_code]]. The Express
  // wrapper in build-explore-data.js logs a warn when this is > 0.
  let droppedBindings = 0;

  for (const r of rows) {
    const sParsed = parseEntityIri(r.s);
    const oParsed = parseEntityIri(r.o);
    if (!sParsed || !oParsed) {
      // Only count as "dropped" if the binding was actually present (the
      // raw IRI was non-empty). Vacuous rows from a degenerate SPARQL
      // response shouldn't inflate the counter.
      if (r.s || r.o) droppedBindings++;
      continue;
    }

    if (!nodesById.has(sParsed.id)) {
      nodesById.set(sParsed.id, {
        id:    sParsed.id,
        type:  sParsed.type,
        slug:  sParsed.slug,
        label: r.sName || sParsed.slug,
      });
    }
    if (!nodesById.has(oParsed.id)) {
      nodesById.set(oParsed.id, {
        id:    oParsed.id,
        type:  oParsed.type,
        slug:  oParsed.slug,
        label: r.oName || oParsed.slug,
      });
    }

    edges.push({
      s: sParsed.id,
      p: shortPredicate(r.p),
      o: oParsed.id,
    });
  }

  return {
    nodes: Array.from(nodesById.values()),
    edges,
    generatedAt: new Date().toISOString(),
    droppedBindings,
  };
}
