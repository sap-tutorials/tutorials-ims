// srv/lib/kg-queries.js
//
// JS-side slug validation + substitute() helper.
//
// Two responsibilities:
//   1. Validate user-supplied slugs match the canonical kg-tutorial-slug shape
//      via SLUG_RE before they're passed downstream.
//   2. Provide a small substitute(template, vars) helper that JS callers use
//      to pre-build tutorial IRIs (e.g. `<https://developers.sap.com/kg/tutorial/${slug}>`)
//      from validated slugs before passing them to kgQuery() as `params.slug`.
//
// **What used to live here:** SPARQL template strings (NEIGHBORHOOD_QUERY,
// PATH_BETWEEN_QUERY, CONCEPTS_FOR_USER_QUERY) — they moved into
// db/src/procedures/KG_QUERY.hdbprocedure. The HDI procedure is now the single
// source of truth for SPARQL shape; JS callers dispatch to it via kgQuery()
// in srv/lib/kg-sparql-client.js. This module retains only the validators.
//
// Spec: docs/superpowers/specs/2026-06-22-kg-sparql-definer-procedures-design.md
// Issue: #533

import { iriEscapeSegment } from './kg-projection.js';

// ---------------------------------------------------------------------------
// Validation — whitelisted typed placeholders
// ---------------------------------------------------------------------------

// Slug regex matches the same shape used elsewhere in the codebase
// (Tutorials.slug, Missions.slug, Groups.slug). 1–80 chars, lowercase
// alnum + hyphen, no leading/trailing hyphen. Exported so the
// KnowledgeGraphService handler can reuse it without re-deriving.
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

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

