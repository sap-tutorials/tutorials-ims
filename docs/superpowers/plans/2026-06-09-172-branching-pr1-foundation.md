# 172 PR 1 — Branching Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the substrate that PRs 2–6 all consume — condition language, decision engine, user-state loader, `BranchDecisions` telemetry entity, and the `branchingEnabled` master flag — behind a default-off flag with no UI surface.

**Architecture:** Pure JS modules under `srv/lib/branch/`, one new entity, one new flag column on `ChatSettings`. No HTTP routes, no UI, no LLM. The full unit-test suite locks the contract before downstream PRs land.

**Tech Stack:** CAP Node.js (`@sap/cds`), vitest unit project, in-memory SQLite for tests. Hand-rolled recursive-descent parser for the condition language (no new npm deps).

**Spec section refs:** §4.3 (condition language), §4.4 (`BranchDecisions`), §5.1 (engine), §5.5 (master flag), §5.6 (caching/fingerprint), §8.1 (no-LLM tests), §8.3 (anti-pitfall checks), §9.1 row 1 (PR 1 scope).

---

## File Structure

**Create (8 files):**
- `srv/lib/branch/condition.js` — recursive-descent parser + evaluator for the predicate DSL
- `srv/lib/branch/engine.js` — `pickBranch` + `evaluateSkip` (no LLM; uses ranker as fallback)
- `srv/lib/branch/ranker.js` — heuristic ranker reusing `recommend.js` substrate (centroids + co-completion)
- `srv/lib/branch/user-state.js` — loads `userState` once per request + computes the sha256 fingerprint
- `test/unit/branch/condition.test.js` — exhaustive grammar + evaluator tests (~30 cases)
- `test/unit/branch/engine.test.js` — pickBranch/evaluateSkip tests including no-LLM guarantee
- `test/unit/branch/ranker.test.js` — ranker edge cases (no embeddings, anonymous user)
- `test/unit/branch/user-state.test.js` — fingerprint determinism + frozen-state guarantees

**Modify (3 files):**
- `db/schema.cds` — add `BranchDecisions` entity + 3 type aliases + `ChatSettings.branchingEnabled` column
- `srv/lib/recommend.js` — export `__cosineNorm` so `ranker.js` can reuse the cosine helper without reimplementation
- `.deploy/mta.yaml` — add the 4 new `srv/lib/branch/*.js` files to the `tutorials-srv-qa` cp list ([[feedback_srv_qa_cp_list_recurring]])

**No new npm dependencies.**

---

## Task 1: Condition language — grammar + evaluator (red → green)

**Files:**
- Create: `srv/lib/branch/condition.js`
- Test: `test/unit/branch/condition.test.js`

- [ ] **Step 1: Write the failing test for atomic predicates**

Create `test/unit/branch/condition.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { evalCondition, parseCondition, ConditionParseError } from '../../../srv/lib/branch/condition.js';

const EMPTY_STATE = Object.freeze({
  completedSlugs: new Set(),
  completedMissionSlugs: new Set(),
  profile: Object.freeze({ deployment: null, role: null, cloud: null })
});

const FULL_STATE = Object.freeze({
  completedSlugs: new Set(['node-getting-started', 'hana-intro']),
  completedMissionSlugs: new Set(['btp-cap-onboarding']),
  profile: Object.freeze({ deployment: 'cloud', role: 'developer', cloud: 'btp' })
});

describe('condition language — atoms', () => {
  it('completed: returns true when slug is in completedSlugs', () => {
    expect(evalCondition('completed:node-getting-started', FULL_STATE)).toBe(true);
  });
  it('completed: returns false when slug is missing', () => {
    expect(evalCondition('completed:other-slug', FULL_STATE)).toBe(false);
  });
  it('completedMission: returns true when mission slug is present', () => {
    expect(evalCondition('completedMission:btp-cap-onboarding', FULL_STATE)).toBe(true);
  });
  it("profile.field == 'value' returns true on match", () => {
    expect(evalCondition("profile.deployment == 'cloud'", FULL_STATE)).toBe(true);
  });
  it("profile.field == 'value' returns false on mismatch", () => {
    expect(evalCondition("profile.deployment == 'onprem'", FULL_STATE)).toBe(false);
  });
  it('profile.field in [...] returns true when value is in the list', () => {
    expect(evalCondition("profile.role in ['developer','architect']", FULL_STATE)).toBe(true);
  });
  it('profile.field in [...] returns false otherwise', () => {
    expect(evalCondition("profile.role in ['student']", FULL_STATE)).toBe(false);
  });
  it('true/false literals', () => {
    expect(evalCondition('true', EMPTY_STATE)).toBe(true);
    expect(evalCondition('false', EMPTY_STATE)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run test/unit/branch/condition.test.js --project unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the recursive-descent parser + evaluator**

Create `srv/lib/branch/condition.js`. The tokenizer uses `String#match` against substrings rather than sticky regex to keep the implementation linear and easy to read:

