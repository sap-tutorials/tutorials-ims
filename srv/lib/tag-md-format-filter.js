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
// STRATEGY (two-phase):
//   1. Before READ: rewrite any leaf `{ref: ['mdFormat']}` in the CQN
//      filter tree to `{ref: ['titlePath']}`. `titlePath` is a strict
//      SUPERSET of every value `mdFormat` can produce for plain-word
//      searches (mdFormat is a lowercased/hyphenated derivative). This
//      lets the DB push down and narrow 10K+ rows to a small candidate
//      set. Hyphen-containing search terms will UNDER-match at the SQL
//      layer (since titlePath has spaces, not hyphens); the handler
//      compensates by broadening the ceiling in the service handler.
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
