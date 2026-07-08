// srv/lib/tag-md-format-filter.js
//
// $filter support for the virtual `Tags.mdFormat` field (#837).
//
// PROBLEM: `mdFormat` is declared `virtual` on ims.Tags (see db/schema.cds).
// It has no DB column — a post-READ handler (srv/lib/tag-md-format.js)
// populates it from `titlePath`. But CAP pushes `$filter` predicates into
// SQL before that handler fires, so any `$filter=contains(mdFormat, ...)`
// query (Sage tag-search, follow-up to #824) crashes with a HANA SQL
// error surfaced as a generic HTTP 500.
//
// STRATEGY (two-phase, with a bypass for unsafe literals):
//   1. Before READ: rewrite any leaf `{ref: ['mdFormat']}` in the CQN
//      filter tree to `{ref: ['titlePath']}`. `titlePath` is a SUPERSET of
//      every value `mdFormat` can produce ONLY for plain-word searches
//      (mdFormat is a lowercased/hyphenated derivative of titlePath). If
//      the literal contains `>` or `-` — characters that appear in mdFormat
//      but never in titlePath — the rewrite becomes a strict UNDER-set and
//      would return zero rows even for tags that do match. In that case
//      (see containsUnsafeMdFormatLiteral / #1075) the handler skips SQL
//      narrowing entirely and scans up to MD_FORMAT_SCAN_CEILING rows so
//      the JS post-filter can find the true match.
//   2. After READ + applyMdFormat: re-evaluate the ORIGINAL filter tree
//      against the enriched rows in JS. This drops false positives and
//      preserves exact `mdFormat` semantics.
//
// Because we lose SQL-side accuracy when an mdFormat filter is present,
// the caller must NOT trust the DB's `$count`/`$top`/`$skip`. The
// service handler pattern is:
//
//   before('READ', 'Tags'): if containsMdFormatRef(where), stash the
//     original where, rewrite the CQN, force top/skip to a bounded
//     ceiling, and clear $count so we compute it locally.
//   after('READ', 'Tags'):  applyMdFormat, JS-filter with buildRowMatcher,
//     sort, paginate, restore $count.
//
// See srv/author-service.js and srv/admin-service.js for wiring.

const MD_FORMAT_FIELD = 'mdFormat';
const FALLBACK_FIELD = 'titlePath';

// Characters that appear in `mdFormat` values but never in `titlePath`:
//   `>`  — separator between first/last titlePath segments (mdFormat-only)
//   `-`  — collapse of any non-alphanumeric run in a segment (mdFormat-only;
//          titlePath keeps the original space, `.`, `&`, etc.)
//
// When a Sage-style `contains(tolower(mdFormat), '<literal>')` predicate has
// a literal containing either character, the SQL rewrite to `titlePath` is a
// strict UNDER-set (not the SUPERSET the file header assumes), so the DB
// short-circuits to zero rows and the JS post-filter never sees the true
// match. Detected literals bypass SQL narrowing entirely — see
// containsUnsafeMdFormatLiteral / #1075.
const MD_FORMAT_ONLY_CHARS = /[>-]/;

// ---------------------------------------------------------------------------
// containsMdFormatRef — cheap sniff test on a CQN where[] tree.
// ---------------------------------------------------------------------------

export function containsMdFormatRef(where) {
  if (!Array.isArray(where) || where.length === 0) return false;
  return walkForMdFormat(where);
}

function walkForMdFormat(node) {
  if (node == null) return false;
  if (Array.isArray(node)) return node.some(walkForMdFormat);
  if (typeof node !== 'object') return false;
  if (Array.isArray(node.ref) && node.ref[0] === MD_FORMAT_FIELD) return true;
  if (Array.isArray(node.args)) return node.args.some(walkForMdFormat);
  if (Array.isArray(node.xpr)) return node.xpr.some(walkForMdFormat);
  if (Array.isArray(node.list)) return node.list.some(walkForMdFormat);
  return false;
}

