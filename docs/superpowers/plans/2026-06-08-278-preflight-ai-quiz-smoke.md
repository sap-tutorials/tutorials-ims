# Pre-go-live AI-Quiz Smoke Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a one-time pre-go-live smoke check (`scripts/preflight-ai-quiz-smoke.ts`) that runs the full AI-quiz pipeline against a random ~10% sample of tutorials and programmatically verifies five invariants per tutorial, emitting a JSON artifact + stdout summary that gates the AI-quiz spike's graduation (#275).

**Architecture:** Five pure invariant helpers live in a new `scripts/lib/ai-quiz-invariants.ts` module so they can be reused by the smoke script, the unit-test suite, and the eval harness. The smoke script samples slugs from `.tutorial-cache/_discovery.json` with a configurable seed, then loops sequentially: for each slug it shells out `cds bind --exec -- npm run fetch-tutorials -- --target hugo` with `AI_AUTHOR_ENABLED=true TUTORIAL_SLUG=<slug>`, captures the `[ai-author] expanded directives ...` summary line for the upstream-error invariant, then loads `.tutorial-cache/<slug>.ai-quiz-cache.json` and the parsed `rules.vr` (via the existing `parseRulesVrEnriched` to recover `handAuthoredSteps`), and runs the five invariants. The aggregate verdict (`safeToGraduate: boolean`) plus per-tutorial pass/fail rows are written to `verdicts/preflight-smoke.json`. No CDS schema changes; no recurring CI hookup.

**Tech Stack:** TypeScript (tsx), vitest, Node `node:child_process` for the per-slug subprocess, `seedrandom` (already in repo? if not — `mulberry32` inline since the issue specifies reproducibility, not crypto-grade randomness). Reuses `scripts/lib/ai-quiz-cache.ts`, `scripts/parsers/rules.ts`, `.tutorial-cache/_discovery.json`.

---

## File Structure