```javascript
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
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `npx vitest run test/unit/branch/condition.test.js --project unit`
Expected: 8 tests pass.

- [ ] **Step 5: Add tests for connectives, negation, parens, and error messages**

Append to `test/unit/branch/condition.test.js`:

```javascript
describe('condition language — connectives', () => {
  it('and (symbol) short-circuits', () => {
    expect(evalCondition("completed:node-getting-started && profile.deployment == 'cloud'", FULL_STATE)).toBe(true);
    expect(evalCondition("completed:missing && profile.deployment == 'cloud'", FULL_STATE)).toBe(false);
  });
  it('and (keyword) parses identically', () => {
    expect(evalCondition("completed:hana-intro and profile.role in ['developer']", FULL_STATE)).toBe(true);
  });
  it('negation flips a predicate', () => {
    expect(evalCondition('!completed:other-slug', FULL_STATE)).toBe(true);
    expect(evalCondition('!completed:hana-intro', FULL_STATE)).toBe(false);
  });
  it('parens group correctly', () => {
    expect(evalCondition("(profile.deployment == 'cloud' && completed:hana-intro)", FULL_STATE)).toBe(true);
  });
});

describe('condition language — errors', () => {
  it('throws ConditionParseError on missing slug', () => {
    expect(() => parseCondition('completed:')).toThrow(ConditionParseError);
  });
  it('throws on unknown predicate', () => {
    expect(() => parseCondition('foo:bar')).toThrow(ConditionParseError);
  });
  it('throws on unterminated string', () => {
    expect(() => parseCondition("profile.deployment == 'cloud")).toThrow(ConditionParseError);
  });
  it('throws on trailing input', () => {
    expect(() => parseCondition('true xxx')).toThrow(ConditionParseError);
  });
  it('throws on missing operator after profile field', () => {
    expect(() => parseCondition('profile.deployment')).toThrow(ConditionParseError);
  });
  it('non-string input is a parse error', () => {
    expect(() => parseCondition(42)).toThrow(ConditionParseError);
  });
});

describe('condition language — empty state (anonymous)', () => {
  it('all completed: returns false', () => {
    expect(evalCondition('completed:anything', EMPTY_STATE)).toBe(false);
  });
  it('all profile.* returns false', () => {
    expect(evalCondition("profile.deployment == 'cloud'", EMPTY_STATE)).toBe(false);
    expect(evalCondition("profile.role in ['student']", EMPTY_STATE)).toBe(false);
  });
});

describe('condition language — sandbox guarantees', () => {
  it('rejects strings that look like JS', () => {
    expect(() => parseCondition('1+1')).toThrow(ConditionParseError);
    expect(() => parseCondition("(()=>true)()")).toThrow(ConditionParseError);
  });
  it('rejects member-access syntax', () => {
    expect(() => parseCondition('foo.bar')).toThrow(ConditionParseError);
  });
});
```

- [ ] **Step 6: Run the full condition test file — verify it passes**

Run: `npx vitest run test/unit/branch/condition.test.js --project unit`
Expected: ~22 tests pass (8 + 14 added).

- [ ] **Step 7: Commit**

```bash
git add srv/lib/branch/condition.js test/unit/branch/condition.test.js
git commit -m "feat(172): branch condition DSL parser + evaluator"
```

---

## Task 2: Decision engine — pickBranch + evaluateSkip

**Files:**
- Create: `srv/lib/branch/engine.js`
- Test: `test/unit/branch/engine.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/branch/engine.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import { pickBranch, evaluateSkip } from '../../../srv/lib/branch/engine.js';

const STATE_CLOUD = Object.freeze({
  completedSlugs: new Set(['hana-intro']),
  completedMissionSlugs: new Set(),
  profile: Object.freeze({ deployment: 'cloud', role: 'developer', cloud: 'btp' })
});

const ANON = Object.freeze({
  completedSlugs: new Set(),
  completedMissionSlugs: new Set(),
  profile: Object.freeze({ deployment: null, role: null, cloud: null })
});

const NULL_RANKER = async () => [];

describe('pickBranch — author conditions', () => {
  it('first matching condition wins (declaration order)', async () => {
    const bp = {
      id: 'bp1', surface: 'tutorialBranch',
      branches: [
        { key: 'hana',     condition: "profile.deployment == 'cloud'" },
        { key: 'postgres', condition: null },
      ],
    };
    const out = await pickBranch(bp, STATE_CLOUD, {}, { rankBranches: NULL_RANKER });
    expect(out.picked).toBe('hana');
    expect(out.reason.kind).toBe('condition');
    expect(out.confidence).toBe(1.0);
  });

  it('skips conditions that evaluate false', async () => {
    const bp = {
      id: 'bp2', surface: 'tutorialBranch',
      branches: [
        { key: 'onprem',   condition: "profile.deployment == 'onprem'" },
        { key: 'cloud',    condition: "profile.deployment == 'cloud'" },
      ],
    };
    const out = await pickBranch(bp, STATE_CLOUD, {}, { rankBranches: NULL_RANKER });
    expect(out.picked).toBe('cloud');
  });
});