// ---------------------------------------------------------------------------
// containsUnsafeMdFormatLiteral — return true if the CQN where[] tree
// contains any predicate node that compares/matches `mdFormat` against a
// value literal (possibly wrapped in tolower/toupper) whose string form
// includes a character that never appears in `titlePath` (`>` or `-`).
//
// When this returns true, `rewriteWhereForPushdown` is unsafe: the SQL
// rewrite from mdFormat → titlePath would produce a strict UNDER-set match
// (zero rows for the SAP Community case reported in #1075). Callers should
// clear the SQL where clause and let the JS post-filter run against the
// full scan-ceiling result.
// ---------------------------------------------------------------------------

export function containsUnsafeMdFormatLiteral(where) {
  if (!Array.isArray(where) || where.length === 0) return false;
  return walkForUnsafeMdFormatLiteral(where);
}

function walkForUnsafeMdFormatLiteral(node) {
  if (node == null) return false;
  if (Array.isArray(node)) return node.some(walkForUnsafeMdFormatLiteral);
  if (typeof node !== 'object') return false;
  // A function/comparison node touching mdFormat: check every val leaf in
  // the args tree for the unsafe characters. `mdFormat` refs may sit
  // anywhere in the sub-tree (typically the first arg wrapped in tolower).
  if (nodeReferencesMdFormat(node)) {
    if (subtreeHasUnsafeValLiteral(node)) return true;
  }
  // Recurse — nested xpr / args / list may host another mdFormat clause.
  if (Array.isArray(node.args) && node.args.some(walkForUnsafeMdFormatLiteral)) return true;
  if (Array.isArray(node.xpr) && node.xpr.some(walkForUnsafeMdFormatLiteral)) return true;
  if (Array.isArray(node.list) && node.list.some(walkForUnsafeMdFormatLiteral)) return true;
  return false;
}

function nodeReferencesMdFormat(node) {
  if (node == null || typeof node !== 'object') return false;
  if (Array.isArray(node.ref) && node.ref[0] === MD_FORMAT_FIELD) return true;
  if (Array.isArray(node.args) && node.args.some(nodeReferencesMdFormat)) return true;
  if (Array.isArray(node.xpr) && node.xpr.some(nodeReferencesMdFormat)) return true;
  return false;
}