**Create:**
- `scripts/lib/ai-quiz-invariants.ts` — Five pure invariant helpers (precedence, anti-leak, MCQ shape, generator sanity, summary parser). Exports `runAllInvariants(input): InvariantResult[]` plus each helper individually for test reuse.
- `scripts/__tests__/ai-quiz-invariants.test.ts` — Vitest suite covering each helper: synthetic happy path + each known failure mode (the four bug shapes from PRs #261 and #277 plus the precedence violation the issue calls out).
- `scripts/preflight-ai-quiz-smoke.ts` — CLI entry point. Parses `--sample N`, `--seed S`, `--step-cap N`, `--output PATH`, `--dry-run`, `--slugs <comma-list>` (override sampling for repro). Loops sample, spawns subprocess per slug, calls invariants, writes JSON artifact + stdout summary.
- `scripts/__tests__/preflight-ai-quiz-smoke.test.ts` — Tests for the pure pieces of the CLI: `sampleSlugs(catalog, n, seed)` reproducibility, `parseSummaryLine(stdout)` extraction, `summarizeVerdict(rows)` aggregation. The subprocess loop itself is not unit-tested (it's the one thing the smoke is supposed to test — mocking it would defeat the purpose).
- `verdicts/.gitkeep` — Output dir for the artifact, gitignored except this marker.

**Modify:**
- `package.json` — Add `"preflight:ai-quiz-smoke": "tsx scripts/preflight-ai-quiz-smoke.ts"` to scripts.
- `.gitignore` — Add `verdicts/*` and `!verdicts/.gitkeep`.
- `docs/developers/architecture/ai-authored-quizzes.md` — Append a "Pre-go-live smoke runbook" section: when to run, how to interpret artifact, expected wall-clock + cost, what to do on failure.
- `https://github.com/sap-tutorials/tutorials-ims/issues/275` — Add an "AC: smoke pass" item via `gh issue edit` (final task).

---

### Task 1: Define the InvariantResult shape and the input contract

**Files:**
- Create: `scripts/lib/ai-quiz-invariants.ts`

The five invariants need a uniform return shape so the smoke script's verdict aggregation is one line. Define types only in this task — no logic yet — so subsequent tasks can be written in TDD style with the type already locked in.

- [ ] **Step 1: Skim the existing cache type so the input contract matches**

Read `scripts/lib/ai-quiz-cache.ts:20-32` and `scripts/parsers/types.ts:26-65` to confirm `AiQuizCacheEntry` and `ValidationQuestion` shapes. The invariant input must accept these without any conversion.

- [ ] **Step 2: Write the type module**

```typescript
// scripts/lib/ai-quiz-invariants.ts
import type { AiQuizCache, AiQuizCacheEntry } from './ai-quiz-cache'
import type { ValidationQuestion } from '../parsers/types'

export type InvariantName =
  | 'no-upstream-errors'
  | 'precedence'
  | 'anti-leak'
  | 'mcq-shape'
  | 'generator-sanity'

export interface InvariantResult {
  name: InvariantName
  passed: boolean
  /** Empty when passed=true; one-line human reason when passed=false. */
  reason?: string
  /** Optional structured details (step number, question id, etc.) for the JSON artifact. */
  details?: Record<string, unknown>
}

export interface InvariantInput {
  slug: string
  cache: AiQuizCache
  /** Set of step numbers that have ANY [VALIDATE_N] block. From parseRulesVrEnriched. */
  handAuthoredSteps: Set<number>
  /** The single line emitted by fetch-tutorials.ts:1075-1082 starting with "[ai-author] expanded directives". */
  summaryLine: string | null
  /** Current expected promptVersion. Defaults to PROMPT_VERSION constant, overridable for forward-compat tests. */
  expectedPromptVersion?: string
}
```

- [ ] **Step 3: Verify the file compiles**

Run: `npx tsc --noEmit scripts/lib/ai-quiz-invariants.ts`
Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/ai-quiz-invariants.ts
git commit -m "feat(preflight): define InvariantResult + InvariantInput contracts (#278)"
```

---

### Task 2: Invariant 1 — no-upstream-errors (parses the summary line)

**Files:**
- Create: `scripts/__tests__/ai-quiz-invariants.test.ts`
- Modify: `scripts/lib/ai-quiz-invariants.ts`

The `[ai-author] expanded directives ...` summary is emitted once per fetch-tutorials run (fetch-tutorials.ts:1075-1082). Its format is verbatim:

```
[ai-author] expanded directives across all tutorials: <N> cache miss (LLM call), <N> cache hit, <N> errors. Build cap: <N>.
```

We MUST parse `<N> errors` and assert it's 0. This is the same line PR #261's first Critical bug would have surfaced — `errors > 0` means the pipeline broke upstream of any cache write.

- [ ] **Step 1: Write the failing tests**

```typescript
// scripts/__tests__/ai-quiz-invariants.test.ts
import { describe, it, expect } from 'vitest'
import { invariantNoUpstreamErrors } from '../lib/ai-quiz-invariants'

describe('invariantNoUpstreamErrors', () => {
  it('passes when summary line shows 0 errors', () => {
    const line = '[ai-author] expanded directives across all tutorials: 6 cache miss (LLM call), 0 cache hit, 0 errors. Build cap: 200.'
    const result = invariantNoUpstreamErrors(line)
    expect(result.passed).toBe(true)
    expect(result.name).toBe('no-upstream-errors')
  })

  it('fails when summary line shows non-zero errors', () => {
    const line = '[ai-author] expanded directives across all tutorials: 4 cache miss (LLM call), 0 cache hit, 2 errors. Build cap: 200.'
    const result = invariantNoUpstreamErrors(line)
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/2 errors/)
    expect(result.details?.errors).toBe(2)
  })

  it('fails when summary line is missing entirely (subprocess crashed before emit)', () => {
    const result = invariantNoUpstreamErrors(null)
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/no \[ai-author\] summary line captured/i)
  })

  it('fails when summary line is malformed (regex miss)', () => {
    const line = '[ai-author] expanded directives — something garbled'
    const result = invariantNoUpstreamErrors(line)
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/could not parse/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/__tests__/ai-quiz-invariants.test.ts`
Expected: 4 fails with "invariantNoUpstreamErrors is not a function".

- [ ] **Step 3: Implement the helper**

Append to `scripts/lib/ai-quiz-invariants.ts`:

```typescript
const SUMMARY_REGEX = /^\[ai-author\] expanded directives across all tutorials: (\d+) cache miss \(LLM call\), (\d+) cache hit, (\d+) errors\. Build cap: \d+\.$/

export function invariantNoUpstreamErrors(summaryLine: string | null): InvariantResult {
  const name: InvariantName = 'no-upstream-errors'
  if (summaryLine === null) {
    return { name, passed: false, reason: 'no [ai-author] summary line captured (subprocess may have crashed before emit)' }
  }
  const match = summaryLine.match(SUMMARY_REGEX)
  if (!match) {
    return { name, passed: false, reason: `could not parse summary line: ${summaryLine}` }
  }
  const errors = Number(match[3])
  if (errors > 0) {
    return { name, passed: false, reason: `${errors} errors reported in summary`, details: { errors, miss: Number(match[1]), hit: Number(match[2]) } }
  }
  return { name, passed: true, details: { errors: 0, miss: Number(match[1]), hit: Number(match[2]) } }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run scripts/__tests__/ai-quiz-invariants.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/ai-quiz-invariants.ts scripts/__tests__/ai-quiz-invariants.test.ts
git commit -m "feat(preflight): invariant 1 — no-upstream-errors (#278)"
```

---

### Task 3: Invariant 2 — precedence (handAuthoredSteps ⊥ cache.entries)

The issue's first listed invariant: *"for every step in `handAuthoredSteps`, the cache's `entries` map MUST NOT contain that step number."* This is the bug PR #277 shipped — regex-substring blocks without `###Question` weren't being recorded in `handAuthoredSteps`, so the all-directive AI fired on top of them.

The cache's `entries` map is keyed by **step number as string** (per `scripts/lib/ai-quiz-cache.ts:30`).

**Files:**
- Modify: `scripts/lib/ai-quiz-invariants.ts`
- Modify: `scripts/__tests__/ai-quiz-invariants.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { invariantPrecedence } from '../lib/ai-quiz-invariants'
import type { AiQuizCache } from '../lib/ai-quiz-cache'

const emptyCache = (): AiQuizCache => ({ promptVersion: 'v1', modelName: 'fake', entries: {} })

const cacheWithStep = (n: number): AiQuizCache => ({
  promptVersion: 'v1',
  modelName: 'fake',
  entries: {
    [String(n)]: {
      stepHash: 'h',
      directive: '[AUTOAUTHOR_ALL]',
      types: 'mcq-and-text',
      generatedAt: '2026-06-08T00:00:00Z',
      questions: [],
    },
  },
})

describe('invariantPrecedence', () => {
  it('passes when no overlap', () => {
    const result = invariantPrecedence(cacheWithStep(2), new Set([1, 3]))
    expect(result.passed).toBe(true)
  })

  it('passes when both empty', () => {
    expect(invariantPrecedence(emptyCache(), new Set()).passed).toBe(true)
  })

  it('fails when AI fired on a hand-authored step (the PR #277 bug shape)', () => {
    const result = invariantPrecedence(cacheWithStep(3), new Set([3, 5]))
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/step 3/)
    expect(result.details?.violatingSteps).toEqual([3])
  })

  it('reports all violating steps when multiple', () => {
    const cache = cacheWithStep(2)
    cache.entries['4'] = { ...cache.entries['2'] }
    const result = invariantPrecedence(cache, new Set([2, 4]))
    expect(result.details?.violatingSteps).toEqual([2, 4])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/__tests__/ai-quiz-invariants.test.ts -t invariantPrecedence`
Expected: 4 fails.

- [ ] **Step 3: Implement the helper**

```typescript
export function invariantPrecedence(cache: AiQuizCache, handAuthoredSteps: Set<number>): InvariantResult {
  const name: InvariantName = 'precedence'
  const violating: number[] = []
  for (const stepKey of Object.keys(cache.entries)) {
    const stepNum = Number(stepKey)
    if (Number.isFinite(stepNum) && handAuthoredSteps.has(stepNum)) {
      violating.push(stepNum)
    }
  }
  violating.sort((a, b) => a - b)
  if (violating.length > 0) {
    return {
      name,
      passed: false,
      reason: `AI questions cached for hand-authored step(s): ${violating.join(', ')}`,
      details: { violatingSteps: violating },
    }
  }
  return { name, passed: true }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run scripts/__tests__/ai-quiz-invariants.test.ts -t invariantPrecedence`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/ai-quiz-invariants.ts scripts/__tests__/ai-quiz-invariants.test.ts
git commit -m "feat(preflight): invariant 2 — precedence (#278)"
```

---

### Task 4: Invariant 3 — anti-leak (text questions have `__aiCorrectAnswer` and no public `correctAnswer`)

The issue's third invariant: *"every text question MUST have `__aiCorrectAnswer` set AND no `correctAnswer`."* Per the type comment at `scripts/parsers/types.ts:46-64`, `__aiCorrectAnswer` is the build-time sentinel; `correctAnswer` MUST be undefined on AI-graded text questions because the reference answer ships server-side via `ValidateAnswerSpecs` (PR #234).

A leak here means the public Hugo frontmatter would contain the answer key — issue #209's whole point was to prevent that.

**Files:**
- Modify: `scripts/lib/ai-quiz-invariants.ts`
- Modify: `scripts/__tests__/ai-quiz-invariants.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { invariantAntiLeak } from '../lib/ai-quiz-invariants'
import type { ValidationQuestion } from '../parsers/types'

const aiTextQuestion = (overrides: Partial<ValidationQuestion> = {}): ValidationQuestion => ({
  id: 'validate-3-ai-1',
  question: 'Why does X work?',
  type: 'text',
  aiAuthored: true,
  aiGrading: true,
  __aiCorrectAnswer: 'Because of Y.',
  ...overrides,
})

const wrapInCache = (qs: ValidationQuestion[]): AiQuizCache => ({
  promptVersion: 'v1',
  modelName: 'fake',
  entries: {
    '3': { stepHash: 'h', directive: '[AUTOAUTHOR_3]', types: 'text-only', generatedAt: 'now', questions: qs },
  },
})

describe('invariantAntiLeak', () => {
  it('passes for a clean text question', () => {
    expect(invariantAntiLeak(wrapInCache([aiTextQuestion()])).passed).toBe(true)
  })

  it('passes when no text questions exist', () => {
    expect(invariantAntiLeak(wrapInCache([])).passed).toBe(true)
  })

  it('fails when text question has correctAnswer set (leak)', () => {
    const leaky = aiTextQuestion({ correctAnswer: 'Because of Y.' })
    const result = invariantAntiLeak(wrapInCache([leaky]))
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/leak|correctAnswer/i)
  })

  it('fails when text question is missing __aiCorrectAnswer', () => {
    const stripped = { ...aiTextQuestion(), __aiCorrectAnswer: undefined }
    const result = invariantAntiLeak(wrapInCache([stripped]))
    expect(result.passed).toBe(false)
    expect(result.reason).toMatch(/__aiCorrectAnswer/)
  })

  it('skips MCQ questions (they DO have correctAnswer)', () => {
    const mcq: ValidationQuestion = {
      id: 'validate-3-ai-1',
      question: 'Pick one',
      type: 'multiple-choice',
      options: ['a', 'b'],
      correctAnswer: 'a',
      aiAuthored: true,
    }
    expect(invariantAntiLeak(wrapInCache([mcq])).passed).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/__tests__/ai-quiz-invariants.test.ts -t invariantAntiLeak`
Expected: 5 fails.

- [ ] **Step 3: Implement the helper**

```typescript
export function invariantAntiLeak(cache: AiQuizCache): InvariantResult {
  const name: InvariantName = 'anti-leak'
  const violations: Array<{ step: string; questionId: string; reason: string }> = []
  for (const [step, entry] of Object.entries(cache.entries)) {
    for (const q of entry.questions) {
      if (q.type !== 'text') continue
      if (q.correctAnswer !== undefined) {
        violations.push({ step, questionId: q.id, reason: 'correctAnswer set on AI text question (leak)' })
      }
      if (q.__aiCorrectAnswer === undefined || q.__aiCorrectAnswer === '') {
        violations.push({ step, questionId: q.id, reason: '__aiCorrectAnswer missing on AI text question' })
      }
    }
  }
  if (violations.length > 0) {
    return {
      name,
      passed: false,
      reason: violations.map(v => `step ${v.step} q=${v.questionId}: ${v.reason}`).join('; '),
      details: { violations },
    }
  }
  return { name, passed: true }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run scripts/__tests__/ai-quiz-invariants.test.ts -t invariantAntiLeak`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/ai-quiz-invariants.ts scripts/__tests__/ai-quiz-invariants.test.ts
git commit -m "feat(preflight): invariant 3 — anti-leak (#278)"
```

---

### Task 5: Invariant 4 — mcq-shape (2-4 options, correctAnswer ∈ options verbatim)

The issue's fourth invariant: *"every MCQ MUST have 2–4 options AND a `correctAnswer` that appears verbatim in `options`."* Verbatim equality (no whitespace trimming) — the validation widget `hugo-apps/src/validation/grading.ts` does exact-string match against options.

**Files:**
- Modify: `scripts/lib/ai-quiz-invariants.ts`
- Modify: `scripts/__tests__/ai-quiz-invariants.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { invariantMcqShape } from '../lib/ai-quiz-invariants'

const mcq = (overrides: Partial<ValidationQuestion> = {}): ValidationQuestion => ({
  id: 'validate-3-ai-1',
  question: 'Pick',
  type: 'multiple-choice',
  options: ['alpha', 'beta', 'gamma'],
  correctAnswer: 'alpha',
  aiAuthored: true,
  ...overrides,
})

describe('invariantMcqShape', () => {
  it('passes for 3-option MCQ with valid answer', () => {
    expect(invariantMcqShape(wrapInCache([mcq()])).passed).toBe(true)
  })

  it('passes for 2 and 4 option MCQ', () => {
    expect(invariantMcqShape(wrapInCache([mcq({ options: ['a', 'b'], correctAnswer: 'a' })])).passed).toBe(true)
    expect(invariantMcqShape(wrapInCache([mcq({ options: ['a', 'b', 'c', 'd'], correctAnswer: 'd' })])).passed).toBe(true)
  })

  it('fails for 1 option', () => {
    const r = invariantMcqShape(wrapInCache([mcq({ options: ['only'], correctAnswer: 'only' })]))
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/1 option/)
  })

  it('fails for 5 options', () => {
    const r = invariantMcqShape(wrapInCache([mcq({ options: ['a', 'b', 'c', 'd', 'e'] })]))
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/5 option/)
  })

  it('fails when options missing entirely', () => {
    const r = invariantMcqShape(wrapInCache([mcq({ options: undefined })]))
    expect(r.passed).toBe(false)
  })

  it('fails when correctAnswer missing', () => {
    const r = invariantMcqShape(wrapInCache([mcq({ correctAnswer: undefined })]))
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/correctAnswer/)
  })

  it('fails when correctAnswer is not in options (verbatim)', () => {
    const r = invariantMcqShape(wrapInCache([mcq({ correctAnswer: 'Alpha' /* capital A */ })]))
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/not in options/i)
  })

  it('skips text questions', () => {
    const text: ValidationQuestion = { id: 't', question: 'Why', type: 'text', aiAuthored: true, __aiCorrectAnswer: 'because' }
    expect(invariantMcqShape(wrapInCache([text])).passed).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/__tests__/ai-quiz-invariants.test.ts -t invariantMcqShape`
Expected: 8 fails.

- [ ] **Step 3: Implement the helper**

```typescript
export function invariantMcqShape(cache: AiQuizCache): InvariantResult {
  const name: InvariantName = 'mcq-shape'
  const violations: Array<{ step: string; questionId: string; reason: string }> = []
  for (const [step, entry] of Object.entries(cache.entries)) {
    for (const q of entry.questions) {
      if (q.type !== 'multiple-choice') continue
      const options = q.options
      if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
        violations.push({ step, questionId: q.id, reason: `${options?.length ?? 0} options (expected 2–4)` })
        continue
      }
      if (q.correctAnswer === undefined || q.correctAnswer === '') {
        violations.push({ step, questionId: q.id, reason: 'correctAnswer missing' })
        continue
      }
      if (!options.includes(q.correctAnswer)) {
        violations.push({ step, questionId: q.id, reason: `correctAnswer not in options (verbatim)` })
      }
    }
  }
  if (violations.length > 0) {
    return {
      name,
      passed: false,
      reason: violations.map(v => `step ${v.step} q=${v.questionId}: ${v.reason}`).join('; '),
      details: { violations },
    }
  }
  return { name, passed: true }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run scripts/__tests__/ai-quiz-invariants.test.ts -t invariantMcqShape`
Expected: 8 pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/ai-quiz-invariants.ts scripts/__tests__/ai-quiz-invariants.test.ts
git commit -m "feat(preflight): invariant 4 — mcq-shape (#278)"
```

---

### Task 6: Invariant 5 — generator-sanity (promptVersion, modelName, ≥1 question)

The issue's fifth invariant: *"every cache entry MUST have `promptVersion: 'v1'` (or the current version), a `modelName`, and at least 1 question."* Note `promptVersion` and `modelName` live on the cache **root**, not the per-entry record (`scripts/lib/ai-quiz-cache.ts:28-31`). The "≥1 question" rule applies per-entry.

**Files:**
- Modify: `scripts/lib/ai-quiz-invariants.ts`
- Modify: `scripts/__tests__/ai-quiz-invariants.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { invariantGeneratorSanity } from '../lib/ai-quiz-invariants'

describe('invariantGeneratorSanity', () => {
  const goodCache = (): AiQuizCache => ({
    promptVersion: 'v1',
    modelName: 'anthropic--claude-4.6-sonnet',
    entries: {
      '3': {
        stepHash: 'h',
        directive: '[AUTOAUTHOR_3]',
        types: 'mcq-only',
        generatedAt: 'now',
        questions: [{ id: 'q', question: 'Pick', type: 'multiple-choice', options: ['a', 'b'], correctAnswer: 'a' }],
      },
    },
  })

  it('passes a fully-formed cache', () => {
    expect(invariantGeneratorSanity(goodCache(), 'v1').passed).toBe(true)
  })

  it('passes an empty entries map (no AI ran on this tutorial)', () => {
    const c: AiQuizCache = { promptVersion: 'v1', modelName: 'm', entries: {} }
    expect(invariantGeneratorSanity(c, 'v1').passed).toBe(true)
  })

  it('fails when promptVersion mismatches expected', () => {
    const c = goodCache()
    c.promptVersion = 'v0'
    const r = invariantGeneratorSanity(c, 'v1')
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/promptVersion/)
  })

  it('fails when modelName is empty (entries non-empty)', () => {
    const c = goodCache()
    c.modelName = ''
    expect(invariantGeneratorSanity(c, 'v1').passed).toBe(false)
  })

  it('fails when an entry has zero questions', () => {
    const c = goodCache()
    c.entries['3'].questions = []
    const r = invariantGeneratorSanity(c, 'v1')
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/0 questions/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/__tests__/ai-quiz-invariants.test.ts -t invariantGeneratorSanity`
Expected: 5 fails.

- [ ] **Step 3: Implement the helper**

```typescript
export function invariantGeneratorSanity(cache: AiQuizCache, expectedPromptVersion: string): InvariantResult {
  const name: InvariantName = 'generator-sanity'
  const hasEntries = Object.keys(cache.entries).length > 0
  if (hasEntries) {
    if (cache.promptVersion !== expectedPromptVersion) {
      return { name, passed: false, reason: `promptVersion ${cache.promptVersion} != expected ${expectedPromptVersion}` }
    }
    if (!cache.modelName || cache.modelName.length === 0) {
      return { name, passed: false, reason: 'modelName empty on non-empty cache' }
    }
  }
  const empties: string[] = []
  for (const [step, entry] of Object.entries(cache.entries)) {
    if (entry.questions.length === 0) empties.push(step)
  }
  if (empties.length > 0) {
    return { name, passed: false, reason: `entries with 0 questions: ${empties.join(', ')}`, details: { emptySteps: empties } }
  }
  return { name, passed: true }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run scripts/__tests__/ai-quiz-invariants.test.ts -t invariantGeneratorSanity`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/ai-quiz-invariants.ts scripts/__tests__/ai-quiz-invariants.test.ts
git commit -m "feat(preflight): invariant 5 — generator-sanity (#278)"
```

---

### Task 7: `runAllInvariants` aggregator + `PROMPT_VERSION` re-export

The smoke script needs one entry point that runs all five invariants and returns `InvariantResult[]`. Default `expectedPromptVersion` to the canonical `'v1'` from `srv/lib/ai-quiz-generator.js:17`. Since the generator is JS (not TS-typed), re-export the constant value here as a typed string.

**Files:**
- Modify: `scripts/lib/ai-quiz-invariants.ts`
- Modify: `scripts/__tests__/ai-quiz-invariants.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { runAllInvariants, CURRENT_PROMPT_VERSION } from '../lib/ai-quiz-invariants'

describe('runAllInvariants', () => {
  it('returns 5 results in stable name order', () => {
    const results = runAllInvariants({
      slug: 'fake',
      cache: { promptVersion: 'v1', modelName: 'm', entries: {} },
      handAuthoredSteps: new Set(),
      summaryLine: '[ai-author] expanded directives across all tutorials: 0 cache miss (LLM call), 0 cache hit, 0 errors. Build cap: 200.',
    })
    expect(results.map(r => r.name)).toEqual([
      'no-upstream-errors',
      'precedence',
      'anti-leak',
      'mcq-shape',
      'generator-sanity',
    ])
    expect(results.every(r => r.passed)).toBe(true)
  })

  it('uses CURRENT_PROMPT_VERSION when expectedPromptVersion omitted', () => {
    expect(CURRENT_PROMPT_VERSION).toBe('v1')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/__tests__/ai-quiz-invariants.test.ts -t runAllInvariants`
Expected: 2 fails.

- [ ] **Step 3: Implement**

```typescript
export const CURRENT_PROMPT_VERSION = 'v1'

export function runAllInvariants(input: InvariantInput): InvariantResult[] {
  const expected = input.expectedPromptVersion ?? CURRENT_PROMPT_VERSION
  return [
    invariantNoUpstreamErrors(input.summaryLine),
    invariantPrecedence(input.cache, input.handAuthoredSteps),
    invariantAntiLeak(input.cache),
    invariantMcqShape(input.cache),
    invariantGeneratorSanity(input.cache, expected),
  ]
}
```

- [ ] **Step 4: Run all invariant tests**

Run: `npx vitest run scripts/__tests__/ai-quiz-invariants.test.ts`
Expected: all tests from Tasks 2-7 pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/ai-quiz-invariants.ts scripts/__tests__/ai-quiz-invariants.test.ts
git commit -m "feat(preflight): runAllInvariants aggregator + CURRENT_PROMPT_VERSION (#278)"
```

---

### Task 8: Sampling helper — `sampleSlugs(catalog, n, seed)` reproducible

The smoke script must sample reproducibly so a `--seed` rerun on the same catalog selects the same slugs. Use a small inline mulberry32 PRNG (no dep) — quality is irrelevant, reproducibility is the point.

**Files:**
- Create: `scripts/preflight-ai-quiz-smoke.ts` (start with the helper export only)
- Create: `scripts/__tests__/preflight-ai-quiz-smoke.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// scripts/__tests__/preflight-ai-quiz-smoke.test.ts
import { describe, it, expect } from 'vitest'
import { sampleSlugs } from '../preflight-ai-quiz-smoke'

const CATALOG = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']

describe('sampleSlugs', () => {
  it('returns exactly n items', () => {
    expect(sampleSlugs(CATALOG, 3, 42).length).toBe(3)
  })

  it('returns unique items', () => {
    const r = sampleSlugs(CATALOG, 5, 42)
    expect(new Set(r).size).toBe(5)
  })

  it('is reproducible across calls with the same seed', () => {
    const a = sampleSlugs(CATALOG, 4, 1234)
    const b = sampleSlugs(CATALOG, 4, 1234)
    expect(a).toEqual(b)
  })

  it('produces different output for different seeds', () => {
    const a = sampleSlugs(CATALOG, 4, 1)
    const b = sampleSlugs(CATALOG, 4, 2)
    expect(a).not.toEqual(b)
  })

  it('returns the whole catalog (sorted? or shuffled?) when n >= catalog.length', () => {
    const r = sampleSlugs(CATALOG, 100, 42)
    expect(r.length).toBe(CATALOG.length)
    expect(new Set(r)).toEqual(new Set(CATALOG))
  })

  it('returns empty array for n=0', () => {
    expect(sampleSlugs(CATALOG, 0, 42)).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/__tests__/preflight-ai-quiz-smoke.test.ts`
Expected: 6 fails.

- [ ] **Step 3: Implement**

```typescript
// scripts/preflight-ai-quiz-smoke.ts (start the file with this)
function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function sampleSlugs(catalog: readonly string[], n: number, seed: number): string[] {
  if (n <= 0) return []
  const sorted = [...catalog].sort() // canonical order so seed → output is stable across catalog orderings
  if (n >= sorted.length) return sorted
  const rng = mulberry32(seed)
  // Fisher-Yates partial shuffle
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (sorted.length - i))
    ;[sorted[i], sorted[j]] = [sorted[j], sorted[i]]
  }
  return sorted.slice(0, n)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run scripts/__tests__/preflight-ai-quiz-smoke.test.ts`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/preflight-ai-quiz-smoke.ts scripts/__tests__/preflight-ai-quiz-smoke.test.ts
git commit -m "feat(preflight): sampleSlugs reproducible PRNG helper (#278)"
```

---

### Task 9: `parseSummaryLine` extractor + `summarizeVerdict` aggregator

The subprocess writes the `[ai-author] ...` line somewhere in the stdout stream. Need a robust extractor that finds the **last** matching line (in case earlier runs print debug info). And the per-tutorial `InvariantResult[]` rolls up to a verdict.

**Files:**
- Modify: `scripts/preflight-ai-quiz-smoke.ts`
- Modify: `scripts/__tests__/preflight-ai-quiz-smoke.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { extractSummaryLine, summarizeVerdict } from '../preflight-ai-quiz-smoke'
import type { InvariantResult } from '../lib/ai-quiz-invariants'

describe('extractSummaryLine', () => {
  it('finds the line in interleaved stdout', () => {
    const stdout = [
      'fetched X',
      '[ai-author] expanded directives across all tutorials: 6 cache miss (LLM call), 0 cache hit, 0 errors. Build cap: 200.',
      'wrote hugo/content/...',
    ].join('\n')
    expect(extractSummaryLine(stdout)).toMatch(/^\[ai-author\]/)
  })

  it('returns null when missing', () => {
    expect(extractSummaryLine('boring output')).toBeNull()
  })

  it('returns the LAST occurrence when duplicated', () => {
    const stdout = [
      '[ai-author] expanded directives across all tutorials: 1 cache miss (LLM call), 0 cache hit, 0 errors. Build cap: 200.',
      '[ai-author] expanded directives across all tutorials: 5 cache miss (LLM call), 0 cache hit, 2 errors. Build cap: 200.',
    ].join('\n')
    expect(extractSummaryLine(stdout)).toMatch(/2 errors/)
  })
})

describe('summarizeVerdict', () => {
  const okRow = (slug: string): InvariantResult[] => [
    { name: 'no-upstream-errors', passed: true },
    { name: 'precedence', passed: true },
    { name: 'anti-leak', passed: true },
    { name: 'mcq-shape', passed: true },
    { name: 'generator-sanity', passed: true },
  ]
  const failRow = (): InvariantResult[] => [
    { name: 'no-upstream-errors', passed: true },
    { name: 'precedence', passed: false, reason: 'step 3 leaked' },
    { name: 'anti-leak', passed: true },
    { name: 'mcq-shape', passed: true },
    { name: 'generator-sanity', passed: true },
  ]

  it('safeToGraduate=true when all rows pass', () => {
    const verdict = summarizeVerdict([
      { slug: 'a', results: okRow('a'), durationMs: 1000 },
      { slug: 'b', results: okRow('b'), durationMs: 1100 },
    ])
    expect(verdict.safeToGraduate).toBe(true)
    expect(verdict.totals.passed).toBe(2)
    expect(verdict.totals.failed).toBe(0)
  })

  it('safeToGraduate=false on any fail', () => {
    const verdict = summarizeVerdict([
      { slug: 'a', results: okRow('a'), durationMs: 1000 },
      { slug: 'b', results: failRow(), durationMs: 1100 },
    ])
    expect(verdict.safeToGraduate).toBe(false)
    expect(verdict.totals.failed).toBe(1)
    expect(verdict.failedSlugs).toEqual(['b'])
  })

  it('counts failures by invariant name', () => {
    const verdict = summarizeVerdict([
      { slug: 'a', results: failRow(), durationMs: 1 },
      { slug: 'b', results: failRow(), durationMs: 1 },
    ])
    expect(verdict.failuresByInvariant.precedence).toBe(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run scripts/__tests__/preflight-ai-quiz-smoke.test.ts -t 'extractSummaryLine|summarizeVerdict'`
Expected: 6 fails.

- [ ] **Step 3: Implement**

Append to `scripts/preflight-ai-quiz-smoke.ts`:

```typescript
import type { InvariantResult, InvariantName } from './lib/ai-quiz-invariants'

const SUMMARY_LINE_PREFIX = '[ai-author] expanded directives across all tutorials:'

export function extractSummaryLine(stdout: string): string | null {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith(SUMMARY_LINE_PREFIX)) return trimmed
  }
  return null
}

export interface PerTutorialRow {
  slug: string
  results: InvariantResult[]
  durationMs: number
  /** Only set when the subprocess crashed before any invariant could run. */
  fatalError?: string
}

export interface Verdict {
  safeToGraduate: boolean
  totals: { passed: number; failed: number; total: number }
  failedSlugs: string[]
  failuresByInvariant: Record<InvariantName, number>
  rows: PerTutorialRow[]
  generatedAt: string
}

export function summarizeVerdict(rows: PerTutorialRow[]): Verdict {
  const failuresByInvariant: Record<InvariantName, number> = {
    'no-upstream-errors': 0,
    'precedence': 0,
    'anti-leak': 0,
    'mcq-shape': 0,
    'generator-sanity': 0,
  }
  const failedSlugs: string[] = []
  let passed = 0
  for (const row of rows) {
    const rowFailed = row.fatalError !== undefined || row.results.some(r => !r.passed)
    if (rowFailed) {
      failedSlugs.push(row.slug)
      for (const r of row.results) {
        if (!r.passed) failuresByInvariant[r.name]++
      }
    } else {
      passed++
    }
  }
  return {
    safeToGraduate: failedSlugs.length === 0,
    totals: { passed, failed: failedSlugs.length, total: rows.length },
    failedSlugs,
    failuresByInvariant,
    rows,
    generatedAt: new Date().toISOString(),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run scripts/__tests__/preflight-ai-quiz-smoke.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/preflight-ai-quiz-smoke.ts scripts/__tests__/preflight-ai-quiz-smoke.test.ts
git commit -m "feat(preflight): extractSummaryLine + summarizeVerdict (#278)"
```

---

### Task 10: Per-slug runner — spawn `cds bind --exec`, capture summary, run invariants

This is the orchestration core. For each slug it must:
1. Run the subprocess with `AI_AUTHOR_ENABLED=true`, `TUTORIAL_SLUG=<slug>`, `AI_AUTHOR_BUILD_CAP=<cap>`, command: `cds bind --exec -- npm run fetch-tutorials -- --target hugo`. Inherit env, capture stdout/stderr.
2. Extract the summary line.
3. Load `.tutorial-cache/<slug>.ai-quiz-cache.json` via `loadAiQuizCache`.
4. Re-parse `rules.vr` from the same cache file `.tutorial-cache/<slug>.rules.vr` via `parseRulesVrEnriched` to recover `handAuthoredSteps`.
5. Call `runAllInvariants` and return a `PerTutorialRow`.

If the subprocess exits non-zero or `rules.vr` is missing, return `{ fatalError: ... }` so the verdict still records the row as failed.

**Files:**
- Modify: `scripts/preflight-ai-quiz-smoke.ts`

This task does NOT add unit tests — the runner shells out and reads disk; mocking either makes the test useless. The runner is small and gets exercised in Task 12 when we run the smoke against a 1-tutorial sample on real infra. Keep it tight.

- [ ] **Step 1: Inspect the existing rules.vr cache pattern**

The fetch-tutorials script already caches `rules.vr` at `.tutorial-cache/<slug>.rules.vr` (per CLAUDE.md "Validation quiz data from `-Contribution` repos" gotcha). Confirm:

```bash
ls D:/projects/tutorials-poc/.tutorial-cache/ | grep -E '\.rules\.vr$' | head -3
```

- [ ] **Step 2: Implement the runner**

Append to `scripts/preflight-ai-quiz-smoke.ts`:

```typescript
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadAiQuizCache } from './lib/ai-quiz-cache'
import { parseRulesVrEnriched } from './parsers/rules'
import { runAllInvariants, CURRENT_PROMPT_VERSION } from './lib/ai-quiz-invariants'

export interface RunOptions {
  buildCap: number
  cacheDir: string  // default: '.tutorial-cache'
  cwd: string       // default: process.cwd()
  /** When true, skip the subprocess and read pre-existing cache only (for dry-runs against an already-seeded cache). */
  skipSubprocess?: boolean
}

export async function runOneSlug(slug: string, opts: RunOptions): Promise<PerTutorialRow> {
  const start = Date.now()
  let summaryLine: string | null = null
  let fatalError: string | undefined

  if (!opts.skipSubprocess) {
    const env = {
      ...process.env,
      AI_AUTHOR_ENABLED: 'true',
      TUTORIAL_SLUG: slug,
      AI_AUTHOR_BUILD_CAP: String(opts.buildCap),
    }
    // cds bind --exec inherits the bound HANA env into the inner npm run.
    const child = spawnSync(
      'cds',
      ['bind', '--exec', '--', 'npm', 'run', 'fetch-tutorials', '--', '--target', 'hugo'],
      { cwd: opts.cwd, env, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32' },
    )
    if (child.status !== 0) {
      fatalError = `subprocess exited ${child.status}: ${(child.stderr ?? '').slice(-500)}`
    }
    summaryLine = extractSummaryLine((child.stdout ?? '') + '\n' + (child.stderr ?? ''))
  }

  // Load cache + rules.vr regardless of subprocess outcome — partial output is useful.
  const cachePath = join(opts.cwd, opts.cacheDir, `${slug}.ai-quiz-cache.json`)
  const rulesPath = join(opts.cwd, opts.cacheDir, `${slug}.rules.vr`)
  let handAuthoredSteps = new Set<number>()
  let cache = { promptVersion: CURRENT_PROMPT_VERSION, modelName: '', entries: {} }

  if (existsSync(cachePath)) {
    cache = loadAiQuizCache(slug, { cacheDir: join(opts.cwd, opts.cacheDir) })
  }
  if (existsSync(rulesPath)) {
    try {
      const parsed = parseRulesVrEnriched(readFileSync(rulesPath, 'utf-8'))
      handAuthoredSteps = parsed.handAuthoredSteps
    } catch (err) {
      fatalError = fatalError ?? `parseRulesVrEnriched failed: ${(err as Error).message}`
    }
  }

  const results = runAllInvariants({ slug, cache, handAuthoredSteps, summaryLine })
  return { slug, results, durationMs: Date.now() - start, fatalError }
}
```

> **Note:** `loadAiQuizCache` already accepts `{ cacheDir }` (see `scripts/lib/ai-quiz-cache.ts:54`). No edit to that file needed.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit scripts/preflight-ai-quiz-smoke.ts`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add scripts/preflight-ai-quiz-smoke.ts
git commit -m "feat(preflight): per-slug runner spawns cds bind --exec (#278)"
```

---

### Task 11: CLI wrapper — flags, catalog load, loop, artifact write, exit code

**Files:**
- Modify: `scripts/preflight-ai-quiz-smoke.ts`
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `verdicts/.gitkeep`

- [ ] **Step 1: Implement the CLI**

Append to `scripts/preflight-ai-quiz-smoke.ts`:

```typescript
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface CliArgs {
  sample: number
  seed: number
  buildCap: number
  output: string
  slugs: string[] | null
  dryRun: boolean
}

export function parseCli(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    sample: 0, // 0 means "10% of catalog"
    seed: 42,
    buildCap: 10000,
    output: 'verdicts/preflight-smoke.json',
    slugs: null,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--sample': args.sample = Number(argv[++i]); break
      case '--seed': args.seed = Number(argv[++i]); break
      case '--build-cap': args.buildCap = Number(argv[++i]); break
      case '--output': args.output = argv[++i]; break
      case '--slugs': args.slugs = argv[++i].split(',').map(s => s.trim()).filter(Boolean); break
      case '--dry-run': args.dryRun = true; break
      case '--help': case '-h':
        console.log(`Usage: preflight-ai-quiz-smoke [--sample N] [--seed N] [--build-cap N] [--output PATH] [--slugs a,b,c] [--dry-run]`)
        process.exit(0)
    }
  }
  return args
}

function loadCatalog(cwd: string): string[] {
  const path = join(cwd, '.tutorial-cache', '_discovery.json')
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  return Object.keys(raw)
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2))
  const cwd = process.cwd()
  const catalog = loadCatalog(cwd)
  let chosen: string[]
  if (args.slugs) {
    chosen = args.slugs
    console.log(`[preflight] explicit --slugs: ${chosen.length} tutorials`)
  } else {
    const n = args.sample > 0 ? args.sample : Math.ceil(catalog.length * 0.1)
    chosen = sampleSlugs(catalog, n, args.seed)
    console.log(`[preflight] sampled ${chosen.length} of ${catalog.length} tutorials (seed=${args.seed})`)
  }

  const rows: PerTutorialRow[] = []
  for (let i = 0; i < chosen.length; i++) {
    const slug = chosen[i]
    process.stdout.write(`[preflight] [${i + 1}/${chosen.length}] ${slug} ... `)
    const row = await runOneSlug(slug, {
      buildCap: args.buildCap,
      cacheDir: '.tutorial-cache',
      cwd,
      skipSubprocess: args.dryRun,
    })
    const failed = row.fatalError !== undefined || row.results.some(r => !r.passed)
    process.stdout.write(`${failed ? 'FAIL' : 'pass'} (${row.durationMs}ms)\n`)
    if (failed) {
      for (const r of row.results.filter(x => !x.passed)) console.log(`    - ${r.name}: ${r.reason}`)
      if (row.fatalError) console.log(`    - fatal: ${row.fatalError}`)
    }
    rows.push(row)
  }

  const verdict = summarizeVerdict(rows)
  mkdirSync(dirname(args.output), { recursive: true })
  writeFileSync(args.output, JSON.stringify(verdict, null, 2), 'utf-8')

  console.log('\n=== preflight verdict ===')
  console.log(`  safeToGraduate: ${verdict.safeToGraduate}`)
  console.log(`  ${verdict.totals.passed}/${verdict.totals.total} tutorials passed`)
  if (verdict.failedSlugs.length > 0) {
    console.log(`  failed: ${verdict.failedSlugs.join(', ')}`)
    console.log(`  by invariant:`)
    for (const [name, count] of Object.entries(verdict.failuresByInvariant)) {
      if (count > 0) console.log(`    ${name}: ${count}`)
    }
  }
  console.log(`  artifact: ${args.output}`)

  process.exit(verdict.safeToGraduate ? 0 : 2)
}

// Run main only when invoked directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('preflight-ai-quiz-smoke.ts')) {
  main().catch(err => { console.error(err); process.exit(3) })
}
```

> **Exit code convention:** match `publish-content.ts` — `0` clean, `2` invariant-fail, `3` unexpected exception. Documented in the runbook.

- [ ] **Step 2: Add the npm script**

In `package.json`, add to the `scripts` block (alphabetical position):

```json
"preflight:ai-quiz-smoke": "tsx scripts/preflight-ai-quiz-smoke.ts",
```

- [ ] **Step 3: Add gitignore + .gitkeep**

```bash
echo 'verdicts/*' >> .gitignore
echo '!verdicts/.gitkeep' >> .gitignore
mkdir -p verdicts
touch verdicts/.gitkeep
```

- [ ] **Step 4: Smoke-test the CLI in dry-run mode (no LLM calls)**

This validates wiring without burning $$. Pick 1 slug that already has a cache file on disk:

```bash
ls .tutorial-cache/*.ai-quiz-cache.json | head -1
# pick the slug from that filename, e.g. "abap-cloud-ui-from-interface"
npm run preflight:ai-quiz-smoke -- --slugs <one-slug> --dry-run
```

Expected: prints `pass` or `FAIL` for that slug, writes `verdicts/preflight-smoke.json`, exits 0 or 2.

- [ ] **Step 5: Commit**

```bash
git add scripts/preflight-ai-quiz-smoke.ts package.json .gitignore verdicts/.gitkeep
git commit -m "feat(preflight): CLI wrapper + npm script + verdict artifact (#278)"
```

---

### Task 12: Live smoke run — 5-tutorial sample to validate the end-to-end path

Before running the full ~138 sample (which costs $8-14), validate end-to-end with a 5-slug sample. This catches subprocess wiring bugs cheap (~$0.30) and produces a sample artifact for the runbook screenshot.

**Files:** none modified — this is a runtime validation step.

- [ ] **Step 1: Confirm `cf login` to DEV space and `cds bind` is configured**

```bash
cf target | grep -E 'space|api'
cds bind --list 2>&1 | head -20
```

Expected: target shows `dev` space; `cds bind --list` shows a `db` binding.

- [ ] **Step 2: Run the smoke against 5 random slugs**

```bash
npm run preflight:ai-quiz-smoke -- --sample 5 --seed 99
```

Expected wall-clock: ~3-8 minutes. Expected output: 5 lines `[preflight] [N/5] <slug> ... pass|FAIL (Nms)`, then a verdict block.

- [ ] **Step 3: Inspect the artifact**

```bash
jq '{safeToGraduate, totals, failedSlugs, failuresByInvariant}' verdicts/preflight-smoke.json
```

If `safeToGraduate=false` and the failures look like real bugs (not smoke-script bugs): triage the failures BEFORE the full run. The whole point of the smoke is to surface them.

If the failures look like smoke-script bugs (e.g. `parseSummaryLine` regex miss because the log format drifted): fix the script, retest with the same `--seed 99`.

- [ ] **Step 4: Document the results inline**

Add a brief comment block near the top of `scripts/preflight-ai-quiz-smoke.ts` recording the date + seed + outcome of this validation run. Future operators benefit from knowing the script was validated end-to-end.

- [ ] **Step 5: Commit (script comment update only — verdict artifact is gitignored)**

```bash
git add scripts/preflight-ai-quiz-smoke.ts
git commit -m "chore(preflight): record initial validation run results (#278)"
```

---

### Task 12.5: Live smoke run — full ~138-tutorial sample (the AC gate run)

The issue's AC: *"Smoke run against ~138 tutorials emits a JSON artifact + stdout summary."* This is the run that satisfies it. Cost: ~$8–$14, wall-clock: ~30–60 min.

**Files:** none modified — runtime invocation. The verdict artifact lives in `verdicts/` (gitignored).

- [ ] **Step 1: Confirm DEV space + Anthropic budget headroom**

```bash
cf target | grep -E 'space|api'
```

Expected: `dev` space.

If this is the first AI-quiz seed run for some sampled slugs, the cost may skew higher than $14 because empty caches mean every step gets a fresh LLM call. Worst case is bounded by `AI_AUTHOR_BUILD_CAP=10000` per slug × 138 slugs, but real-world average is ~6 calls/tutorial.

- [ ] **Step 2: Run the full smoke**

```bash
npm run preflight:ai-quiz-smoke -- --seed 278
```

Use seed 278 (matching the issue number) for canonical reproducibility — anyone re-running should get the same sample. Default 10% of catalog (`Math.ceil(catalog.length * 0.1)` ≈ 138).

This will run for 30–60 minutes. Stream the output to a tee file for post-mortem:

```bash
npm run preflight:ai-quiz-smoke -- --seed 278 2>&1 | tee verdicts/preflight-run.log
```

- [ ] **Step 3: Triage the artifact**

```bash
jq '{safeToGraduate, totals, failedSlugs, failuresByInvariant}' verdicts/preflight-smoke.json
```

**If `safeToGraduate: true`:** Done. The AC is satisfied. Proceed to Task 13.

**If `safeToGraduate: false`:**
1. Read the per-slug failures in stdout (or `jq '.rows[] | select(.results[] | .passed == false)' verdicts/preflight-smoke.json`).
2. Group by invariant. A pattern (same invariant failing on many slugs) usually indicates a code regression in the AI-quiz pipeline — that's exactly what the smoke is supposed to catch.
3. Fix the bug at its source (likely in `scripts/parsers/rules.ts`, `scripts/lib/expand-ai-authored.ts`, or `srv/lib/ai-quiz-generator.js`), then re-run the smoke with the same seed: `npm run preflight:ai-quiz-smoke -- --seed 278`.
4. Iterate until `safeToGraduate: true`.

The fixes-during-smoke loop is the **whole point** of this PR — it's better to find and fix bugs here than at graduation time when authors are waiting on the rollout.

- [ ] **Step 4: Snapshot the artifact for the PR description**

The artifact itself is gitignored, but copy a summary into the PR description for the reviewer:

```bash
jq '{safeToGraduate, totals, failuresByInvariant}' verdicts/preflight-smoke.json
```

Capture this output for paste-back into Task 15's PR body.

- [ ] **Step 5: No commit needed** — the artifact is gitignored. The Task 12 script comment already records the validation pattern; if Task 12.5 surfaced + fixed bugs, those fix commits already landed during Step 3.

---

### Task 13: Documentation — runbook in `ai-authored-quizzes.md`

**Files:**
- Modify: `docs/developers/architecture/ai-authored-quizzes.md`

- [ ] **Step 1: Read the existing doc structure**

```bash
grep -n '^##' docs/developers/architecture/ai-authored-quizzes.md
```

Note the existing heading style (likely `## Section Name`).

- [ ] **Step 2: Append the runbook section**

Append to the doc:

````markdown
## Pre-go-live smoke runbook

The pre-go-live smoke (`npm run preflight:ai-quiz-smoke`) is a one-time gate run before the AI-quiz spike graduates (#278). It samples a fraction of the catalog and runs the full pipeline against each, checking five invariants programmatically.

### When to run

- Before #275 graduation hand-grading (mandatory; see #275's acceptance criteria).
- When a new `promptVersion` lands (e.g. v2 / RAG-enriched prompt).
- When the runtime model changes (e.g. swap to a newer Claude or different orchestration deployment).
- When a schema migration touches `ValidateAnswerSpecs` (no longer applies if `__aiCorrectAnswer` field shape changes — re-check from `scripts/parsers/types.ts:46`).

### Cost + wall-clock

10% of ~1,379 = ~138 tutorials × ~6 LLM calls each = ~828 calls × ~$0.01 = **~$8–$14 per run**. Sequential per-slug `cds bind --exec` runs ~30–60 minutes wall-clock.

For cheaper validation: `--sample 5` runs in ~5 minutes for ~$0.30.

### Running it

Prereqs: `cf login` to DEV space, `cds bind` configured to the prod-like HANA.

```bash
# Default: 10% of catalog with seed 42
npm run preflight:ai-quiz-smoke

# Reproducible re-run (any operator on any machine)
npm run preflight:ai-quiz-smoke -- --seed 1234

# Smaller sample for tighter feedback
npm run preflight:ai-quiz-smoke -- --sample 20

# Specific slugs (e.g. re-checking a single failure)
npm run preflight:ai-quiz-smoke -- --slugs cap-getting-started,abap-cloud-ui-from-interface

# Dry-run against pre-existing cache (no LLM calls)
npm run preflight:ai-quiz-smoke -- --slugs cap-getting-started --dry-run
```

### Reading the artifact

`verdicts/preflight-smoke.json`:

```jsonc
{
  "safeToGraduate": false,                  // gate: true=ok to graduate, false=fix bugs first
  "totals": { "passed": 135, "failed": 3, "total": 138 },
  "failedSlugs": ["a", "b", "c"],
  "failuresByInvariant": {
    "no-upstream-errors": 0,
    "precedence": 2,                        // ← 2 tutorials failed precedence
    "anti-leak": 0,
    "mcq-shape": 1,
    "generator-sanity": 0
  },
  "rows": [ /* per-tutorial details with reasons */ ]
}
```

### What each invariant means

| Invariant | What it checks | Bug shape it catches |
|-----------|----------------|----------------------|
| `no-upstream-errors` | Pipeline summary line shows `0 errors` | PR #261's `cds.entities is not a function` + HTTP 400 contract bug |
| `precedence` | No cache entry for any step in `handAuthoredSteps` | PR #277's regex-substring + case-sensitive `[X]` bugs |
| `anti-leak` | Text questions have `__aiCorrectAnswer` and no public `correctAnswer` | Future regressions of issue #209's leak-prevention |
| `mcq-shape` | MCQs have 2–4 options and `correctAnswer` ∈ `options` verbatim | Generator emits malformed MCQ |
| `generator-sanity` | `promptVersion` matches expected, `modelName` non-empty, every entry has ≥1 question | Generator silently emits empty entries / wrong promptVersion |

### Triage on failure

1. **Exit code 2** = invariant violations. **Exit code 3** = unexpected exception (read stderr, fix script bug, re-run).
2. Read `failuresByInvariant` to spot the pattern. A single invariant failing on many tutorials usually means a code regression. Many invariants failing on a single tutorial usually means that tutorial's `rules.vr` is malformed.
3. Re-run a single failing slug: `npm run preflight:ai-quiz-smoke -- --slugs <one-slug>`.
4. **Do not** mark #275 graduation acceptable until `safeToGraduate: true`.

### What this is NOT

- Not a recurring CI check. ~$10/run is too expensive to run weekly to find bugs we already shipped.
- Not a quality grader. It checks pipeline mechanics, not whether questions are good. #275 covers quality (human hand-grading).
````

- [ ] **Step 3: Verify the doc renders cleanly**

```bash
npm run docs:build
```

Expected: no broken-link errors. (The predocs:build sidebar guard fires here — the new section is appended to an existing page, so no sidebar update needed.)

- [ ] **Step 4: Commit**

```bash
git add docs/developers/architecture/ai-authored-quizzes.md
git commit -m "docs(preflight): runbook for pre-go-live smoke (#278)"
```

---

### Task 14: Update #275 acceptance criteria via `gh issue edit`

**Files:** none — runs `gh` against GitHub.

- [ ] **Step 1: Read current #275 body**

```bash
gh issue view 275 --repo sap-tutorials/tutorials-ims --json body -q .body > /tmp/issue-275.md
cat /tmp/issue-275.md
```

- [ ] **Step 2: Append the smoke gate to the AC**

Edit `/tmp/issue-275.md` locally to add a new bullet under the Acceptance criteria section:

```markdown
- [ ] Pre-go-live smoke (#278, `npm run preflight:ai-quiz-smoke`) returns `safeToGraduate: true` against the chosen sample.
```

Then push it back:

```bash
gh issue edit 275 --repo sap-tutorials/tutorials-ims --body-file /tmp/issue-275.md
```

- [ ] **Step 3: Verify**

```bash
gh issue view 275 --repo sap-tutorials/tutorials-ims | grep -A2 'preflight'
```

Expected: shows the new bullet.

- [ ] **Step 4: Final commit (none — this is a GitHub-side edit)**

No git commit needed for this task.

---

### Task 15: PR + branch wrap-up

**Files:** none — branch hygiene.

- [ ] **Step 1: Verify clean unit + smoke test pass**

```bash
npm test -- scripts/__tests__/ai-quiz-invariants.test.ts scripts/__tests__/preflight-ai-quiz-smoke.test.ts
```

Expected: all green.

- [ ] **Step 2: Verify branch is not main**

```bash
git branch --show-current
```

If on `main`, abort and re-do this work on a feature branch. Per [[feedback_verify_branch_before_commit]] this harness can silently flip branches between Bash invocations.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin <feature-branch>
gh pr create --repo sap-tutorials/tutorials-ims --title "feat(preflight): pre-go-live AI-quiz smoke check (#278)" --body "$(cat <<'EOF'
Closes #278.

Implements a one-time pre-go-live smoke check that runs the full AI-quiz pipeline against a random ~10% sample of tutorials and programmatically verifies five invariants per tutorial (no-upstream-errors, precedence, anti-leak, mcq-shape, generator-sanity).

## Why

Two rounds of the AI-quiz spike (#208) shipped Critical bugs that mocked tests missed and only live pilots caught (#261, #277). Before the spike graduates, we need one bug-finding pass that exercises real-world tutorial diversity.

## Files

- `scripts/lib/ai-quiz-invariants.ts` — five pure helpers + `runAllInvariants` aggregator
- `scripts/preflight-ai-quiz-smoke.ts` — CLI: samples, spawns `cds bind --exec` per slug, writes `verdicts/preflight-smoke.json`
- Unit tests for both
- Runbook in `docs/developers/architecture/ai-authored-quizzes.md`
- Updated #275 AC to gate graduation on a clean smoke

## Validation

5-slug sample run (Task 12) passed end-to-end. Verdict artifact format documented in runbook.

## Cost

~$8–$14 per full run, ~30–60 min wall-clock. Not wired to CI — invoked ad-hoc per the runbook triggers.
EOF
)"
```

- [ ] **Step 4: Surface PR URL to Tom**

The PR is now ready for human review. Per [[feedback_pr_over_direct_merge]], do NOT fast-merge.

---

## Done criteria (rolled up from issue AC)

- [x] Smoke script at `scripts/preflight-ai-quiz-smoke.ts` with `--sample`, `--seed`, `--slugs`, `--build-cap`, `--output`, `--dry-run`.
- [x] Pure invariant helpers exported from `scripts/lib/ai-quiz-invariants.ts` for reuse by tests + future eval-harness sanity checks.
- [x] Unit tests cover each invariant: synthetic happy path + each known failure mode (PR #261 & #277 bug shapes).
- [x] Runbook in `docs/developers/architecture/ai-authored-quizzes.md` covers when, how, what to do on failure.
- [x] 5-slug live validation run produces a sample artifact.
- [x] #275 AC updated to gate graduation on `safeToGraduate: true`.
