// srv/lib/branch/condition.js
//
// Tiny predicate DSL for issue #172 branching paths.
// Hand-rolled recursive-descent parser — NO eval, NO Function constructor.
// Grammar (informal):
//   expr      := and_expr
//   and_expr  := unary ( ( "&&" | "and" ) unary )*
//   unary     := "!" atom | atom
//   atom      := pred | "(" expr ")"
//   pred      := "completed:" slug
//              | "completedMission:" slug
//              | "profile." field "==" string
//              | "profile." field "in" "[" string ("," string)* "]"
//              | "true" | "false"
//
// Spec: docs/superpowers/specs/2026-06-09-172-branching-paths-design.md §4.3

export class ConditionParseError extends Error {
  constructor(message, position) {
    super(`${message} (at position ${position})`);
    this.name = 'ConditionParseError';
    this.position = position;
  }
}

const SLUG_RE  = /^[a-z0-9][a-z0-9-]*/;
const FIELD_RE = /^[a-zA-Z][a-zA-Z0-9_]*/;

class Tokenizer {
  constructor(src) { this.src = src; this.pos = 0; }
  rest() { return this.src.slice(this.pos); }
  skipWs() { while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++; }
  peek() { this.skipWs(); return this.src[this.pos]; }
  eatLiteral(lit) {
    this.skipWs();
    if (this.src.slice(this.pos, this.pos + lit.length) === lit) { this.pos += lit.length; return true; }
    return false;
  }
  expectLiteral(lit) {
    if (!this.eatLiteral(lit)) throw new ConditionParseError(`expected '${lit}'`, this.pos);
  }
  matchHead(re) {
    this.skipWs();
    const m = this.rest().match(re);
    if (!m) return null;
    this.pos += m[0].length;
    return m[0];
  }
  readQuotedString() {
    this.skipWs();
    if (this.src[this.pos] !== "'") throw new ConditionParseError(`expected single-quoted string`, this.pos);
    const start = ++this.pos;
    while (this.pos < this.src.length && this.src[this.pos] !== "'") this.pos++;
    if (this.pos >= this.src.length) throw new ConditionParseError('unterminated string', start);
    const value = this.src.slice(start, this.pos);
    this.pos++;
    return value;
  }
  atEnd() { this.skipWs(); return this.pos >= this.src.length; }
}

function parseAtom(tk) {
  tk.skipWs();
  if (tk.eatLiteral('(')) {
    const inner = parseExpr(tk);
    tk.expectLiteral(')');
    return inner;
  }
  if (tk.eatLiteral('true'))  return { kind: 'lit', value: true };
  if (tk.eatLiteral('false')) return { kind: 'lit', value: false };

  if (tk.eatLiteral('completedMission:')) {
    const slug = tk.matchHead(SLUG_RE);
    if (!slug) throw new ConditionParseError("expected slug after 'completedMission:'", tk.pos);
    return { kind: 'completedMission', slug };
  }
  if (tk.eatLiteral('completed:')) {
    const slug = tk.matchHead(SLUG_RE);
    if (!slug) throw new ConditionParseError("expected slug after 'completed:'", tk.pos);
    return { kind: 'completed', slug };
  }
  if (tk.eatLiteral('profile.')) {
    const field = tk.matchHead(FIELD_RE);
    if (!field) throw new ConditionParseError("expected field name after 'profile.'", tk.pos);
    tk.skipWs();
    if (tk.eatLiteral('==')) {
      const value = tk.readQuotedString();
      return { kind: 'profileEq', field, value };
    }
    if (tk.eatLiteral('in')) {
      tk.expectLiteral('[');
      const values = [];
      values.push(tk.readQuotedString());
      while (tk.eatLiteral(',')) values.push(tk.readQuotedString());
      tk.expectLiteral(']');
      return { kind: 'profileIn', field, values };
    }
    throw new ConditionParseError(`expected '==' or 'in' after 'profile.${field}'`, tk.pos);
  }
  throw new ConditionParseError('unrecognised predicate', tk.pos);
}

function parseUnary(tk) {
  if (tk.eatLiteral('!')) return { kind: 'not', child: parseUnary(tk) };
  return parseAtom(tk);
}

function parseExpr(tk) {
  let left = parseUnary(tk);
  while (tk.eatLiteral('&&') || tk.eatLiteral('and')) {
    const right = parseUnary(tk);
    left = { kind: 'and', left, right };
  }
  return left;
}

export function parseCondition(src) {
  if (typeof src !== 'string') throw new ConditionParseError('condition must be a string', 0);
  const tk = new Tokenizer(src);
  const ast = parseExpr(tk);
  if (!tk.atEnd()) throw new ConditionParseError('unexpected trailing input', tk.pos);
  return ast;
}

function evalAst(ast, state) {
  switch (ast.kind) {
    case 'lit':              return ast.value;
    case 'not':              return !evalAst(ast.child, state);
    case 'and':              return evalAst(ast.left, state) && evalAst(ast.right, state);
    case 'completed':        return state.completedSlugs.has(ast.slug);
    case 'completedMission': return state.completedMissionSlugs.has(ast.slug);
    case 'profileEq':        return state.profile?.[ast.field] === ast.value;
    case 'profileIn':        return ast.values.includes(state.profile?.[ast.field]);
    default: throw new Error(`unreachable: ${ast.kind}`);
  }
}

export function evalCondition(src, state) {
  return evalAst(parseCondition(src), state);
}
