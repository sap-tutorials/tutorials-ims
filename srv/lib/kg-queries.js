// srv/lib/kg-queries.js
// Catalog of named SPARQL queries + strict parameter substitution.
//
// Why this module exists
// ----------------------
// The KnowledgeGraphService (PR 5 of issue #381) exposes typed named queries
// rather than raw SPARQL on its public surface — same security model as
// AnalyticsService.runSelectQuery. Each named query is a SPARQL template with
// `$NAME` placeholders; `substitute(template, params)` validates each input
// against an allow-list of typed slots (slug / UUID / integer) and throws
// synchronously on failure. Anything that fails validation maps to HTTP 400
// at the handler layer.
//
// Two deliberate deviations from spec
// -----------------------------------
// The design spec (docs/superpowers/specs/2026-06-17-knowledge-graph-design.md
// § "The flagship query — neighborhood(slug)") presents a 4-way UNION SPARQL
// that uses `kg:tutorial/$SLUG` (a prefixed-name with a `/`) and selects
// `kg:title` for tutorial-targeted UNION branches. Both are wrong:
//
//   1. HANA's SPARQL parser rejects `/` inside PN_LOCAL. The spike probe
//      (scripts/spike/kg-probe.cjs, PR 1) verified that full angle-bracket
//      IRIs are unambiguously valid. We use full IRIs throughout.
//
//   2. srv/lib/kg-projection.js does NOT emit `kg:title` triples for
//      tutorials — only structural triples (teaches / extends / partOf /
//      taggedWith / aboutProduct / coCompletedWith). Selecting `?x kg:title`
//      would always return zero rows. For the three tutorial-targeted UNION
//      branches (prerequisitesOf, sharedConcepts, whatToLearnNext) we drop
//      the `?targetLabel` projection and instead extract the slug from the
//      tutorial IRI via `BIND(REPLACE(STR(?iri), "<prefix>", "") AS ?targetSlug)`.
//      The handler joins `Tutorials` separately to populate `title`.
//
// The result schema therefore varies by branch:
//   teaches:           { type, targetSlug, targetLabel, weight }
//   prerequisitesOf:   { type, targetSlug, weight }                — no label
//   sharedConcepts:    { type, targetSlug }                        — no label, no weight
//   whatToLearnNext:   { type, targetSlug }                        — no label, no weight
// SPARQL SELECT DISTINCT emits unbound projection variables as null.

import { iriEscapeSegment } from './kg-projection.js';

// ---------------------------------------------------------------------------
// Validation — whitelisted typed placeholders
// ---------------------------------------------------------------------------

// Slug regex matches the same shape used elsewhere in the codebase
// (Tutorials.slug, Missions.slug, Groups.slug). 1–80 chars, lowercase
// alnum + hyphen, no leading/trailing hyphen.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

// RFC 4122 UUID — case-insensitive (we do not try to canonicalise).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Whitelist of placeholder name → type. Adding a new placeholder requires
// a new entry here AND a corresponding case in coerce(). Anything outside
// the whitelist throws KG_QUERY_UNKNOWN_PLACEHOLDER.
const PLACEHOLDER_TYPES = Object.freeze({
  SLUG:       'slug',
  FROM_SLUG:  'slug',
  TO_SLUG:    'slug',
  USER_ID:    'uuid',
  LIMIT:      'integer',
});

/**
 * Typed AppError-style throw helper. The .code property lets the HTTP
 * handler map to a structured 400 response without parsing the message.
 */
function throwQueryError(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

/**
 * Validate + coerce a single placeholder value to its substituted form.
 * Returns the string that should replace `$NAME` in the template.
 */
function coerce(name, value) {
  const type = PLACEHOLDER_TYPES[name];
  if (!type) {
    throwQueryError(
      'KG_QUERY_UNKNOWN_PLACEHOLDER',
      `unknown placeholder name '${name}': not on the whitelist (${Object.keys(PLACEHOLDER_TYPES).join(', ')})`
    );
  }

  switch (type) {
    case 'slug': {
      if (typeof value !== 'string' || !SLUG_RE.test(value)) {
        throwQueryError(
          'KG_QUERY_INVALID_SLUG',
          `invalid slug '${String(value)}' for placeholder $${name}: must match /^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]?$/ (lowercase alnum + hyphen, 1–80 chars, no leading/trailing hyphen)`
        );
      }
      // Belt-and-suspenders: even though the slug regex already rejects the
      // IRI-unsafe set ('<', '>', '"', etc.), run iriEscapeSegment so any
      // future loosening of SLUG_RE can't silently re-introduce injection.
      return iriEscapeSegment(value);
    }
    case 'uuid': {
      if (typeof value !== 'string' || !UUID_RE.test(value)) {
        throwQueryError(
          'KG_QUERY_INVALID_UUID',
          `invalid UUID '${String(value)}' for placeholder $${name}: must match RFC 4122`
        );
      }
      return value;
    }
    case 'integer': {
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        throwQueryError(
          'KG_QUERY_INVALID_INTEGER',
          `invalid integer '${String(value)}' for placeholder $${name}: must be a finite non-negative integer`
        );
      }
      return String(n);
    }
    default:
      // Unreachable — exhaustive switch over PLACEHOLDER_TYPES values.
      throwQueryError(
        'KG_QUERY_INTERNAL',
        `kg-queries: no coercion implemented for type '${type}'`
      );
      return '';
  }
}