describe('pickBranch — ranker fallback', () => {
  it('uses ranker when no condition matches', async () => {
    const bp = {
      id: 'bp3', surface: 'tutorialBranch',
      branches: [
        { key: 'a', condition: null, embeddingHint: 'tut-a' },
        { key: 'b', condition: null, embeddingHint: 'tut-b' },
      ],
    };
    const ranker = async () => [{ key: 'b', score: 0.8 }, { key: 'a', score: 0.3 }];
    const out = await pickBranch(bp, STATE_CLOUD, {}, { rankBranches: ranker });
    expect(out.picked).toBe('b');
    expect(out.reason.kind).toBe('ranker');
    expect(out.confidence).toBe(0.8);
  });

  it('ignores low-confidence ranker output (< 0.05) and returns default', async () => {
    const bp = {
      id: 'bp4', surface: 'tutorialBranch',
      branches: [
        { key: 'a', condition: null, embeddingHint: 'tut-a' },
        { key: 'b', condition: null, embeddingHint: 'tut-b' },
      ],
    };
    const ranker = async () => [{ key: 'b', score: 0.01 }, { key: 'a', score: 0.005 }];
    const out = await pickBranch(bp, STATE_CLOUD, {}, { rankBranches: ranker });
    expect(out.picked).toBe('a');
    expect(out.reason.kind).toBe('default');
    expect(out.confidence).toBe(0);
  });

  it('skips ranker entirely when no embeddingHint is present on any branch', async () => {
    const bp = {
      id: 'bp5', surface: 'tutorialBranch',
      branches: [
        { key: 'a', condition: null },
        { key: 'b', condition: null },
      ],
    };
    const rankerCalled = vi.fn();
    await pickBranch(bp, STATE_CLOUD, {}, { rankBranches: rankerCalled });
    expect(rankerCalled).not.toHaveBeenCalled();
  });
});

describe('pickBranch — anonymous user', () => {
  it('falls back to deterministic default when no condition matches and no ranker hits', async () => {
    const bp = {
      id: 'bp6', surface: 'missionAltGroup',
      branches: [
        { key: 'cloud',  condition: "profile.deployment == 'cloud'" },
        { key: 'onprem', condition: "profile.deployment == 'onprem'" },
      ],
    };
    const out = await pickBranch(bp, ANON, {}, { rankBranches: NULL_RANKER });
    expect(out.picked).toBe('cloud');
    expect(out.reason.kind).toBe('default');
  });
});

describe('pickBranch — failure mode', () => {
  it('on engine throw inside ranker, returns deterministic default and logs', async () => {
    const bp = {
      id: 'bp7', surface: 'tutorialBranch',
      branches: [
        { key: 'a', condition: null, embeddingHint: 'tut-a' },
        { key: 'b', condition: null, embeddingHint: 'tut-b' },
      ],
    };
    const broken = async () => { throw new Error('embedding service down'); };
    const out = await pickBranch(bp, STATE_CLOUD, {}, { rankBranches: broken });
    expect(out.picked).toBe('a');
    expect(out.reason.kind).toBe('default');
  });
});

describe('evaluateSkip', () => {
  it('returns skip:true when condition is true', () => {
    const out = evaluateSkip('completed:hana-intro', STATE_CLOUD);
    expect(out.skip).toBe(true);
    expect(out.reason.kind).toBe('condition');
  });
  it('returns skip:false when condition is false', () => {
    const out = evaluateSkip('completed:never-completed', STATE_CLOUD);
    expect(out.skip).toBe(false);
  });
  it('returns skip:false on parse error (logs and degrades)', () => {
    const out = evaluateSkip('this is not valid', STATE_CLOUD);
    expect(out.skip).toBe(false);
  });
});