function subtreeHasUnsafeValLiteral(node) {
  if (node == null || typeof node !== 'object') return false;
  if ('val' in node && typeof node.val === 'string' && MD_FORMAT_ONLY_CHARS.test(node.val)) {
    return true;
  }
  if (Array.isArray(node.args) && node.args.some(subtreeHasUnsafeValLiteral)) return true;
  if (Array.isArray(node.xpr) && node.xpr.some(subtreeHasUnsafeValLiteral)) return true;
  if (Array.isArray(node.list) && node.list.some(subtreeHasUnsafeValLiteral)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// rewriteWhereForPushdown — return a fresh CQN where[] tree with every
// {ref: ['mdFormat']} replaced by {ref: ['titlePath']}. Non-mutating.
// ---------------------------------------------------------------------------

export function rewriteWhereForPushdown(where) {
  if (!Array.isArray(where)) return where;
  return where.map(cloneAndRewrite);
}

function cloneAndRewrite(node) {
  if (node == null) return node;
  if (typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(cloneAndRewrite);
  if (Array.isArray(node.ref)) {
    if (node.ref[0] === MD_FORMAT_FIELD) {
      // Replace only the leading path segment (in practice always a
      // single-segment ref, but be defensive against dotted paths).
      return { ...node, ref: [FALLBACK_FIELD, ...node.ref.slice(1)] };
    }
    return { ...node, ref: [...node.ref] };
  }
  const out = { ...node };
  if (Array.isArray(node.args)) out.args = node.args.map(cloneAndRewrite);
  if (Array.isArray(node.xpr)) out.xpr = node.xpr.map(cloneAndRewrite);
  if (Array.isArray(node.list)) out.list = node.list.map(cloneAndRewrite);
  return out;
}

// ---------------------------------------------------------------------------
// buildRowMatcher — compile a CQN where[] tree into `(row) => boolean`.
// Supports the OData $filter subset the Sage extension emits:
//   contains / startswith / endswith / tolower / toupper
//   = <> < <= > >=
//   and / or / not / grouped xpr
// Comparison values reach us as {val: ...}; field refs as {ref: [name]}.
// ---------------------------------------------------------------------------

export function buildRowMatcher(where) {
  if (!Array.isArray(where) || where.length === 0) return () => true;
  return (row) => evalPredicateList(where, row);
}

// evalPredicateList — reduce an infix operand-operator list to a boolean.
// Precedence: not > comparison > and > or.
function evalPredicateList(list, row) {
  // Pass 1: collapse three-token comparisons (LHS op RHS) into a single
  // boolean. Consume unary `not` here too so we can feed clean atoms into
  // the and/or reducer.
  const atoms = [];
  let i = 0;
  while (i < list.length) {
    const token = list[i];
    if (isBoolOp(token, 'and') || isBoolOp(token, 'or')) {
      atoms.push(token.toLowerCase());
      i++;
      continue;
    }
    if (isBoolOp(token, 'not')) {
      const next = list[i + 1];
      atoms.push(!evalOperandOrCompare(next, row));
      i += 2;
      continue;
    }
    // Three-token comparison? Peek next token.
    if (isCompareOp(list[i + 1])) {
      atoms.push(evalCompare(token, list[i + 1], list[i + 2], row));
      i += 3;
      continue;
    }
    atoms.push(evalOperandOrCompare(token, row));
    i++;
  }
  // Pass 2: apply `and` first, then `or`.
  const orGroups = [];
  let group = [];
  for (const a of atoms) {
    if (a === 'or') { orGroups.push(group); group = []; continue; }
    if (a === 'and') continue;
    group.push(a);
  }
  orGroups.push(group);
  return orGroups.some((g) => g.every(Boolean));
}

function isBoolOp(t, name) {
  return typeof t === 'string' && t.toLowerCase() === name;
}

function isCompareOp(token) {
  if (typeof token !== 'string') return false;
  const t = token.toLowerCase();
  return t === '=' || t === '==' || t === '<>' || t === '!='
      || t === '<' || t === '<=' || t === '>' || t === '>=';
}

function evalOperandOrCompare(node, row) {
  if (node == null) return false;
  if (typeof node !== 'object') return false;
  if (Array.isArray(node.xpr)) return evalPredicateList(node.xpr, row);
  if (typeof node.func === 'string') return evalFunc(node, row);
  // A bare {ref}/{val} operand outside a comparison has no meaningful
  // truth value in the OData $filter shapes we accept; treat as false.
  return false;
}

function evalCompare(lhs, op, rhs, row) {
  const a = resolveValue(lhs, row);
  const b = resolveValue(rhs, row);
  const o = op.toLowerCase();
  switch (o) {
    case '=':
    case '==': return a === b;
    case '<>':
    case '!=': return a !== b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    default: return false;
  }
}

// resolveValue: pull a JS value out of {ref}/{val}/{func} nodes.
function resolveValue(node, row) {
  if (node == null) return null;
  if (typeof node !== 'object') return node;
  if ('val' in node) return node.val;
  if (Array.isArray(node.ref)) {
    const field = node.ref[0];
    const v = row && Object.prototype.hasOwnProperty.call(row, field) ? row[field] : null;
    return v ?? null;
  }
  if (typeof node.func === 'string') {
    const f = node.func.toLowerCase();
    const arg = Array.isArray(node.args) ? node.args[0] : null;
    const v = resolveValue(arg, row);
    if (v == null) return null;
    if (f === 'tolower') return String(v).toLowerCase();
    if (f === 'toupper') return String(v).toUpperCase();
  }
  return null;
}

function evalFunc(node, row) {
  const name = (node.func || '').toLowerCase();
  const args = Array.isArray(node.args) ? node.args : [];
  if (name === 'contains') {
    const haystack = coerceString(resolveValue(args[0], row));
    const needle = coerceString(resolveValue(args[1], row));
    return haystack.includes(needle);
  }
  if (name === 'startswith') {
    return coerceString(resolveValue(args[0], row))
      .startsWith(coerceString(resolveValue(args[1], row)));
  }
  if (name === 'endswith') {
    return coerceString(resolveValue(args[0], row))
      .endsWith(coerceString(resolveValue(args[1], row)));
  }
  return false;
}

function coerceString(v) {
  return v == null ? '' : String(v);
}