// ---------------------------------------------------------------------------
// Public substitute()
// ---------------------------------------------------------------------------

/**
 * Strict parameter substitution into a SPARQL template.
 *
 * Placeholder syntax:
 *   $NAME    where NAME matches [A-Z][A-Z0-9_]*  (one or more chars)
 *   $$       a literal '$' (escape — useful inside SPARQL string literals)
 *
 * Every placeholder name in the template MUST appear on the whitelist
 * (PLACEHOLDER_TYPES). Every key in `params` MUST also be on the whitelist.
 * Every placeholder referenced in the template MUST have a value supplied
 * (no defaults). A whitelist key that is neither in the template nor in
 * params is fine — it just means that placeholder is currently unused.
 *
 * @param {string} template — SPARQL template string with $NAME tokens
 * @param {Record<string, string|number>} params — input values, keys are
 *   placeholder names without the leading '$'
 * @returns {string} fully-substituted SPARQL ready for sparqlExec/sparqlQuery
 * @throws {Error & {code: string}} on any validation failure. Codes:
 *   - KG_QUERY_INVALID_SLUG
 *   - KG_QUERY_INVALID_UUID
 *   - KG_QUERY_INVALID_INTEGER
 *   - KG_QUERY_MISSING_PARAM
 *   - KG_QUERY_UNKNOWN_PLACEHOLDER
 */
export function substitute(template, params = {}) {
  if (typeof template !== 'string') {
    throwQueryError('KG_QUERY_INTERNAL', 'kg-queries.substitute: template must be a string');
  }

  // Reject any param key that isn't on the whitelist. This catches typos at
  // the call site (e.g. { slug: 'x' } instead of { SLUG: 'x' }).
  for (const key of Object.keys(params)) {
    if (!Object.prototype.hasOwnProperty.call(PLACEHOLDER_TYPES, key)) {
      throwQueryError(
        'KG_QUERY_UNKNOWN_PLACEHOLDER',
        `unknown placeholder name '${key}' in params: not on the whitelist (${Object.keys(PLACEHOLDER_TYPES).join(', ')})`
      );
    }
  }

  // Two-pass replace. Pass 1 handles the $$ escape by replacing it with a
  // private-use sentinel, so the placeholder regex in pass 2 can't see it.
  // Pass 3 puts the literal $ back. Sentinel is U+E000 which never appears
  // in our SPARQL templates.
  const SENTINEL = '\uE000';
  let s = template.split('$$').join(SENTINEL);

  // Track which whitelisted names actually appear in the template, so we
  // can raise KG_QUERY_MISSING_PARAM with a useful message.
  const referenced = new Set();

  // Replace $NAME — fail fast on any unknown placeholder name.
  s = s.replace(/\$([A-Z][A-Z0-9_]*)/g, (_match, name) => {
    if (!Object.prototype.hasOwnProperty.call(PLACEHOLDER_TYPES, name)) {
      throwQueryError(
        'KG_QUERY_UNKNOWN_PLACEHOLDER',
        `template references unknown placeholder $${name}: not on the whitelist (${Object.keys(PLACEHOLDER_TYPES).join(', ')})`
      );
    }
    referenced.add(name);
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throwQueryError(
        'KG_QUERY_MISSING_PARAM',
        `template references $${name} but params has no '${name}' key`
      );
    }
    return coerce(name, params[name]);
  });

  // Restore the literal $.
  return s.split(SENTINEL).join('$');
}

// ---------------------------------------------------------------------------
// NEIGHBORHOOD_QUERY — Phase 1 flagship
// ---------------------------------------------------------------------------