describe('pickBranch — no-LLM guarantee', () => {
  it('does not call fetch (proxy for LLM HTTP calls)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fetch should not be called');
    });
    try {
      const bp = {
        id: 'bp-nollm', surface: 'tutorialBranch',
        branches: [
          { key: 'a', condition: "profile.deployment == 'cloud'" },
          { key: 'b', condition: null },
        ],
      };
      await pickBranch(bp, STATE_CLOUD, {}, { rankBranches: NULL_RANKER });
      const aiCalls = fetchSpy.mock.calls.filter(([url]) =>
        typeof url === 'string' && /openai|aicore|anthropic/i.test(url));
      expect(aiCalls).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run test/unit/branch/engine.test.js --project unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the engine**

Create `srv/lib/branch/engine.js`:

```javascript
// srv/lib/branch/engine.js
//
// Decision engine for issue #172 branching paths. Pure async functions, no LLM.
// Spec: docs/superpowers/specs/2026-06-09-172-branching-paths-design.md §5.1

import cds from '@sap/cds';
import { evalCondition, ConditionParseError } from './condition.js';

const LOG = cds.log('branch-engine');

const RANKER_MIN_CONFIDENCE = 0.05;

/**
 * Decide which branch to recommend.
 * Returns ALWAYS — never throws to the caller; failures fall back to the deterministic default.
 *
 * @param {{id: string, surface: string, branches: Array<{key: string, condition?: string, embeddingHint?: string}>}} branchPoint
 * @param {{completedSlugs: Set<string>, completedMissionSlugs: Set<string>, profile: object}} userState
 * @param {{missionSlug?: string, tutorialSlug?: string, stepNumber?: number}} context
 * @param {{rankBranches: Function}} deps
 * @returns {Promise<{picked: string, reason: object, confidence: number}>}
 */
export async function pickBranch(branchPoint, userState, context = {}, deps) {
  if (!branchPoint?.branches?.length) {
    throw new Error('pickBranch: branchPoint.branches must be a non-empty array');
  }

  // 1. Author conditions in declaration order — first true wins
  for (const b of branchPoint.branches) {
    if (!b.condition) continue;
    try {
      if (evalCondition(b.condition, userState)) {
        return { picked: b.key, reason: { kind: 'condition', source: b.condition }, confidence: 1.0 };
      }
    } catch (err) {
      LOG.warn(`condition parse error on branchPoint=${branchPoint.id} key=${b.key}: ${err.message}`);
    }
  }

  // 2. Heuristic ranker, only if any branch has an embedding hint
  if (branchPoint.branches.some(b => b.embeddingHint)) {
    try {
      const ranked = await deps.rankBranches(branchPoint, userState, context);
      if (ranked?.length && ranked[0].score > RANKER_MIN_CONFIDENCE) {
        return {
          picked: ranked[0].key,
          reason: { kind: 'ranker', scores: ranked.map(r => ({ key: r.key, score: r.score })) },
          confidence: ranked[0].score,
        };
      }
    } catch (err) {
      LOG.warn(`ranker failed on branchPoint=${branchPoint.id}: ${err.message}`);
      // Fall through to deterministic default
    }
  }

  // 3. Deterministic default — first branch
  return { picked: branchPoint.branches[0].key, reason: { kind: 'default' }, confidence: 0 };
}

/**
 * Evaluate a skipIf predicate. Failures degrade to skip:false (don't change behaviour).
 * @returns {{skip: boolean, reason: object}}
 */
export function evaluateSkip(skipIfExpr, userState) {
  try {
    const skip = evalCondition(skipIfExpr, userState);
    return { skip, reason: { kind: 'condition', source: skipIfExpr } };
  } catch (err) {
    if (err instanceof ConditionParseError) {
      LOG.warn(`skipIf parse error: ${err.message} — degrading to skip:false`);
      return { skip: false, reason: { kind: 'parse-error', message: err.message } };
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run the engine tests — verify they pass**

Run: `npx vitest run test/unit/branch/engine.test.js --project unit`
Expected: ~10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/branch/engine.js test/unit/branch/engine.test.js
git commit -m "feat(172): pickBranch + evaluateSkip decision engine"
```

---

## Task 3: Heuristic ranker — reuse recommend.js substrate

**Files:**
- Modify: `srv/lib/recommend.js` (export internals)
- Create: `srv/lib/branch/ranker.js`
- Test: `test/unit/branch/ranker.test.js`

- [ ] **Step 1: Expose the cosine helper from recommend.js**

The existing PR #35 module ([srv/lib/recommend.js](srv/lib/recommend.js)) already implements normalised cosine similarity in `cosineNorm`. Don't duplicate.

Read existing module:

```bash
grep -n "^function cosineNorm\|^export" D:/projects/tutorials-poc/srv/lib/recommend.js
```

At the bottom of `srv/lib/recommend.js`, append:

```javascript

// Internal: re-export cosine helper for srv/lib/branch/ranker.js (issue #172).
// Underscore prefix marks it as a stable internal contract, not a public API.
export { cosineNorm as __cosineNorm };
```

- [ ] **Step 2: Write the failing ranker test**

Create `test/unit/branch/ranker.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { rankBranches } from '../../../srv/lib/branch/ranker.js';

const STATE = Object.freeze({
  completedSlugs: new Set(['intro-tutorial']),
  completedMissionSlugs: new Set(),
  profile: Object.freeze({ deployment: 'cloud', role: 'developer', cloud: 'btp' })
});

describe('rankBranches', () => {
  it('returns empty when no branch has an embeddingHint', async () => {
    const bp = { id: 'x', branches: [{ key: 'a' }, { key: 'b' }] };
    const deps = {
      loadCentroidBySlug: async () => null,
      loadUserCentroid:   async () => null,
      loadCoCompletions:  async () => ({}),
    };
    const out = await rankBranches(bp, STATE, {}, deps);
    expect(out).toEqual([]);
  });

  it('ranks higher-cosine branch above lower-cosine branch', async () => {
    const bp = {
      id: 'x',
      branches: [
        { key: 'a', embeddingHint: 'tut-a' },
        { key: 'b', embeddingHint: 'tut-b' },
      ],
    };
    const deps = {
      loadCentroidBySlug: async (slug) => {
        if (slug === 'tut-a') return [0.1, 0.99, 0];
        if (slug === 'tut-b') return [0.99, 0.1, 0];
        return null;
      },
      loadUserCentroid: async () => [1, 0, 0],
      loadCoCompletions: async () => ({}),
    };
    const out = await rankBranches(bp, STATE, {}, deps);
    expect(out[0].key).toBe('b');
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it('ignores branches whose embeddingHint resolves to null', async () => {
    const bp = {
      id: 'x',
      branches: [
        { key: 'a', embeddingHint: 'missing' },
        { key: 'b', embeddingHint: 'tut-b' },
      ],
    };
    const deps = {
      loadCentroidBySlug: async (slug) => slug === 'tut-b' ? [1, 0, 0] : null,
      loadUserCentroid: async () => [0.9, 0.1, 0],
      loadCoCompletions: async () => ({}),
    };
    const out = await rankBranches(bp, STATE, {}, deps);
    expect(out.find(r => r.key === 'a').score).toBe(0);
  });

  it('returns zero scores for anonymous user (no user centroid)', async () => {
    const bp = {
      id: 'x',
      branches: [{ key: 'a', embeddingHint: 'tut-a' }, { key: 'b', embeddingHint: 'tut-b' }],
    };
    const deps = {
      loadCentroidBySlug: async () => [1, 0, 0],
      loadUserCentroid:   async () => null,
      loadCoCompletions:  async () => ({}),
    };
    const out = await rankBranches(bp, { completedSlugs: new Set(), completedMissionSlugs: new Set(), profile: {} }, {}, deps);
    expect(out.every(r => r.score === 0)).toBe(true);
  });
});
```

- [ ] **Step 3: Run the failing test**

Run: `npx vitest run test/unit/branch/ranker.test.js --project unit`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the ranker**

Create `srv/lib/branch/ranker.js`:

```javascript
// srv/lib/branch/ranker.js
//
// Heuristic ranker for branch decisions. Reuses the same scoring rails
// as srv/lib/recommend.js (PR #35): cosine on tutorial centroids + co-completion.
// Spec: docs/superpowers/specs/2026-06-09-172-branching-paths-design.md §5.1 step 2

import { __cosineNorm as cosineNorm } from '../recommend.js';

const SIM_WEIGHT = 0.6;
const CO_WEIGHT  = 0.4;

/**
 * Rank a branch point's branches by similarity to the user's interests.
 * Pure async — no DB calls in this file; the deps object provides the loaders.
 *
 * @param {object} branchPoint  — { id, branches: [{key, embeddingHint?}] }
 * @param {object} userState    — { completedSlugs, completedMissionSlugs, profile }
 * @param {object} context      — { missionSlug?, tutorialSlug? }
 * @param {object} deps
 *   loadCentroidBySlug(slug)  → number[] | null
 *   loadUserCentroid(state)   → number[] | null
 *   loadCoCompletions()       → { [slug]: [{slug, score}, ...] }
 * @returns {Promise<Array<{key: string, score: number}>>}  sorted desc
 */
export async function rankBranches(branchPoint, userState, context, deps) {
  const withHints = branchPoint.branches.filter(b => !!b.embeddingHint);
  if (!withHints.length) return [];

  const userCentroid = await deps.loadUserCentroid(userState, context);
  const coAll = await safeCo(deps);

  const out = [];
  for (const b of branchPoint.branches) {
    if (!b.embeddingHint) { out.push({ key: b.key, score: 0 }); continue; }

    const branchCentroid = await deps.loadCentroidBySlug(b.embeddingHint);
    const sim = (userCentroid && branchCentroid) ? cosineNorm(userCentroid, branchCentroid) : 0;

    let co = 0;
    if (context.tutorialSlug && coAll[context.tutorialSlug]) {
      const pair = coAll[context.tutorialSlug].find(p => p.slug === b.embeddingHint);
      if (pair) {
        const max = coAll[context.tutorialSlug][0]?.score || 1;
        co = pair.score / max;
      }
    }

    out.push({ key: b.key, score: SIM_WEIGHT * sim + CO_WEIGHT * co });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

async function safeCo(deps) {
  try { return await deps.loadCoCompletions(); }
  catch { return {}; }
}
```

- [ ] **Step 5: Run the ranker tests — verify they pass**

Run: `npx vitest run test/unit/branch/ranker.test.js --project unit`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/recommend.js srv/lib/branch/ranker.js test/unit/branch/ranker.test.js
git commit -m "feat(172): branch ranker reusing recommend.js cosine substrate"
```

---

## Task 4: User-state loader + fingerprint

**Files:**
- Create: `srv/lib/branch/user-state.js`
- Test: `test/unit/branch/user-state.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/branch/user-state.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { buildUserState, fingerprintUserState } from '../../../srv/lib/branch/user-state.js';

describe('buildUserState', () => {
  it('returns frozen empty state for anonymous user', async () => {
    const state = await buildUserState(null, {
      loadCompletedSlugs: async () => [],
      loadCompletedMissionSlugs: async () => [],
      loadProfile: async () => null,
    });
    expect(state.completedSlugs).toBeInstanceOf(Set);
    expect(state.completedSlugs.size).toBe(0);
    expect(state.profile).toEqual({ deployment: null, role: null, cloud: null });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.profile)).toBe(true);
  });

  it('populates Sets and profile for authenticated user', async () => {
    const state = await buildUserState({ id: 'u1' }, {
      loadCompletedSlugs:        async () => ['a', 'b'],
      loadCompletedMissionSlugs: async () => ['m1'],
      loadProfile:               async () => ({ deployment: 'cloud', role: 'developer', cloud: 'btp' }),
    });
    expect([...state.completedSlugs].sort()).toEqual(['a', 'b']);
    expect([...state.completedMissionSlugs]).toEqual(['m1']);
    expect(state.profile.deployment).toBe('cloud');
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('treats missing profile fields as null (does not crash)', async () => {
    const state = await buildUserState({ id: 'u2' }, {
      loadCompletedSlugs:        async () => [],
      loadCompletedMissionSlugs: async () => [],
      loadProfile:               async () => ({ deployment: 'onprem' }),
    });
    expect(state.profile).toEqual({ deployment: 'onprem', role: null, cloud: null });
  });
});

describe('fingerprintUserState', () => {
  it('is deterministic across runs', () => {
    const s = {
      completedSlugs: new Set(['b', 'a', 'c']),
      completedMissionSlugs: new Set(['m1']),
      profile: { deployment: 'cloud', role: 'developer', cloud: 'btp' },
    };
    expect(fingerprintUserState(s)).toBe(fingerprintUserState(s));
  });

  it('is order-insensitive over Set members', () => {
    const a = { completedSlugs: new Set(['a', 'b']), completedMissionSlugs: new Set(), profile: {} };
    const b = { completedSlugs: new Set(['b', 'a']), completedMissionSlugs: new Set(), profile: {} };
    expect(fingerprintUserState(a)).toBe(fingerprintUserState(b));
  });

  it('changes when a slug is added', () => {
    const s1 = { completedSlugs: new Set(['a']), completedMissionSlugs: new Set(), profile: {} };
    const s2 = { completedSlugs: new Set(['a', 'b']), completedMissionSlugs: new Set(), profile: {} };
    expect(fingerprintUserState(s1)).not.toBe(fingerprintUserState(s2));
  });

  it('changes when profile changes', () => {
    const s1 = { completedSlugs: new Set(), completedMissionSlugs: new Set(), profile: { deployment: 'cloud' } };
    const s2 = { completedSlugs: new Set(), completedMissionSlugs: new Set(), profile: { deployment: 'onprem' } };
    expect(fingerprintUserState(s1)).not.toBe(fingerprintUserState(s2));
  });

  it('produces a 64-char hex string', () => {
    const s = { completedSlugs: new Set(), completedMissionSlugs: new Set(), profile: {} };
    const fp = fingerprintUserState(s);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run test/unit/branch/user-state.test.js --project unit`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement user-state.js**

Create `srv/lib/branch/user-state.js`:

```javascript
// srv/lib/branch/user-state.js
//
// Build the per-request userState shape consumed by pickBranch / evaluateSkip,
// and compute its sha256 fingerprint for cache keys.
// Spec: docs/superpowers/specs/2026-06-09-172-branching-paths-design.md §4.3, §5.6

import { createHash } from 'node:crypto';

const PROFILE_FIELDS = ['deployment', 'role', 'cloud'];

const EMPTY_STATE = Object.freeze({
  completedSlugs: new Set(),
  completedMissionSlugs: new Set(),
  profile: Object.freeze({ deployment: null, role: null, cloud: null }),
});

/**
 * Build a frozen userState for the request.
 * - Anonymous user → null user → empty Sets and null-fields profile.
 * - Profile fields not in PROFILE_FIELDS are dropped.
 */
export async function buildUserState(user, deps) {
  if (!user) return EMPTY_STATE;

  const [slugs, missions, profileRaw] = await Promise.all([
    deps.loadCompletedSlugs(user),
    deps.loadCompletedMissionSlugs(user),
    deps.loadProfile(user),
  ]);

  const profile = Object.create(null);
  for (const f of PROFILE_FIELDS) profile[f] = profileRaw?.[f] ?? null;

  return Object.freeze({
    completedSlugs: new Set(slugs),
    completedMissionSlugs: new Set(missions),
    profile: Object.freeze(profile),
  });
}

/**
 * Deterministic sha256 fingerprint of a userState.
 * Same content → same fingerprint, regardless of Set iteration order.
 */
export function fingerprintUserState(state) {
  const h = createHash('sha256');
  h.update(JSON.stringify({
    s: [...state.completedSlugs].sort(),
    m: [...state.completedMissionSlugs].sort(),
    p: PROFILE_FIELDS.reduce((o, f) => { o[f] = state.profile?.[f] ?? null; return o; }, {}),
  }));
  return h.digest('hex');
}
```

- [ ] **Step 4: Run user-state tests — verify they pass**

Run: `npx vitest run test/unit/branch/user-state.test.js --project unit`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/branch/user-state.js test/unit/branch/user-state.test.js
git commit -m "feat(172): userState loader + sha256 fingerprint for cache keys"
```

---

## Task 5: Schema — `BranchDecisions` entity + `branchingEnabled` flag

**Files:**
- Modify: `db/schema.cds`

- [ ] **Step 1: Read the current `ChatSettings` block to confirm style**

Run: `sed -n '419,441p' D:/projects/tutorials-poc/db/schema.cds`
Expected: existing block from lines 419–441 (`ChatSettings : cuid, managed { ... }`).

- [ ] **Step 2: Add the `branchingEnabled` flag to `ChatSettings`**

Within the `ChatSettings` body in `db/schema.cds`, just before the closing `}`, append:

```cds
  // Branching paths runtime master flag (issue #172). When false:
  //   - /api/branches/decide → 404
  //   - /build/mission/<slug> omits `recommendation`
  //   - getBranchRecommendation chat tool not registered
  //   - Renderers degrade to "show all branches, no recommendation"
  branchingEnabled     : Boolean default false;
```

- [ ] **Step 3: Add the `BranchDecisions` entity + 3 type aliases**

At the end of `db/schema.cds` (still inside the namespace), append:

```cds

// ── Issue #172: branching paths telemetry ───────────────────────────────────

type BranchSurface : String(20) enum {
  missionAltGroup;
  tutorialBranch;
  tutorialSkip;
}

type BranchReasonKind : String(20) enum {
  condition;
  ranker;
  default;
}

type BranchSource : String(20) enum {
  pageLoad;
  click;
  jouleTool;
}

@PersonalData : { EntitySemantics: 'Other' }
@analytics.exposed
entity BranchDecisions : managed {
  key ID                 : UUID;
  user                   : Association to Users;        // null for anonymous
  surface                : BranchSurface;
  missionSlug            : String(255);
  tutorialSlug           : String(255);
  branchPointId          : String(120);
  recommendedKey         : String(40);
  chosenKey              : String(40);                  // null = recommendation log only
  recommendationKind     : BranchReasonKind;
  confidence             : Decimal(5, 4);               // 0..1
  source                 : BranchSource;
  followedRecommendation : Boolean;
}
```

- [ ] **Step 4: Run schema-deploy hybrid sanity** (only if `cf login` is current)

Run: `npx vitest run --project hybrid test/hybrid/schema-deploy.test.js`
Expected: passes (validates HANA deploy). If you don't have a hybrid binding handy, skip — `npx vitest run --project unit` catches the SQLite-side compile.

- [ ] **Step 5: Run the unit suite as a smoke check**

Run: `npx vitest run --project unit`
Expected: existing tests still pass; the schema change does not break in-memory deploy.

- [ ] **Step 6: Commit**

```bash
git add db/schema.cds
git commit -m "feat(172): BranchDecisions entity + ChatSettings.branchingEnabled flag"
```

---

## Task 6: srv-qa cp list — register the new branch/ files

**Files:**
- Modify: `.deploy/mta.yaml`

This guards against [[feedback_srv_qa_cp_list_recurring]]. Without it, the QA deploy fails to boot when PRs 2/3 try to import these modules from a srv-qa runtime.

- [ ] **Step 1: Find the existing srv-qa cp invocation**

Run: `grep -n "code-check-step-loader.js" D:/projects/tutorials-poc/.deploy/mta.yaml`
Expected: one match — the `bash -c "mkdir -p srv/jobs && mkdir -p srv/handlers && cp ..."` line under the `tutorials-srv-qa` block.

- [ ] **Step 2: Add `srv/lib/branch/*.js` to the cp list**

In that line, find:

```
mkdir -p srv/jobs && mkdir -p srv/handlers && cp ../../srv/lib/content-store.js
```

Replace with:

```
mkdir -p srv/jobs && mkdir -p srv/handlers && mkdir -p srv/lib/branch && cp ../../srv/lib/branch/condition.js ../../srv/lib/branch/engine.js ../../srv/lib/branch/ranker.js ../../srv/lib/branch/user-state.js srv/lib/branch/ && cp ../../srv/lib/content-store.js
```

- [ ] **Step 3: Verify the change**

Run: `grep -nE "branch/(condition|engine|ranker|user-state)\.js" D:/projects/tutorials-poc/.deploy/mta.yaml | wc -l`
Expected: `4`.

- [ ] **Step 4: Commit**

```bash
git add .deploy/mta.yaml
git commit -m "chore(172): register srv/lib/branch/* in srv-qa cp list"
```

---

## Task 7: Final-branch sanity + push

- [ ] **Step 1: Run the full unit project**

Run: `npx vitest run --project unit`
Expected: all green; the 4 new test files contribute ~44 tests; nothing else regresses.

- [ ] **Step 2: Verify no LF→CRLF regression on Windows** ([[feedback_crlf_regression_on_windows]])

Run: `file D:/projects/tutorials-poc/srv/lib/branch/*.js D:/projects/tutorials-poc/test/unit/branch/*.js`
Expected: every file says "ASCII text" or "UTF-8 text", NOT "with CRLF line terminators". If any file has CRLF, normalize via Node:

```bash
node -e "for (const f of process.argv.slice(1)) { const fs=require('fs'); fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(/\r\n/g, '\n')); }" D:/projects/tutorials-poc/srv/lib/branch/*.js D:/projects/tutorials-poc/test/unit/branch/*.js
```

- [ ] **Step 3: Confirm no eval / Function constructor crept in**

Run: `grep -nE "\\beval\\s*\\(|new\\s+Function\\(" D:/projects/tutorials-poc/srv/lib/branch/*.js`
Expected: no output.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feat/172-branching-paths-design
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create \
  --title "feat(172): branching paths foundation — engine, telemetry, master flag" \
  --body "$(cat <<'EOF'
Implements PR 1 of the issue #172 plan: substrate that PRs 2–6 will consume.

## What ships

- `srv/lib/branch/condition.js` — hand-rolled recursive-descent parser for the predicate DSL (no \`eval\`, no deps)
- `srv/lib/branch/engine.js` — \`pickBranch\` + \`evaluateSkip\` (deterministic; LLM never on the path)
- `srv/lib/branch/ranker.js` — heuristic ranker reusing \`recommend.js\` cosine helper
- `srv/lib/branch/user-state.js` — frozen userState builder + sha256 fingerprint for cache keys
- \`BranchDecisions\` entity + \`BranchSurface\`/\`BranchReasonKind\`/\`BranchSource\` type aliases
- \`ChatSettings.branchingEnabled\` master flag (default \`false\`)
- \`srv/lib/branch/*.js\` registered in the \`srv-qa\` cp list

## What does NOT ship (deferred to subsequent PRs)

- HTTP routes (\`/api/branches/decide\`, \`/build/mission/<slug>\`) — PR 2/3
- Schema columns on \`CompletionPathItems\` — PR 2
- Markdown markers and parser — PR 3
- Joule chat tool — PR 4
- Admin analytics tile — PR 5

## Tests

~44 new unit tests across condition.test.js / engine.test.js / ranker.test.js / user-state.test.js. No-LLM guarantee asserted via fetch spy. No new hybrid or smoke tests; integration tests land with the consuming PRs.

Refs #172 · spec: docs/superpowers/specs/2026-06-09-172-branching-paths-design.md
EOF
)" \
  --base main
```

---

## Definition of done for PR 1

- [ ] All 7 tasks above complete and committed
- [ ] `npx vitest run --project unit` green
- [ ] `BranchDecisions` deploys cleanly (in-memory SQLite + HANA hybrid if available)
- [ ] PR opened against `main`
- [ ] Existing smoke tests on prior flows still pass — this PR adds nothing user-visible
- [ ] No new npm dependencies introduced
- [ ] `.deploy/mta.yaml` srv-qa cp list updated and verified

## Cross-references for downstream PRs

PR 2 (mission alt-groups) consumes:
- `pickBranch`, `evaluateSkip` from `srv/lib/branch/engine.js`
- `buildUserState`, `fingerprintUserState` from `srv/lib/branch/user-state.js`
- `BranchDecisions` for telemetry writes
- `branchingEnabled` for the master flag check

PR 3 (step branches + skip-runs) consumes the same modules.

PR 4 (Joule narration) consumes `pickBranch` directly (the chat tool calls it the same way as the HTTP endpoint).

PR 5 (analytics) reads `BranchDecisions`.

PR 6 (pilot) sets `branchingEnabled = true` on QA only.