/**
 * 4-way UNION emitting:
 *   - teaches:           concepts the input tutorial directly teaches
 *                        (?targetSlug + ?targetLabel from kg:slug + kg:name)
 *   - prerequisitesOf:   tutorials teaching concepts the input tutorial requires
 *                        (?targetSlug from IRI; ?targetLabel left unbound)
 *   - sharedConcepts:    other tutorials teaching the same concepts
 *                        (?targetSlug from IRI; ?targetLabel left unbound)
 *   - whatToLearnNext:   tutorials teaching concepts that REQUIRE concepts
 *                        the input tutorial teaches
 *                        (?targetSlug from IRI; ?targetLabel left unbound)
 *
 * Result schema: each row has `?type` and `?targetSlug`. `?targetLabel` is
 * bound only on the teaches branch; `?weight` is bound on teaches and
 * prerequisitesOf. SPARQL SELECT DISTINCT emits unbound vars as null;
 * the JS handler post-processes:
 *   - Tutorial-targeted rows (no label): join Tutorials.title separately
 *   - Missing weight: ranker assigns a default (1.0 for teaches semantics,
 *     0.5 for sharedConcepts/whatToLearnNext) before re-ranking by
 *     coCompletedWith on whatToLearnNext.
 *
 * LIMIT 60 is a coarse cap so a degenerate "popular concept" graph can't
 * blow the response size — the ranker trims to top-10 per group anyway.
 */
export const NEIGHBORHOOD_QUERY = `PREFIX kg: <https://developers.sap.com/kg/>

SELECT DISTINCT ?type ?targetSlug ?targetLabel ?weight
FROM <https://developers.sap.com/kg/tutorials>
WHERE {
  {
    # teaches: concepts the input tutorial directly teaches
    <https://developers.sap.com/kg/tutorial/$SLUG> kg:teaches ?concept .
    ?concept kg:slug ?targetSlug ; kg:name ?targetLabel .
    BIND("teaches" AS ?type) BIND(1.0 AS ?weight)
  } UNION {
    # prerequisitesOf: tutorials teaching concepts the input tutorial requires
    <https://developers.sap.com/kg/tutorial/$SLUG> kg:teaches ?concept .
    ?concept kg:requires ?prereq .
    ?prereqTut kg:teaches ?prereq .
    FILTER(?prereqTut != <https://developers.sap.com/kg/tutorial/$SLUG>)
    BIND(REPLACE(STR(?prereqTut), "https://developers.sap.com/kg/tutorial/", "") AS ?targetSlug)
    BIND("prerequisitesOf" AS ?type) BIND(0.9 AS ?weight)
  } UNION {
    # sharedConcepts: other tutorials teaching the same concepts
    <https://developers.sap.com/kg/tutorial/$SLUG> kg:teaches ?sharedConcept .
    ?other kg:teaches ?sharedConcept .
    FILTER(?other != <https://developers.sap.com/kg/tutorial/$SLUG>)
    BIND(REPLACE(STR(?other), "https://developers.sap.com/kg/tutorial/", "") AS ?targetSlug)
    BIND("sharedConcepts" AS ?type)
  } UNION {
    # whatToLearnNext: tutorials teaching concepts that require what the input teaches
    <https://developers.sap.com/kg/tutorial/$SLUG> kg:teaches ?known .
    ?advanced kg:requires ?known .
    ?nextTut kg:teaches ?advanced .
    FILTER(?nextTut != <https://developers.sap.com/kg/tutorial/$SLUG>)
    BIND(REPLACE(STR(?nextTut), "https://developers.sap.com/kg/tutorial/", "") AS ?targetSlug)
    BIND("whatToLearnNext" AS ?type)
  }
}
LIMIT 60
`;

// ---------------------------------------------------------------------------
// Phase 2 stubs — declared so the service contract is stable across phases
// ---------------------------------------------------------------------------

/**
 * Phase 2 stub. Will become a SPARQL property-path query that finds the
 * shortest chain of `:requires` edges between two concepts/tutorials.
 * Not currently invoked — the service handler returns [] for Phase 1.
 */
export const PATH_BETWEEN_QUERY = `PREFIX kg: <https://developers.sap.com/kg/>

# Phase 2 stub: PR 5 declares; PR 6+ implements.
# Will be: SELECT shortest path of kg:requires between $FROM_SLUG and $TO_SLUG.
SELECT ?placeholder
FROM <https://developers.sap.com/kg/tutorials>
WHERE { ?placeholder ?p ?o }
LIMIT 0
`;

/**
 * Phase 2 stub. Will become a query that, given a user, computes the set
 * of concepts they have transitively learned via completed tutorials, plus
 * partials (concepts they've seen but not yet mastered).
 */
export const CONCEPTS_FOR_USER_QUERY = `PREFIX kg: <https://developers.sap.com/kg/>

# Phase 2 stub: PR 5 declares; PR 6+ implements.
# Will be: SELECT concepts taught by tutorials completed by $USER_ID.
SELECT ?placeholder
FROM <https://developers.sap.com/kg/tutorials>
WHERE { ?placeholder ?p ?o }
LIMIT 0
`;
