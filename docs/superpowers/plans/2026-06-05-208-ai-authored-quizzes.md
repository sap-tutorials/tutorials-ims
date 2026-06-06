# AI-Authored Quizzes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a build-time generator that, on author opt-in via `[AUTOAUTHOR_*]` directives in `rules.vr`, produces `[VALIDATE_N]` candidate questions for tutorial steps that don't already have hand-authored ones — emitting the same `ValidationQuestion` shape so AI-authored questions are indistinguishable from hand-authored at the consumer end.

**Architecture:** Post-parse pipeline step (Approach B from the spec). The parser (`scripts/parsers/rules.ts`) recognizes `[AUTOAUTHOR_*]` directives and emits sentinel placeholders; a new `expandAiAuthoredQuestions()` step in `scripts/fetch-tutorials.ts` swaps real questions in for the placeholders. Parser stays synchronous. Default-OFF behind `AI_AUTHOR_ENABLED=true`; per-tutorial content-hash cache; hard cap (default 200 calls per build).

**Tech Stack:** Node.js 20+ + TypeScript (build pipeline) + JavaScript (`srv/lib/` runtime modules) + `@sap-ai-sdk/orchestration` (forced tool-call wrapper from `srv/lib/code-check-llm.js`, reused) + Vitest (unit tests).

**Spec:** [`docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md`](../specs/2026-06-05-208-ai-authored-quizzes-design.md)

**Tracking issue:** [sap-tutorials/tutorials-ims#208](https://github.com/sap-tutorials/tutorials-ims/issues/208)

**Depends on:** PR #226 (#212 — validation widget; AI questions render through it), PR #234 (#209 — free-text grader; AI text questions submit through `/api/validate-answer`).

---

## Working assumptions

- You will work on a feature branch `feature/208-ai-authored-quizzes` cut from `spec/208-ai-authored-quizzes` (already created at `.worktrees/spec-208`).
- Branch hygiene: every commit verifies `git branch --show-current` shows `feature/208-ai-authored-quizzes` (per `feedback_verify_branch_before_commit` — the harness can silently flip the branch between bash invocations).
- TDD discipline on every new module: write failing test → run → implement → run → commit. The spec's "Test plan" enumerates the cases per module; this plan preserves that count and the Red→Green order.
- `cf login` is NOT required for any task — there is no HANA component in this feature. No hybrid test.
- The full unit suite (`npm test`) reliably hangs in fresh worktrees per `feedback_worktree_tests_hang`. Run targeted test files only.
- Worktree was set up by the brainstorming skill at `d:/projects/tutorials-poc/.worktrees/spec-208`. `npm install --ignore-scripts=false` has been run; `node_modules/.bin/vitest` is available.

## Useful skills

- `superpowers:test-driven-development` — for the TDD discipline on each new module
- `superpowers:verification-before-completion` — before claiming a task done

## File map

**New files:**
- `srv/lib/ai-quiz-generator.js` — pure LLM-call module: `generateQuiz({ stepBody, stepNumber, slug, types, deps })` → `{ questions, errorReason?, modelName, promptTokens, completionTokens, latencyMs, promptVersion }`. System prompt + user message + forced tool-call schema + 3 anti-leak guards. Mirrors `srv/lib/validate-answer-prompt.js` shape.
- `srv/lib/__tests__/ai-quiz-generator.test.js` — 10 unit tests with mock `callModel`.
- `scripts/lib/ai-quiz-cache.ts` — content-hash cache over per-tutorial sidecar files. `loadAiQuizCache(slug)`, `saveAiQuizCache(slug, cache)`, `cache.get(stepHash)`, `cache.put(stepHash, entry)`. Hash key uses `\x00`-separated concatenation.
- `scripts/__tests__/ai-quiz-cache.test.ts` — 4 unit tests.
- `scripts/lib/expand-ai-authored.ts` — post-parse expansion. `expandAiAuthoredQuestions(parsedMap, stepBodies, deps)`. Honors hard cap, emits one-line build summary.
- `scripts/__tests__/expand-ai-authored.test.ts` — 6 unit tests.
- `scripts/parsers/__tests__/rules-autoauthor.test.ts` — 6 parser-directive tests.
- `test/integration/ai-quiz-flow.test.ts` — end-to-end: synthetic rules.vr → expanded frontmatter → cache hit on re-run.
- `scripts/evaluate-ai-quizzes.ts` — CSV emitter CLI: read pilot-slug caches, emit side-by-side rows.
- `scripts/__tests__/evaluate-ai-quizzes.test.ts` — 3 unit tests on the CSV-shaping helper.
- `scripts/aggregate-ai-quiz-eval.ts` — read filled CSV(s), print would-ship report.
- `scripts/__tests__/aggregate-ai-quiz-eval.test.ts` — 3 unit tests on aggregation math + rejection-note tokenization.
- `docs/developers/architecture/ai-authored-quizzes.md` — developer reference (~50 lines): flow diagram, directive syntax, runbook, cost table, exit criteria.

**Modified files:**
- `scripts/parsers/types.ts` — add `aiAuthored?: boolean` to `ValidationQuestion`. Internal placeholder fields (`__autoauthor`, `__directiveTypes`) declared in `rules.ts`, NOT exported here (placeholder shape is internal contract).
- `scripts/parsers/rules.ts` — recognize `[AUTOAUTHOR_N]`, `[AUTOAUTHOR_N:mcq]`, `[AUTOAUTHOR_N:text]`, `[AUTOAUTHOR_ALL]`, `[AUTOAUTHOR_ALL:mcq]`, `[AUTOAUTHOR_ALL:text]`. Emit sentinel placeholders only for steps that lack hand-authored `[VALIDATE_N]` (precedence rule).
- `scripts/fetch-tutorials.ts` — wire `expandAiAuthoredQuestions()` between `parseRulesVrEnriched()` (line 657) and `collectAiGradedSpecs()` (line 678) behind `AI_AUTHOR_ENABLED === 'true'`.
- `package.json` — new `seed-ai-quizzes` script.
- `docs/.vitepress/config.ts` — sidebar entry for the new architecture doc.
- `CLAUDE.md` — Gotchas entry: `AI_AUTHOR_ENABLED` flag + cap + cache invalidation.

---

## Phase 1 — Parser foundation (no LLM, all sync, fast TDD loop)

End state after Phase 1: parser recognizes `[AUTOAUTHOR_*]` directives, emits sentinel placeholders for steps missing hand-authored `[VALIDATE_N]`, hand-authored content always wins. No LLM calls anywhere. All work TDD-first; the placeholder shape becomes the contract Phase 2/3 build against.

### Task 1: Extend `ValidationQuestion` with `aiAuthored` field

**Files:**
- Modify: `scripts/parsers/types.ts`
- Test: extends existing `test/unit/rules-parser-grading.test.js` if present, else stand-alone in Task 2's new file.

This task is one-line in production code; included as a separate task purely so Task 2's tests can rely on the field existing.

- [ ] **Step 1: Read existing types.ts**

Run: `cat scripts/parsers/types.ts`
Confirm `ValidationQuestion` interface exists; note its current fields (`id`, `question`, `type`, `options?`, `correctAnswer?`, `aiGrading?`).

- [ ] **Step 2: Add `aiAuthored?: boolean`**

Edit `scripts/parsers/types.ts`. Add the field below `aiGrading`:

```ts
export interface ValidationQuestion {
  id: string
  question: string
  type: 'multiple-choice' | 'text'
  options?: string[]
  correctAnswer?: string  // omitted for AI-graded text questions (#209)
  aiGrading?: boolean     // server-side grading via /api/validate-answer (#209)
  // [#208] Set true when this question was generated by the AI quiz
  // generator. Joins to the eval harness; ships in public frontmatter
  // for MCQ + sidecar for text. Indistinguishable from hand-authored
  // questions to the validation widget.
  aiAuthored?: boolean
}
```

- [ ] **Step 3: Type-check**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx tsc --noEmit -p . 2>&1 | tail -20`
Expected: no new errors related to `ValidationQuestion`.

- [ ] **Step 4: Commit**

```bash
cd d:/projects/tutorials-poc/.worktrees/spec-208 && \
  BR=$(git branch --show-current) && [ "$BR" = "feature/208-ai-authored-quizzes" ] && \
  git add scripts/parsers/types.ts && \
  git commit -m "feat(types): add ValidationQuestion.aiAuthored telemetry field (#208)

Joins to the eval harness in scripts/evaluate-ai-quizzes.ts (Task 8)
and distinguishes generator-authored questions from hand-authored
ones in published content. Optional field; existing consumers ignore
unknown properties."
```

---

### Task 2: Recognize `[AUTOAUTHOR_*]` directives in parser

**Files:**
- Modify: `scripts/parsers/rules.ts`
- Test: `scripts/parsers/__tests__/rules-autoauthor.test.ts` (new)

Six test cases per the spec's Test plan section:

1. `[AUTOAUTHOR_3]` → placeholder for step 3 with `types: 'mcq-and-text'`.
2. `[AUTOAUTHOR_3:mcq]` → `types: 'mcq-only'`.
3. `[AUTOAUTHOR_3:text]` → `types: 'text-only'`.
4. `[AUTOAUTHOR_ALL]` → placeholders for every step that has no `[VALIDATE_N]`.
5. `[AUTOAUTHOR_ALL:mcq]` + per-step `[AUTOAUTHOR_3:text]` → step 3 honors `text`, others honor `mcq`.
6. Step has both `[VALIDATE_3]` and `[AUTOAUTHOR_3]` → `[VALIDATE_3]` wins; no placeholder emitted for step 3.

The placeholder shape is internal — emit it as a sentinel `ValidationQuestion` with two non-typed fields:

```ts
{
  id: `autoauthor-${stepNum}`,
  question: '__autoauthor_placeholder__',
  type: 'text',
  // sentinel fields (not in ValidationQuestion's exported type — contract with Phase 3)
  __autoauthor: true,
  __directiveTypes: 'mcq-and-text' | 'mcq-only' | 'text-only',
}
```

Phase 3's `expandAiAuthoredQuestions` looks for `__autoauthor === true`, reads `__directiveTypes`, swaps in real questions. Frontmatter emission strips any remaining placeholder (defensive — Phase 3 should clear them all in normal flow, but the strip protects against orphans when `AI_AUTHOR_ENABLED=false`).

- [ ] **Step 1: Write the failing tests (all 6 cases)**

Create `scripts/parsers/__tests__/rules-autoauthor.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseRulesVrEnriched } from '../rules.js'

describe('parseRulesVrEnriched — [AUTOAUTHOR_*] directives (#208)', () => {
  it('per-step [AUTOAUTHOR_N] emits placeholder with mcq-and-text default', () => {
    const content = `[AUTOAUTHOR_3]
`
    const { map } = parseRulesVrEnriched(content)
    const placeholders = map.get(3) ?? []
    expect(placeholders).toHaveLength(1)
    expect(placeholders[0]).toMatchObject({
      id: 'autoauthor-3',
      __autoauthor: true,
      __directiveTypes: 'mcq-and-text',
    })
  })

  it('[AUTOAUTHOR_N:mcq] sets types: mcq-only', () => {
    const content = `[AUTOAUTHOR_5:mcq]
`
    const { map } = parseRulesVrEnriched(content)
    expect(map.get(5)?.[0].__directiveTypes).toBe('mcq-only')
  })

  it('[AUTOAUTHOR_N:text] sets types: text-only', () => {
    const content = `[AUTOAUTHOR_2:text]
`
    const { map } = parseRulesVrEnriched(content)
    expect(map.get(2)?.[0].__directiveTypes).toBe('text-only')
  })

  it('[AUTOAUTHOR_ALL] emits placeholders for every step with stepNumbers via context', () => {
    // [AUTOAUTHOR_ALL] is a tutorial-wide directive — it doesn't know the
    // step list at parse time. The parser records it on the result so
    // Phase 3 (expandAiAuthoredQuestions) expands it against the actual
    // list of steps fetch-tutorials.ts has.
    const content = `[AUTOAUTHOR_ALL]
`
    const { allDirective } = parseRulesVrEnriched(content)
    expect(allDirective).toEqual({ types: 'mcq-and-text', present: true })
  })

  it('per-step [AUTOAUTHOR_N:text] overrides [AUTOAUTHOR_ALL:mcq]', () => {
    const content = `[AUTOAUTHOR_ALL:mcq]
[AUTOAUTHOR_3:text]
`
    const { map, allDirective } = parseRulesVrEnriched(content)
    expect(allDirective).toEqual({ types: 'mcq-only', present: true })
    expect(map.get(3)?.[0].__directiveTypes).toBe('text-only')
  })

  it('hand-authored [VALIDATE_N] wins over [AUTOAUTHOR_N] on the same step', () => {
    const content = `[VALIDATE_3]
###Rule
exact-match
###Question
What is X?
###Match
The answer.
[AUTOAUTHOR_3]
`
    const { map } = parseRulesVrEnriched(content)
    const step3 = map.get(3) ?? []
    expect(step3).toHaveLength(1)
    expect(step3[0].__autoauthor).toBeUndefined()
    expect(step3[0].correctAnswer).toBe('The answer.')
  })
})
```

- [ ] **Step 2: Run tests, expect failure**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx vitest run scripts/parsers/__tests__/rules-autoauthor.test.ts`
Expected: 6 failures. Some tests fail because `parseRulesVrEnriched` doesn't return `allDirective`; others because `[AUTOAUTHOR_*]` lines are unknown to the parser and silently ignored.

- [ ] **Step 3: Update `parseRulesVrEnriched` return type**

Edit `scripts/parsers/rules.ts`. Find the existing return-type declaration (around line 13–15):

```ts
export function parseRulesVr(content: string): Map<number, ValidationQuestion[]> {
  return parseRulesVrEnriched(content).map
}

export function parseRulesVrEnriched(content: string): {
  map: Map<number, ValidationQuestion[]>
  ruleTypeByStepAndId: Map<string, string>
  correctAnswerByStepAndId: Map<string, string>
}
```

Extend the return type to include the optional all-directive:

```ts
export function parseRulesVrEnriched(content: string): {
  map: Map<number, ValidationQuestion[]>
  ruleTypeByStepAndId: Map<string, string>
  correctAnswerByStepAndId: Map<string, string>
  // [#208] tutorial-wide [AUTOAUTHOR_ALL] / [AUTOAUTHOR_ALL:mcq|text] directive,
  // captured for the post-parse expansion step (it doesn't know the step list
  // until fetch-tutorials.ts iterates `steps`).
  allDirective?: { types: 'mcq-and-text' | 'mcq-only' | 'text-only'; present: true }
}
```

- [ ] **Step 4: Add the AUTOAUTHOR markers + parsing**

Add these constants near the top of `scripts/parsers/rules.ts`, alongside the existing `VALIDATE_MARKER`:

```ts
const AUTOAUTHOR_PER_STEP_MARKER = /^\[AUTOAUTHOR_(\d+)(?::(mcq|text))?\]\s*$/
const AUTOAUTHOR_ALL_MARKER = /^\[AUTOAUTHOR_ALL(?::(mcq|text))?\]\s*$/

type AutoAuthorTypes = 'mcq-and-text' | 'mcq-only' | 'text-only'
function suffixToTypes(suffix: 'mcq' | 'text' | undefined): AutoAuthorTypes {
  if (suffix === 'mcq') return 'mcq-only'
  if (suffix === 'text') return 'text-only'
  return 'mcq-and-text'
}
```

In `parseRulesVrEnriched`'s main loop, BEFORE the existing `VALIDATE_MARKER` match, add directive recognition. The exact insertion point is where individual lines are scanned for top-level markers. After the existing logic populates `map`, post-process to drop AUTOAUTHOR placeholders for any step that has hand-authored content:

```ts
// (inside parseRulesVrEnriched, in the line-scanning loop)
const allMatch = line.match(AUTOAUTHOR_ALL_MARKER)
if (allMatch) {
  allDirective = { types: suffixToTypes(allMatch[1] as any), present: true }
  continue
}
const perStepMatch = line.match(AUTOAUTHOR_PER_STEP_MARKER)
if (perStepMatch) {
  const num = Number(perStepMatch[1])
  const types = suffixToTypes(perStepMatch[2] as any)
  perStepAutoAuthor.set(num, types)
  continue
}
```

After the main loop completes, materialize per-step placeholders for any step in `perStepAutoAuthor` that does NOT already have content in `map`:

```ts
for (const [num, types] of perStepAutoAuthor) {
  if ((map.get(num) ?? []).length > 0) continue  // hand-authored wins
  map.set(num, [{
    id: `autoauthor-${num}`,
    question: '__autoauthor_placeholder__',
    type: 'text',
    __autoauthor: true,
    __directiveTypes: types,
  } as any])  // sentinel fields not on ValidationQuestion's exported type
}
```

The `[AUTOAUTHOR_ALL]` directive does NOT materialize placeholders here — Phase 3 expands it against the real step list. Just record it on the return.

- [ ] **Step 5: Run tests, verify pass**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx vitest run scripts/parsers/__tests__/rules-autoauthor.test.ts`
Expected: 6/6 passing.

- [ ] **Step 6: Run existing parser tests, verify no regression**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx vitest run scripts/parsers/__tests__/ test/unit/rules-parser-grading.test.js`
Expected: existing parser tests still pass. `[AUTOAUTHOR_*]` was previously unknown markup so any existing fixture without it is unaffected. If a regression appears, the most likely cause is the new directive recognition consuming a line that an existing test expected to be passed through — fix by ensuring the new branches `continue` without touching `currentNum` / `blockLines` state.

- [ ] **Step 7: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/208-ai-authored-quizzes" ] && \
  git add scripts/parsers/rules.ts scripts/parsers/__tests__/rules-autoauthor.test.ts && \
  git commit -m "feat(parser): recognize [AUTOAUTHOR_*] directives (#208)

Per-step [AUTOAUTHOR_N], [AUTOAUTHOR_N:mcq], [AUTOAUTHOR_N:text].
Tutorial-wide [AUTOAUTHOR_ALL], [AUTOAUTHOR_ALL:mcq],
[AUTOAUTHOR_ALL:text].

Per-step directives produce sentinel placeholders inside the existing
parsedMap (with __autoauthor + __directiveTypes contract fields) for
steps that do NOT already have hand-authored [VALIDATE_N] content
(precedence rule). The tutorial-wide directive doesn't materialize
placeholders — it's captured on the new \`allDirective\` field of the
parseRulesVrEnriched return so Phase 3's expansion step can apply it
against the actual step list (which fetch-tutorials.ts knows but the
parser does not).

6/6 unit tests pass; no regression in existing parser fixtures."
```

---

## Phase 2 — Pure modules (LLM mockable)

End state after Phase 2: prompt builder + schema + 3 anti-leak guards in `srv/lib/ai-quiz-generator.js` (mockable via injected `callModel`); content-hash cache helper in `scripts/lib/ai-quiz-cache.ts`. Both modules pure — no DB, no fetch beyond the injected dep. Tested independently of the parser and the build pipeline.

### Task 3: `ai-quiz-generator.js` — prompt + schema + anti-leak

**Files:**
- Create: `srv/lib/ai-quiz-generator.js`
- Test: `srv/lib/__tests__/ai-quiz-generator.test.js` (new)

10 unit tests per the spec's Test plan section. The module mirrors `srv/lib/validate-answer-prompt.js` shape: pure ESM, no DB, no fetch, `callModel` injected. Schema is the JSON-schema object the forced-tool-call SDK consumes.

- [ ] **Step 1: Read precedent**

Read `srv/lib/validate-answer-prompt.js` end-to-end. Note the `PROMPT_VERSION` export, the `buildSystemPrompt()` function, the schema object shape, the `redactReferenceLeaks` re-export. The new module follows the same structure.

- [ ] **Step 2: Write the failing test (all 10 cases)**

Create `srv/lib/__tests__/ai-quiz-generator.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { generateQuiz, PROMPT_VERSION } from '../ai-quiz-generator.js';

const MODEL_RESP = (questions) => ({
  toolCalls: [{
    name: 'submitQuiz',
    arguments: JSON.stringify({ questions }),
  }],
  modelName: 'gpt-test',
  promptTokens: 100,
  completionTokens: 200,
  finishReason: 'tool_call',
});

describe('generateQuiz (#208)', () => {
  it('happy MCQ + text mix returns valid ValidationQuestion[]', async () => {
    const callModel = vi.fn().mockResolvedValue(MODEL_RESP([
      { type: 'multiple-choice', question: 'Pick one', options: ['A', 'B', 'C', 'D'], correctAnswer: 'B' },
      { type: 'text', question: 'Explain X', correctAnswer: 'X is the thing that does Y.' },
    ]));
    const out = await generateQuiz({
      stepBody: 'A short tutorial step about thingies.',
      stepNumber: 3,
      slug: 'sample',
      types: 'mcq-and-text',
      deps: { callModel },
    });
    expect(out.errorReason).toBeUndefined();
    expect(out.questions).toHaveLength(2);
    expect(out.questions[0]).toMatchObject({
      id: 'validate-3-ai-1',
      type: 'multiple-choice',
      options: ['A', 'B', 'C', 'D'],
      correctAnswer: 'B',
      aiAuthored: true,
    });
    expect(out.questions[1]).toMatchObject({
      id: 'validate-3-ai-2',
      type: 'text',
      aiGrading: true,
      aiAuthored: true,
    });
    // Anti-leak: text question's correctAnswer NOT in public emit.
    expect(out.questions[1].correctAnswer).toBeUndefined();
    // Telemetry preserved.
    expect(out.modelName).toBe('gpt-test');
    expect(out.promptVersion).toBe(PROMPT_VERSION);
  });

  it('MCQ correctAnswer not in options → empty + errorReason', async () => {
    const callModel = vi.fn().mockResolvedValue(MODEL_RESP([
      { type: 'multiple-choice', question: 'Pick one', options: ['A', 'B', 'C', 'D'], correctAnswer: 'Z' },
    ]));
    const out = await generateQuiz({
      stepBody: 'x', stepNumber: 1, slug: 's', types: 'mcq-only', deps: { callModel },
    });
    expect(out.questions).toEqual([]);
    expect(out.errorReason).toBe('mcq_correct_not_in_options');
  });

  it('question text contains literal correctAnswer → empty + errorReason: leak_detected', async () => {
    const callModel = vi.fn().mockResolvedValue(MODEL_RESP([
      // The correctAnswer text appears verbatim inside the question.
      { type: 'text', question: 'What is "Apache Kafka"?', correctAnswer: 'Apache Kafka' },
    ]));
    const out = await generateQuiz({
      stepBody: 'x', stepNumber: 1, slug: 's', types: 'text-only', deps: { callModel },
    });
    expect(out.questions).toEqual([]);
    expect(out.errorReason).toBe('leak_detected');
  });

  it('callModel throws → empty + errorReason: upstream', async () => {
    const callModel = vi.fn().mockRejectedValue(new Error('network blip'));
    const out = await generateQuiz({
      stepBody: 'x', stepNumber: 1, slug: 's', types: 'mcq-only', deps: { callModel },
    });
    expect(out.questions).toEqual([]);
    expect(out.errorReason).toBe('upstream');
  });

  it('schema validation failure → empty + errorReason: schema', async () => {
    // No `questions` array on the response.
    const callModel = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'submitQuiz', arguments: JSON.stringify({ wrong: 'shape' }) }],
      modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
    });
    const out = await generateQuiz({
      stepBody: 'x', stepNumber: 1, slug: 's', types: 'mcq-only', deps: { callModel },
    });
    expect(out.questions).toEqual([]);
    expect(out.errorReason).toBe('schema');
  });

  it("types: 'mcq-only' includes 'multiple-choice' only in user message", async () => {
    const callModel = vi.fn().mockResolvedValue(MODEL_RESP([
      { type: 'multiple-choice', question: 'Q', options: ['a', 'b', 'c', 'd'], correctAnswer: 'a' },
    ]));
    await generateQuiz({
      stepBody: 'body', stepNumber: 1, slug: 's', types: 'mcq-only', deps: { callModel },
    });
    const userMsg = callModel.mock.calls[0][0].messages.find(m => m.role === 'user').content;
    expect(userMsg).toContain('multiple-choice');
    expect(userMsg).not.toContain('free-text');
  });

  it("types: 'text-only' includes 'free-text' only in user message", async () => {
    const callModel = vi.fn().mockResolvedValue(MODEL_RESP([
      { type: 'text', question: 'Q', correctAnswer: 'A' },
    ]));
    await generateQuiz({
      stepBody: 'body', stepNumber: 1, slug: 's', types: 'text-only', deps: { callModel },
    });
    const userMsg = callModel.mock.calls[0][0].messages.find(m => m.role === 'user').content;
    expect(userMsg).toContain('free-text');
    expect(userMsg).not.toContain('multiple-choice');
  });

  it('aiAuthored: true set on every emitted question', async () => {
    const callModel = vi.fn().mockResolvedValue(MODEL_RESP([
      { type: 'multiple-choice', question: 'Q', options: ['a', 'b', 'c', 'd'], correctAnswer: 'a' },
      { type: 'text', question: 'Q2', correctAnswer: 'A2' },
    ]));
    const out = await generateQuiz({
      stepBody: 'x', stepNumber: 1, slug: 's', types: 'mcq-and-text', deps: { callModel },
    });
    expect(out.questions.every(q => q.aiAuthored === true)).toBe(true);
  });

  it("text question's emit omits correctAnswer and sets aiGrading: true", async () => {
    const callModel = vi.fn().mockResolvedValue(MODEL_RESP([
      { type: 'text', question: 'Explain', correctAnswer: 'because reasons' },
    ]));
    const out = await generateQuiz({
      stepBody: 'x', stepNumber: 1, slug: 's', types: 'text-only', deps: { callModel },
    });
    expect(out.questions[0].correctAnswer).toBeUndefined();
    expect(out.questions[0].aiGrading).toBe(true);
  });

  it("MCQ's emit retains correctAnswer and does NOT set aiGrading", async () => {
    const callModel = vi.fn().mockResolvedValue(MODEL_RESP([
      { type: 'multiple-choice', question: 'Q', options: ['a', 'b', 'c', 'd'], correctAnswer: 'a' },
    ]));
    const out = await generateQuiz({
      stepBody: 'x', stepNumber: 1, slug: 's', types: 'mcq-only', deps: { callModel },
    });
    expect(out.questions[0].correctAnswer).toBe('a');
    expect(out.questions[0].aiGrading).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests, expect failure**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx vitest run srv/lib/__tests__/ai-quiz-generator.test.js`
Expected: module not found (`Cannot find module '../ai-quiz-generator.js'`).

- [ ] **Step 4: Implement `ai-quiz-generator.js`**

Create `srv/lib/ai-quiz-generator.js`. Mirror `srv/lib/validate-answer-prompt.js` shape. Three anti-leak guards beyond the schema (MCQ correctness consistency, leak detection, conversion to public ValidationQuestion shape).

```js
// srv/lib/ai-quiz-generator.js
//
// Pure module — no network, no DB. The forced-tool-call SDK invocation
// happens via the injected `callModel` dep (typically defaultCallModel
// from srv/lib/code-check-llm.js — same wrapper #205 + #234 reuse).
//
// Mirrors srv/lib/validate-answer-prompt.js shape. PROMPT_VERSION is
// bumped on any prompt-semantics change so cached entries invalidate.
//
// Spec: docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md

import cds from '@sap/cds';

const LOG = cds.log('ai-quiz-generator');

export const PROMPT_VERSION = 'v1';

const STEP_BODY_CAP = 4000;
const TOOL_NAME = 'submitQuiz';

export function buildSystemPrompt() {
  return `You are an SAP tutorial author writing comprehension-check questions about a single tutorial step. Generate questions that test whether a learner understood the step's main idea — not whether they memorized exact wording.

Output rules:
- 1 to 3 questions per call. Pick the smallest set that covers the step's distinct learnings.
- Multiple-choice questions must have exactly 4 options, exactly 1 correct. Wrong options must be plausible (not obvious filler).
- Text questions must accept a 1-3 sentence answer. Phrase the question to elicit explanation, not single-word recall.
- Never reference "the step" or "the tutorial" or "as shown above" — questions must read standalone.
- Never quote the step body verbatim in a question. Paraphrase.
- ANTI-LEAK: never reveal the correct answer's literal wording inside the question text.`;
}

export function buildUserMessage({ stepBody, types }) {
  const cappedBody = stepBody.length > STEP_BODY_CAP
    ? stepBody.slice(0, STEP_BODY_CAP) + '\n[...content truncated...]'
    : stepBody;
  const typeLabel = {
    'mcq-only': 'multiple-choice',
    'text-only': 'free-text',
    'mcq-and-text': 'multiple-choice and free-text',
  }[types] ?? 'multiple-choice and free-text';
  return `TUTORIAL STEP CONTENT (markdown):
${cappedBody}

REQUEST:
Generate ${typeLabel} question(s) about the main learning of this step.`;
}

export const QUIZ_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['questions'],
  additionalProperties: false,
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        oneOf: [
          {
            type: 'object',
            required: ['type', 'question', 'options', 'correctAnswer'],
            additionalProperties: false,
            properties: {
              type: { const: 'multiple-choice' },
              question: { type: 'string', maxLength: 400 },
              options: {
                type: 'array',
                minItems: 4, maxItems: 4,
                items: { type: 'string', maxLength: 200 },
              },
              correctAnswer: { type: 'string', maxLength: 200 },
            },
          },
          {
            type: 'object',
            required: ['type', 'question', 'correctAnswer'],
            additionalProperties: false,
            properties: {
              type: { const: 'text' },
              question: { type: 'string', maxLength: 400 },
              correctAnswer: { type: 'string', maxLength: 1000 },
            },
          },
        ],
      },
    },
  },
};

/**
 * Normalize a string for leak detection: lowercase + collapse whitespace.
 * Mirrors the algorithm in srv/lib/code-check-prompt.js's redactReferenceLeaks.
 */
function normalize(s) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Generate AI quiz questions for one tutorial step.
 *
 * @param {object} input
 * @param {string} input.stepBody     Markdown body of one step (capped at 4000 chars).
 * @param {number} input.stepNumber   For the questionId emit.
 * @param {string} input.slug         Tutorial slug (logging + cache key).
 * @param {'mcq-only' | 'text-only' | 'mcq-and-text'} input.types
 * @param {object} input.deps
 * @param {Function} input.deps.callModel  ({ messages, tools, toolChoice, schema }) => { toolCalls, modelName, promptTokens, completionTokens, finishReason }
 *
 * @returns {Promise<{questions, errorReason?, modelName, promptTokens, completionTokens, latencyMs, promptVersion}>}
 */
export async function generateQuiz({ stepBody, stepNumber, slug, types, deps }) {
  const startedAt = Date.now();
  const system = buildSystemPrompt();
  const userMsg = buildUserMessage({ stepBody, types });

  let modelResp;
  try {
    modelResp = await deps.callModel({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
      tools: [{ type: 'function', function: { name: TOOL_NAME, parameters: QUIZ_OUTPUT_SCHEMA } }],
      toolChoice: { type: 'function', function: { name: TOOL_NAME } },
      schema: QUIZ_OUTPUT_SCHEMA,
    });
  } catch (err) {
    LOG.warn(`generateQuiz upstream error for ${slug} step ${stepNumber}:`, err.message);
    return {
      questions: [],
      errorReason: 'upstream',
      modelName: undefined,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - startedAt,
      promptVersion: PROMPT_VERSION,
    };
  }

  // Parse the forced tool-call arguments
  const toolCall = modelResp.toolCalls?.[0];
  let parsed;
  try {
    parsed = JSON.parse(toolCall.arguments);
  } catch {
    return failure('schema', modelResp, startedAt);
  }
  if (!parsed || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    return failure('schema', modelResp, startedAt);
  }

  // Convert + run the 3 anti-leak guards
  const out = [];
  let idx = 0;
  for (const q of parsed.questions) {
    idx++;
    // Guard 1: schema strictness was already enforced by the forced tool call,
    // but cross-field consistency is not — verify MCQ's correctAnswer ∈ options.
    if (q.type === 'multiple-choice') {
      const opts = q.options.map(o => o.trim());
      if (!opts.includes(q.correctAnswer.trim())) {
        return failure('mcq_correct_not_in_options', modelResp, startedAt);
      }
    }
    // Guard 2: leak detection — correctAnswer text must not appear inside question text.
    if (normalize(q.question).includes(normalize(q.correctAnswer))) {
      return failure('leak_detected', modelResp, startedAt);
    }
    // Guard 3: convert to public ValidationQuestion shape.
    if (q.type === 'multiple-choice') {
      out.push({
        id: `validate-${stepNumber}-ai-${idx}`,
        question: q.question,
        type: 'multiple-choice',
        options: q.options,
        correctAnswer: q.correctAnswer,
        aiAuthored: true,
      });
    } else {
      // Text question: omit correctAnswer from the public shape per #209
      // anti-leak. The reference answer lives ONLY in the cache (and gets
      // uploaded to ValidateAnswerSpecs server-side via the existing
      // collectAiGradedSpecs path).
      out.push({
        id: `validate-${stepNumber}-ai-${idx}`,
        question: q.question,
        type: 'text',
        // Stash correctAnswer on a sentinel field so expand-ai-authored.ts
        // can hand it off to the validate-answer sidecar emitter without
        // shipping it in public frontmatter. Mirrors the [VALIDATE_N] +
        // ###Grading: ai-judged path from PR #234.
        __aiCorrectAnswer: q.correctAnswer,
        aiGrading: true,
        aiAuthored: true,
      });
    }
  }

  return {
    questions: out,
    modelName: modelResp.modelName,
    promptTokens: modelResp.promptTokens ?? 0,
    completionTokens: modelResp.completionTokens ?? 0,
    latencyMs: Date.now() - startedAt,
    promptVersion: PROMPT_VERSION,
  };
}

function failure(errorReason, modelResp, startedAt) {
  return {
    questions: [],
    errorReason,
    modelName: modelResp?.modelName,
    promptTokens: modelResp?.promptTokens ?? 0,
    completionTokens: modelResp?.completionTokens ?? 0,
    latencyMs: Date.now() - startedAt,
    promptVersion: PROMPT_VERSION,
  };
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx vitest run srv/lib/__tests__/ai-quiz-generator.test.js`
Expected: 10/10 passing.

- [ ] **Step 6: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/208-ai-authored-quizzes" ] && \
  git add srv/lib/ai-quiz-generator.js srv/lib/__tests__/ai-quiz-generator.test.js && \
  git commit -m "feat(ai-quiz): generator module with prompt + schema + anti-leak guards (#208)

- Pure module, no network/DB; callModel injected by caller.
- System prompt + user message + forced-tool-call schema for 1-3
  ValidationQuestion[] outputs (MCQ + text).
- Three anti-leak guards beyond schema strictness:
  1. MCQ correctness: correctAnswer must equal one of options.
  2. Leak detection: correctAnswer text must not appear in question text.
  3. Public-shape conversion: text questions emit aiGrading: true and
     OMIT correctAnswer (anti-leak per #209). MCQ retains correctAnswer
     for client-side equality grading.
- All emitted questions carry aiAuthored: true.
- 10/10 unit tests pass."
```

---

### Task 4: `ai-quiz-cache.ts` — content-hash cache

**Files:**
- Create: `scripts/lib/ai-quiz-cache.ts`
- Test: `scripts/__tests__/ai-quiz-cache.test.ts` (new)

4 unit tests per the spec's Test plan section.

- [ ] **Step 1: Write the failing tests (4 cases)**

Create `scripts/__tests__/ai-quiz-cache.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadAiQuizCache,
  saveAiQuizCache,
  hashKey,
  type AiQuizCache,
} from '../lib/ai-quiz-cache.js'

let testCacheDir: string

beforeEach(() => {
  testCacheDir = join(tmpdir(), `ai-quiz-cache-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  mkdirSync(testCacheDir, { recursive: true })
})

afterEach(() => {
  rmSync(testCacheDir, { recursive: true, force: true })
})

describe('ai-quiz-cache (#208)', () => {
  it('round-trip: write + read returns equal entry', () => {
    const cache: AiQuizCache = {
      promptVersion: 'v1',
      modelName: 'gpt-test',
      entries: {
        '3': {
          stepHash: 'sha256:abc',
          directive: '[AUTOAUTHOR_3]',
          types: 'mcq-and-text',
          generatedAt: '2026-06-05T00:00:00Z',
          questions: [
            { id: 'validate-3-ai-1', type: 'multiple-choice', question: 'Q', options: ['a','b','c','d'], correctAnswer: 'a', aiAuthored: true },
          ],
        },
      },
    }
    saveAiQuizCache('test-slug', cache, { cacheDir: testCacheDir })
    const loaded = loadAiQuizCache('test-slug', { cacheDir: testCacheDir })
    expect(loaded).toEqual(cache)
  })

  it('loadAiQuizCache returns empty cache when file missing', () => {
    const loaded = loadAiQuizCache('never-saved', { cacheDir: testCacheDir })
    expect(loaded).toEqual({
      promptVersion: 'v1',
      modelName: '',
      entries: {},
    })
  })

  it('hashKey changes when any input changes', () => {
    const base = { stepBody: 'body', directive: '[AUTOAUTHOR_3]', types: 'mcq-and-text', promptVersion: 'v1', modelName: 'm' }
    const baseHash = hashKey(base)
    expect(hashKey({ ...base, stepBody: 'body2' })).not.toBe(baseHash)
    expect(hashKey({ ...base, directive: '[AUTOAUTHOR_3:mcq]' })).not.toBe(baseHash)
    expect(hashKey({ ...base, types: 'mcq-only' })).not.toBe(baseHash)
    expect(hashKey({ ...base, promptVersion: 'v2' })).not.toBe(baseHash)
    expect(hashKey({ ...base, modelName: 'm2' })).not.toBe(baseHash)
  })

  it('saveAiQuizCache creates the directory if missing', () => {
    const subDir = join(testCacheDir, 'nested', 'path')
    saveAiQuizCache('s', { promptVersion: 'v1', modelName: 'm', entries: {} }, { cacheDir: subDir })
    // Read it back to confirm the dir + file were created.
    const content = readFileSync(join(subDir, 's.ai-quiz-cache.json'), 'utf8')
    expect(JSON.parse(content)).toEqual({ promptVersion: 'v1', modelName: 'm', entries: {} })
  })
})
```

- [ ] **Step 2: Run tests, expect failure**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx vitest run scripts/__tests__/ai-quiz-cache.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `ai-quiz-cache.ts`**

Create `scripts/lib/ai-quiz-cache.ts`:

```ts
// scripts/lib/ai-quiz-cache.ts
//
// Content-hash cache over per-tutorial sidecar files at
// .tutorial-cache/<slug>.ai-quiz-cache.json. Sibling to
// <slug>.codecheck.json + <slug>.validate-answer.json.
//
// Hash key uses \x00 (NUL byte) as the separator between fields —
// step bodies are UTF-8 markdown which never contain a literal NUL,
// so this is a safe sentinel that prevents concatenation collisions
// between step body endings and directive boundaries.
//
// Spec: docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ValidationQuestion } from '../parsers/types.js'

export interface AiQuizCacheEntry {
  stepHash: string
  directive: string
  types: 'mcq-and-text' | 'mcq-only' | 'text-only'
  generatedAt: string
  questions: ValidationQuestion[]
}

export interface AiQuizCache {
  promptVersion: string
  modelName: string
  entries: Record<string, AiQuizCacheEntry>  // keyed by step number (as string)
}

const SEP = '\x00'

export function hashKey(input: {
  stepBody: string
  directive: string
  types: string
  promptVersion: string
  modelName: string
}): string {
  return createHash('sha256')
    .update([input.stepBody, input.directive, input.types, input.promptVersion, input.modelName].join(SEP))
    .digest('hex')
}

const DEFAULT_CACHE_DIR = process.env.TUTORIAL_CACHE_DIR ?? '.tutorial-cache'

function cachePath(slug: string, cacheDir = DEFAULT_CACHE_DIR): string {
  return join(cacheDir, `${slug.toLowerCase()}.ai-quiz-cache.json`)
}

export function loadAiQuizCache(slug: string, opts: { cacheDir?: string } = {}): AiQuizCache {
  const path = cachePath(slug, opts.cacheDir)
  if (!existsSync(path)) {
    return { promptVersion: 'v1', modelName: '', entries: {} }
  }
  const raw = readFileSync(path, 'utf8')
  return JSON.parse(raw) as AiQuizCache
}

export function saveAiQuizCache(
  slug: string,
  cache: AiQuizCache,
  opts: { cacheDir?: string } = {},
): void {
  const path = cachePath(slug, opts.cacheDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cache, null, 2))
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx vitest run scripts/__tests__/ai-quiz-cache.test.ts`
Expected: 4/4 passing.

- [ ] **Step 5: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/208-ai-authored-quizzes" ] && \
  git add scripts/lib/ai-quiz-cache.ts scripts/__tests__/ai-quiz-cache.test.ts && \
  git commit -m "feat(ai-quiz): content-hash cache helper (#208)

- Per-tutorial sidecar at .tutorial-cache/<slug>.ai-quiz-cache.json,
  sibling to .codecheck.json + .validate-answer.json.
- hashKey() uses \\x00 NUL-byte separator to prevent concatenation
  collisions (step bodies are UTF-8 markdown, never contain NULs).
- 4/4 unit tests cover round-trip, missing-file, hash sensitivity to
  every input field, and directory auto-creation."
```

---

## Phase 3 — Orchestrator (post-parse expansion)

End state after Phase 3: `expand-ai-authored.ts` walks placeholders + the all-directive against the actual step list, consults the cache, calls `generateQuiz` on miss, swaps real questions in. Hard cap enforced. One-line build summary emitted. Pure module — `callModel` injected; no real LLM call in tests.

### Task 5: `expand-ai-authored.ts` — post-parse expansion

**Files:**
- Create: `scripts/lib/expand-ai-authored.ts`
- Test: `scripts/__tests__/expand-ai-authored.test.ts` (new)

6 unit tests per the spec's Test plan section.

- [ ] **Step 1: Write the failing tests (6 cases)**

Create `scripts/__tests__/expand-ai-authored.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { expandAiAuthoredQuestions } from '../lib/expand-ai-authored.js'
import type { ValidationQuestion } from '../parsers/types.js'
import type { AiQuizCache } from '../lib/ai-quiz-cache.js'

const PLACEHOLDER = (stepNum: number, types: 'mcq-and-text' | 'mcq-only' | 'text-only' = 'mcq-and-text') => ({
  id: `autoauthor-${stepNum}`,
  question: '__autoauthor_placeholder__',
  type: 'text' as const,
  __autoauthor: true,
  __directiveTypes: types,
})

const FAKE_QUESTION = (idx: number): ValidationQuestion => ({
  id: `validate-1-ai-${idx}`,
  question: `Q${idx}`,
  type: 'multiple-choice',
  options: ['a', 'b', 'c', 'd'],
  correctAnswer: 'a',
  aiAuthored: true,
})

let cache: AiQuizCache
beforeEach(() => {
  cache = { promptVersion: 'v1', modelName: 'gpt-test', entries: {} }
})

describe('expandAiAuthoredQuestions (#208)', () => {
  it('cache hit: no callModel invocation; questions swapped from cache', async () => {
    cache.entries['1'] = {
      stepHash: 'precomputed-hash-1',
      directive: '[AUTOAUTHOR_1]',
      types: 'mcq-and-text',
      generatedAt: '2026-06-05T00:00:00Z',
      questions: [FAKE_QUESTION(1)],
    }
    const callModel = vi.fn()  // never called
    const stats = { calls: 0, hits: 0, errors: 0 }
    const parsedMap = new Map<number, any[]>([[1, [PLACEHOLDER(1)]]])
    const stepBodies = new Map<number, string>([[1, 'step body 1']])

    await expandAiAuthoredQuestions(parsedMap, stepBodies, {
      cache,
      callModel,
      onCallStats: stats,
      // Provide a hashKey override so the test cache entry's stepHash matches.
      hashKeyOverride: () => 'precomputed-hash-1',
    })

    expect(callModel).not.toHaveBeenCalled()
    expect(stats).toMatchObject({ calls: 0, hits: 1 })
    expect(parsedMap.get(1)).toEqual([FAKE_QUESTION(1)])
  })

  it('cache miss: callModel called once; new entry written; questions swapped', async () => {
    const callModel = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'submitQuiz', arguments: JSON.stringify({
        questions: [{ type: 'multiple-choice', question: 'Q', options: ['a','b','c','d'], correctAnswer: 'a' }],
      })}],
      modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
    })
    const stats = { calls: 0, hits: 0, errors: 0 }
    const parsedMap = new Map<number, any[]>([[1, [PLACEHOLDER(1)]]])
    const stepBodies = new Map<number, string>([[1, 'fresh body']])

    await expandAiAuthoredQuestions(parsedMap, stepBodies, { cache, callModel, onCallStats: stats })

    expect(callModel).toHaveBeenCalledTimes(1)
    expect(stats).toMatchObject({ calls: 1, hits: 0, errors: 0 })
    expect(cache.entries['1']).toBeDefined()
    expect(parsedMap.get(1)?.[0]).toMatchObject({ aiAuthored: true })
  })

  it('hard cap reached: subsequent placeholders dropped; warning logged; not failed', async () => {
    const callModel = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'submitQuiz', arguments: JSON.stringify({
        questions: [{ type: 'multiple-choice', question: 'Q', options: ['a','b','c','d'], correctAnswer: 'a' }],
      })}],
      modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
    })
    const stats = { calls: 0, hits: 0, errors: 0 }
    const parsedMap = new Map<number, any[]>([
      [1, [PLACEHOLDER(1)]],
      [2, [PLACEHOLDER(2)]],
      [3, [PLACEHOLDER(3)]],
    ])
    const stepBodies = new Map<number, string>([[1, 'b1'], [2, 'b2'], [3, 'b3']])

    await expandAiAuthoredQuestions(parsedMap, stepBodies, {
      cache, callModel, onCallStats: stats, hardCap: 2,
    })

    expect(callModel).toHaveBeenCalledTimes(2)
    // Step 3 dropped — no questions emitted, placeholder removed.
    expect(parsedMap.get(3)).toEqual([])
  })

  it('generator errorReason → placeholder dropped; build continues', async () => {
    const callModel = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'submitQuiz', arguments: JSON.stringify({
        questions: [{ type: 'multiple-choice', question: 'Q', options: ['a','b','c','d'], correctAnswer: 'NOT-IN-OPTS' }],
      })}],
      modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
    })
    const stats = { calls: 0, hits: 0, errors: 0 }
    const parsedMap = new Map<number, any[]>([[1, [PLACEHOLDER(1)]]])
    const stepBodies = new Map<number, string>([[1, 'body']])

    await expandAiAuthoredQuestions(parsedMap, stepBodies, { cache, callModel, onCallStats: stats })

    expect(stats.errors).toBe(1)
    expect(parsedMap.get(1)).toEqual([])  // placeholder dropped
  })

  it('sentinel fields (__autoauthor, __directiveTypes) stripped from emitted questions', async () => {
    const callModel = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'submitQuiz', arguments: JSON.stringify({
        questions: [{ type: 'multiple-choice', question: 'Q', options: ['a','b','c','d'], correctAnswer: 'a' }],
      })}],
      modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
    })
    const parsedMap = new Map<number, any[]>([[1, [PLACEHOLDER(1)]]])
    const stepBodies = new Map<number, string>([[1, 'body']])

    await expandAiAuthoredQuestions(parsedMap, stepBodies, {
      cache, callModel, onCallStats: { calls: 0, hits: 0, errors: 0 },
    })

    const out = parsedMap.get(1)?.[0]
    expect(out).toBeDefined()
    expect((out as any).__autoauthor).toBeUndefined()
    expect((out as any).__directiveTypes).toBeUndefined()
  })

  it('text questions get correctAnswer RESTORED on parsedMap (for collectAiGradedSpecs); cache keeps __aiCorrectAnswer', async () => {
    // The generator strips correctAnswer + stashes it on __aiCorrectAnswer (anti-leak).
    // The existing collectAiGradedSpecs (#234) reads correctAnswer; without
    // restoration, AI-authored text reference answers would silently fail
    // to upload to ValidateAnswerSpecs.
    const callModel = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'submitQuiz', arguments: JSON.stringify({
        questions: [{ type: 'text', question: 'Explain X', correctAnswer: 'X is the answer.' }],
      })}],
      modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
    })
    const parsedMap = new Map<number, any[]>([[1, [PLACEHOLDER(1, 'text-only')]]])
    const stepBodies = new Map<number, string>([[1, 'body']])

    await expandAiAuthoredQuestions(parsedMap, stepBodies, {
      cache, callModel, onCallStats: { calls: 0, hits: 0, errors: 0 },
    })

    // parsedMap (consumed by collectAiGradedSpecs): correctAnswer restored, __aiCorrectAnswer stripped.
    const onMap = parsedMap.get(1)?.[0] as any
    expect(onMap.correctAnswer).toBe('X is the answer.')
    expect(onMap.__aiCorrectAnswer).toBeUndefined()
    expect(onMap.aiGrading).toBe(true)

    // Cache (consumed by eval harness): __aiCorrectAnswer kept, correctAnswer absent.
    const inCache = cache.entries['1'].questions[0] as any
    expect(inCache.__aiCorrectAnswer).toBe('X is the answer.')
    expect(inCache.correctAnswer).toBeUndefined()
  })

  it('all-directive expands against the step list when no per-step placeholders are present', async () => {
    // Tutorial-wide [AUTOAUTHOR_ALL] applies to every step in stepBodies that
    // doesn't already have content in parsedMap.
    const callModel = vi.fn().mockResolvedValue({
      toolCalls: [{ name: 'submitQuiz', arguments: JSON.stringify({
        questions: [{ type: 'multiple-choice', question: 'Q', options: ['a','b','c','d'], correctAnswer: 'a' }],
      })}],
      modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
    })
    const stats = { calls: 0, hits: 0, errors: 0 }
    // parsedMap is empty (no per-step directives, no hand-authored content)
    const parsedMap = new Map<number, any[]>()
    const stepBodies = new Map<number, string>([[1, 'b1'], [2, 'b2'], [3, 'b3']])
    const allDirective = { types: 'mcq-only' as const, present: true as const }

    await expandAiAuthoredQuestions(parsedMap, stepBodies, {
      cache, callModel, onCallStats: stats, allDirective,
    })

    expect(callModel).toHaveBeenCalledTimes(3)
    expect(stats.calls).toBe(3)
    for (const stepNum of [1, 2, 3]) {
      expect(parsedMap.get(stepNum)?.[0]).toMatchObject({ aiAuthored: true })
    }
  })
})
```

- [ ] **Step 2: Run tests, expect failure**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx vitest run scripts/__tests__/expand-ai-authored.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `expand-ai-authored.ts`**

Create `scripts/lib/expand-ai-authored.ts`:

```ts
// scripts/lib/expand-ai-authored.ts
//
// Post-parse expansion: walks parser-emitted placeholders + the
// tutorial-wide [AUTOAUTHOR_ALL] directive, calls the LLM via the
// injected callModel (or hits cache), swaps real questions in.
//
// Pure module — no I/O beyond the cache and the injected callModel.
//
// Spec: docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md

import { generateQuiz } from '../../srv/lib/ai-quiz-generator.js'
import { hashKey, type AiQuizCache, type AiQuizCacheEntry } from './ai-quiz-cache.js'
import type { ValidationQuestion } from '../parsers/types.js'

export interface ExpandStats {
  calls: number    // cache miss → LLM call
  hits: number     // cache hit
  errors: number   // generator returned errorReason; placeholder dropped
}

export interface AllDirective {
  types: 'mcq-and-text' | 'mcq-only' | 'text-only'
  present: true
}

interface PlaceholderQuestion extends ValidationQuestion {
  __autoauthor?: true
  __directiveTypes?: 'mcq-and-text' | 'mcq-only' | 'text-only'
}

const DEFAULT_HARD_CAP = parseInt(process.env.AI_AUTHOR_BUILD_CAP ?? '200', 10)

/**
 * Walk the parsedMap for sentinel placeholders + apply the all-directive.
 * For each step that needs expansion, consult cache; on miss, call generator.
 *
 * Mutates parsedMap in place: placeholders are replaced with real questions,
 * or with `[]` if the cap is hit / generator errored.
 *
 * @param parsedMap   — Map<stepNumber, ValidationQuestion[]> from parseRulesVrEnriched()
 * @param stepBodies  — Map<stepNumber, string> markdown body per step
 * @param deps
 *   - cache         — loaded AiQuizCache (mutated; persist after this call)
 *   - callModel     — passes through to generateQuiz
 *   - onCallStats   — tracks calls/hits/errors across the build (caller persists)
 *   - hardCap       — defaults to AI_AUTHOR_BUILD_CAP env var or 200
 *   - allDirective  — optional tutorial-wide directive from parseRulesVrEnriched
 *   - hashKeyOverride — test-only: override hashKey() for deterministic cache lookups
 */
export async function expandAiAuthoredQuestions(
  parsedMap: Map<number, ValidationQuestion[]>,
  stepBodies: Map<number, string>,
  deps: {
    cache: AiQuizCache
    callModel: Parameters<typeof generateQuiz>[0]['deps']['callModel']
    onCallStats: ExpandStats
    hardCap?: number
    allDirective?: AllDirective
    hashKeyOverride?: (input: any) => string
  },
): Promise<void> {
  const hardCap = deps.hardCap ?? DEFAULT_HARD_CAP
  const hk = deps.hashKeyOverride ?? hashKey

  // 1. Apply allDirective: materialize placeholders for steps that don't
  //    already have content in parsedMap. (Per-step directives have already
  //    been materialized by the parser.)
  if (deps.allDirective?.present) {
    for (const [stepNum] of stepBodies) {
      if ((parsedMap.get(stepNum) ?? []).length > 0) continue
      parsedMap.set(stepNum, [{
        id: `autoauthor-${stepNum}`,
        question: '__autoauthor_placeholder__',
        type: 'text',
        __autoauthor: true,
        __directiveTypes: deps.allDirective.types,
      } as PlaceholderQuestion])
    }
  }

  // 2. Walk all placeholders.
  for (const [stepNum, questions] of parsedMap) {
    const placeholder = questions.find(q => (q as PlaceholderQuestion).__autoauthor === true) as PlaceholderQuestion | undefined
    if (!placeholder) continue

    // Cap check: at-or-over the cap → drop placeholder, log warning.
    if (deps.onCallStats.calls >= hardCap) {
      console.warn(`[ai-author] hit hard cap ${hardCap}; skipping step ${stepNum}`)
      parsedMap.set(stepNum, [])
      continue
    }

    const stepBody = stepBodies.get(stepNum) ?? ''
    const directive = `[AUTOAUTHOR_${stepNum}${placeholder.__directiveTypes !== 'mcq-and-text' ? ':' + (placeholder.__directiveTypes === 'mcq-only' ? 'mcq' : 'text') : ''}]`
    const types = placeholder.__directiveTypes ?? 'mcq-and-text'

    const entryKey = String(stepNum)
    const stepHash = hk({
      stepBody,
      directive,
      types,
      promptVersion: deps.cache.promptVersion,
      modelName: deps.cache.modelName,
    })

    const cached = deps.cache.entries[entryKey]
    if (cached && cached.stepHash === stepHash) {
      deps.onCallStats.hits++
      // Cache stored the cache-snapshot shape (correctAnswer absent on
      // text); restore correctAnswer on the parsedMap pass-through so
      // collectAiGradedSpecs sees what it expects.
      parsedMap.set(stepNum, cached.questions.map(materializeForPipeline))
      continue
    }

    // Cache miss — call the generator.
    deps.onCallStats.calls++
    const result = await generateQuiz({
      stepBody,
      stepNumber: stepNum,
      slug: '<unknown>',  // expand-ai-authored doesn't know the slug; loaded by caller
      types,
      deps: { callModel: deps.callModel },
    })

    if (result.errorReason || result.questions.length === 0) {
      deps.onCallStats.errors++
      console.warn(`[ai-author] step ${stepNum}: ${result.errorReason ?? 'empty result'}`)
      parsedMap.set(stepNum, [])
      continue
    }

    // Two transforms — same questions, different shape per consumer:
    //
    //   forCache       — cache snapshot. Keeps __aiCorrectAnswer for the
    //                    eval harness (Task 8/9). correctAnswer absent on
    //                    text questions per the generator's anti-leak strip.
    //
    //   forParsedMap   — what fetch-tutorials.ts uses downstream. Restores
    //                    correctAnswer on text questions from
    //                    __aiCorrectAnswer so the existing collectAiGradedSpecs
    //                    (PR #234) sees what it expects. fetch-tutorials.ts
    //                    runs a final strip before emitting to public Hugo
    //                    frontmatter (the strip lives in fetch-tutorials.ts
    //                    Task 6 Step 5b, NOT here, because
    //                    collectAiGradedSpecs runs in fetch-tutorials between
    //                    expansion and frontmatter emission).
    const forCache = result.questions.map(stripParserSentinels)
    const forParsedMap = result.questions.map(materializeForPipeline)

    const newEntry: AiQuizCacheEntry = {
      stepHash,
      directive,
      types,
      generatedAt: new Date().toISOString(),
      questions: forCache,
    }
    deps.cache.entries[entryKey] = newEntry
    if (!deps.cache.modelName && result.modelName) {
      deps.cache.modelName = result.modelName
    }
    parsedMap.set(stepNum, forParsedMap)
  }
}

/**
 * Cache-snapshot transform. Strips parser sentinels (__autoauthor,
 * __directiveTypes) but KEEPS __aiCorrectAnswer for the eval harness.
 *
 * For text questions: correctAnswer is absent (generator stripped it),
 * __aiCorrectAnswer carries the reference answer.
 */
function stripParserSentinels(q: ValidationQuestion): ValidationQuestion {
  const clean: any = { ...q }
  delete clean.__autoauthor
  delete clean.__directiveTypes
  return clean
}

/**
 * Pipeline-pass-through transform. Strips parser sentinels AND
 * restores correctAnswer on text questions from __aiCorrectAnswer
 * so the downstream collectAiGradedSpecs (PR #234) sees what it
 * expects. fetch-tutorials.ts will strip correctAnswer again from
 * the public emission for AI-graded text questions — that strip
 * happens AFTER collectAiGradedSpecs runs.
 */
function materializeForPipeline(q: ValidationQuestion): ValidationQuestion {
  const clean: any = { ...q }
  delete clean.__autoauthor
  delete clean.__directiveTypes
  if (q.type === 'text' && (q as any).__aiCorrectAnswer != null) {
    clean.correctAnswer = (q as any).__aiCorrectAnswer
    delete clean.__aiCorrectAnswer
  }
  return clean
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx vitest run scripts/__tests__/expand-ai-authored.test.ts`
Expected: 6/6 passing.

- [ ] **Step 5: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/208-ai-authored-quizzes" ] && \
  git add scripts/lib/expand-ai-authored.ts scripts/__tests__/expand-ai-authored.test.ts && \
  git commit -m "feat(ai-quiz): post-parse expansion orchestrator (#208)

- expandAiAuthoredQuestions(parsedMap, stepBodies, deps) walks parser
  placeholders + applies the all-directive against the actual step
  list, consults cache, calls generator on miss, mutates parsedMap.
- Hard cap default 200 (configurable via AI_AUTHOR_BUILD_CAP env);
  over-cap drop-not-fail per spec.
- Per-call stats (calls, hits, errors) for the build summary line.
- Sentinel fields (__autoauthor, __directiveTypes) stripped before
  emission so the validation widget treats the output identically to
  hand-authored content.
- 6/6 unit tests pass."
```

---

## Phase 4 — Build wiring + integration test

End state after Phase 4: `fetch-tutorials.ts` invokes the expansion behind the env flag; `npm run seed-ai-quizzes` works for bulk seeding; one integration test covers the full chain (synthetic `rules.vr` → expanded frontmatter → re-run hits cache).

### Task 6: Wire expansion into `fetch-tutorials.ts` + seed script

**Files:**
- Modify: `scripts/fetch-tutorials.ts` — wire expansion between `parseRulesVrEnriched` and `collectAiGradedSpecs`
- Modify: `package.json` — add `seed-ai-quizzes` npm script

- [ ] **Step 1: Read existing wiring**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && sed -n '1,15p;655,700p' scripts/fetch-tutorials.ts`
Note the import block + the `parseRulesVrEnriched(...)` call site (line 657 in current main) + the immediately-following loop that attaches questions to test-yourself steps + the `collectAiGradedSpecs` call (around line 678).

- [ ] **Step 2: Add the imports**

Edit `scripts/fetch-tutorials.ts`. Find the existing import (line 10):

```ts
import { parseRulesVrEnriched, collectAiGradedSpecs } from './parsers/rules.js'
```

Add the new imports nearby:

```ts
import { expandAiAuthoredQuestions, type ExpandStats } from './lib/expand-ai-authored.js'
import { loadAiQuizCache, saveAiQuizCache } from './lib/ai-quiz-cache.js'
import { defaultCallModel } from '../srv/lib/code-check-llm.js'
```

Add a module-level `globalCallStats` accumulator (just below the imports):

```ts
// [#208] Build-wide AI quiz generation stats. Accumulates across all
// tutorials in one fetch run; logged at the end as a one-line summary.
const globalCallStats: ExpandStats = { calls: 0, hits: 0, errors: 0 }
```

- [ ] **Step 3: Wire the expansion call**

Find the existing block (around line 657-680):

```ts
const { map: validationMap, ruleTypeByStepAndId, correctAnswerByStepAndId } = parseRulesVrEnriched(rulesContent)
// ...attach loop...
const aiGradedSpecs = collectAiGradedSpecs(validationMap, ruleTypeByStepAndId, correctAnswerByStepAndId)
```

Insert the expansion call between `parseRulesVrEnriched` and the attach loop:

```ts
const { map: validationMap, ruleTypeByStepAndId, correctAnswerByStepAndId, allDirective } = parseRulesVrEnriched(rulesContent)

// [#208] AI-authored quiz expansion. Behind AI_AUTHOR_ENABLED env flag;
// hard-capped at AI_AUTHOR_BUILD_CAP per build. Cache lives at
// .tutorial-cache/<slug>.ai-quiz-cache.json. See:
// docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md
if (process.env.AI_AUTHOR_ENABLED === 'true') {
  // TutorialStep type has `.number` + `.content` fields (per
  // scripts/parsers/types.ts — verified during plan review). Use
  // `s.content`, NOT `s.body`.
  const stepBodies = new Map<number, string>(
    steps.map(s => [s.number, s.content ?? '']),
  )
  const aiCache = loadAiQuizCache(t.slug)
  await expandAiAuthoredQuestions(validationMap, stepBodies, {
    cache: aiCache,
    callModel: defaultCallModel,
    onCallStats: globalCallStats,
    allDirective,
  })
  saveAiQuizCache(t.slug, aiCache)
}

// existing attach loop runs unchanged
const testSteps = steps.filter(s => /^test yourself$/i.test(s.title))
// ...
```

- [ ] **Step 4: Strip AI-graded text correctAnswer AFTER collectAiGradedSpecs**

This is the bridge step that satisfies the anti-leak invariant for AI-authored text questions. The flow is:

1. `expandAiAuthoredQuestions` (Task 5) puts text questions into `validationMap` WITH `correctAnswer` populated (restored from `__aiCorrectAnswer` so the existing `collectAiGradedSpecs` reads what it expects).
2. The existing attach loop puts those questions onto `target.validation` (still with `correctAnswer`).
3. `collectAiGradedSpecs(validationMap, ...)` runs (existing, line 678) and emits the `<slug>.validate-answer.json` sidecar — including AI-authored text questions, since they now look identical to hand-authored `aiGrading: true` questions.
4. **NEW (this step):** strip `correctAnswer` from all AI-authored text questions BEFORE Hugo frontmatter emission. The reference answer is now in HANA (`ValidateAnswerSpecs`) via the sidecar; the public emission must NOT carry it (anti-leak per #209).

Find the existing `collectAiGradedSpecs(...)` call (around line 678 in current main). After the existing sidecar write completes, add:

```ts
// [#208] Anti-leak strip: AI-authored text questions had correctAnswer
// restored on validationMap so collectAiGradedSpecs (above) could emit
// the validate-answer-spec sidecar. The reference is now in HANA via
// that sidecar; the public Hugo frontmatter must NOT carry it. Strip
// correctAnswer from any text question with aiAuthored: true.
//
// (Hand-authored aiGrading: true text questions are already stripped
// upstream by parseRulesVrEnriched per #209's existing anti-leak path —
// only the AI-authored ones need this extra strip because they took the
// scenic route to support both consumers.)
for (const [, questions] of validationMap) {
  for (const q of questions) {
    if (q.aiAuthored && q.type === 'text') {
      delete (q as any).correctAnswer
    }
  }
}
```

This loop runs unconditionally (not behind `AI_AUTHOR_ENABLED`) because if the flag is off, no AI-authored questions exist in `validationMap` and the loop is a no-op.

- [ ] **Step 5: Add the build-summary log line**

Find the end of the top-level fetch driver function (e.g. `main()`, `fetchAll()`, or wherever the per-tutorial loop terminates). Use `grep -n 'console.log|^async function|^function' scripts/fetch-tutorials.ts | tail -20` to locate it. Add at the end:

```ts
if (process.env.AI_AUTHOR_ENABLED === 'true') {
  console.log(
    `[ai-author] expanded directives across all tutorials: ` +
    `${globalCallStats.calls} cache miss (LLM call), ` +
    `${globalCallStats.hits} cache hit, ` +
    `${globalCallStats.errors} errors. ` +
    `Build cap: ${process.env.AI_AUTHOR_BUILD_CAP ?? '200'}.`,
  )
}
```

- [ ] **Step 6: Add the npm script**

Edit `package.json`. Find the existing `fetch-tutorials` script. Add a sibling:

```json
"seed-ai-quizzes": "AI_AUTHOR_ENABLED=true AI_AUTHOR_BUILD_CAP=10000 npm run fetch-tutorials"
```

- [ ] **Step 7: Type-check**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx tsc --noEmit -p . 2>&1 | tail -20`
Expected: no new errors.

- [ ] **Step 8: Smoke-test the flag-off path**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && AI_AUTHOR_ENABLED= node -e "const m = require('./scripts/parsers/rules.js'); console.log(m.parseRulesVrEnriched.toString().length > 100 ? 'imports cleanly' : 'FAIL')" 2>&1 | tail -3`
Expected: `imports cleanly`. (Just verifies the module wiring doesn't crash on import.)

- [ ] **Step 9: Run all targeted tests, verify no regression**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx vitest run scripts/parsers/__tests__/ scripts/__tests__/ai-quiz-cache.test.ts scripts/__tests__/expand-ai-authored.test.ts srv/lib/__tests__/ai-quiz-generator.test.js`
Expected: all green (Phase 1-3 tests + this task added no new tests but should not regress prior phases).

- [ ] **Step 10: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/208-ai-authored-quizzes" ] && \
  git add scripts/fetch-tutorials.ts package.json && \
  git commit -m "feat(ai-quiz): wire expansion into fetch-tutorials + seed script (#208)

- AI_AUTHOR_ENABLED=true env flag gates expansion; default-OFF.
- Slot between parseRulesVrEnriched (line 657) and the attach loop:
  expansion mutates validationMap so the existing attach loop +
  collectAiGradedSpecs path runs unchanged. AI-authored text questions
  (with aiGrading: true) flow naturally into the validate-answer
  sidecar via collectAiGradedSpecs (existing).
- Per-tutorial cache loaded via loadAiQuizCache(slug); persisted via
  saveAiQuizCache(slug, cache).
- Module-level globalCallStats accumulates across the build; one-line
  summary logged at the end of fetch-tutorials.
- npm run seed-ai-quizzes wraps fetch-tutorials with the flag on +
  cap bumped to 10000 for bulk-seed runs."
```

---

### Task 7: End-to-end integration test

**Files:**
- Create: `test/integration/ai-quiz-flow.test.ts`

One integration test exercising the full chain: synthetic `rules.vr` with `[AUTOAUTHOR_ALL]` + 3 steps → mock `callModel` returns a fixture → expansion produces 3 step-keyed entries → re-run with the same inputs hits cache (mock `callModel` not called).

- [ ] **Step 1: Write the failing test**

Create `test/integration/ai-quiz-flow.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseRulesVrEnriched } from '../../scripts/parsers/rules.js'
import { expandAiAuthoredQuestions } from '../../scripts/lib/expand-ai-authored.js'
import { loadAiQuizCache, saveAiQuizCache } from '../../scripts/lib/ai-quiz-cache.js'

let testCacheDir: string

beforeEach(() => {
  testCacheDir = join(tmpdir(), `ai-quiz-int-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  mkdirSync(testCacheDir, { recursive: true })
})

afterEach(() => {
  rmSync(testCacheDir, { recursive: true, force: true })
})

const MOCK_RESP = {
  toolCalls: [{
    name: 'submitQuiz',
    arguments: JSON.stringify({
      questions: [{
        type: 'multiple-choice',
        question: 'Q?', options: ['a','b','c','d'], correctAnswer: 'a',
      }],
    }),
  }],
  modelName: 'gpt-test', promptTokens: 1, completionTokens: 1,
}

describe('AI quiz flow — end to end (#208)', () => {
  it('synthetic rules.vr → expanded frontmatter → re-run hits cache', async () => {
    const rulesContent = `[AUTOAUTHOR_ALL:mcq]
`
    const stepBodies = new Map<number, string>([
      [1, 'body of step 1'],
      [2, 'body of step 2'],
      [3, 'body of step 3'],
    ])

    // First pass: empty cache, 3 LLM calls expected.
    const callModel1 = vi.fn().mockResolvedValue(MOCK_RESP)
    const cache1 = loadAiQuizCache('synthetic-slug', { cacheDir: testCacheDir })
    const { map: parsedMap1, allDirective: ad1 } = parseRulesVrEnriched(rulesContent)
    const stats1 = { calls: 0, hits: 0, errors: 0 }
    await expandAiAuthoredQuestions(parsedMap1, stepBodies, {
      cache: cache1, callModel: callModel1, onCallStats: stats1, allDirective: ad1,
    })
    saveAiQuizCache('synthetic-slug', cache1, { cacheDir: testCacheDir })
    expect(callModel1).toHaveBeenCalledTimes(3)
    expect(stats1).toMatchObject({ calls: 3, hits: 0, errors: 0 })
    for (const stepNum of [1, 2, 3]) {
      expect(parsedMap1.get(stepNum)?.[0]).toMatchObject({ aiAuthored: true })
    }

    // Second pass: cache populated, 0 LLM calls, 3 cache hits.
    const callModel2 = vi.fn().mockResolvedValue(MOCK_RESP)
    const cache2 = loadAiQuizCache('synthetic-slug', { cacheDir: testCacheDir })
    const { map: parsedMap2, allDirective: ad2 } = parseRulesVrEnriched(rulesContent)
    const stats2 = { calls: 0, hits: 0, errors: 0 }
    await expandAiAuthoredQuestions(parsedMap2, stepBodies, {
      cache: cache2, callModel: callModel2, onCallStats: stats2, allDirective: ad2,
    })
    expect(callModel2).not.toHaveBeenCalled()
    expect(stats2).toMatchObject({ calls: 0, hits: 3, errors: 0 })
  })
})
```

- [ ] **Step 2: Run, expect failure**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx vitest run test/integration/ai-quiz-flow.test.ts`
Expected: pass on the test code itself but the cache hit assertion may fail because the cache's `modelName` is set to the model from the first call but not reset on second-pass load — verify the assumption that `loadAiQuizCache` returns the file as-written.

- [ ] **Step 3: Run, verify pass**

If the test fails: investigate. The most likely cause is the hashKey using a different `modelName` between writer and reader. Fix by ensuring `cache.modelName` is set consistently (the generator's response sets it on the first miss; cache.json round-trips it). If the hash also changed because `cache.modelName` was empty-string on the first hash but populated by the time cache.json is loaded for the second pass, that's a real bug — fix by re-hashing in `expandAiAuthoredQuestions` with `cache.modelName` only AFTER the cache is loaded (not from the entry's snapshot).

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx vitest run test/integration/ai-quiz-flow.test.ts`
Expected: 1/1 passing.

- [ ] **Step 4: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/208-ai-authored-quizzes" ] && \
  git add test/integration/ai-quiz-flow.test.ts && \
  git commit -m "test(integration): full AI quiz flow with cache round-trip (#208)

Verifies that:
1. parser → expand → frontmatter chain produces 3 step-keyed entries
   for [AUTOAUTHOR_ALL:mcq] across 3 step bodies.
2. Re-running with the same step bodies hits cache: 0 LLM calls,
   3 cache hits.

Locks in the cache hashKey contract end-to-end."
```

---

## Phase 5 — Evaluation harness

End state after Phase 5: `evaluate-ai-quizzes.ts` emits side-by-side CSVs from cached AI questions + parsed hand-authored questions; `aggregate-ai-quiz-eval.ts` reads filled CSVs and prints the would-ship report. Both scripts are pure CLI — no LLM calls, no DB, no network. The evaluation flow is reproducible and free.

### Task 8: `evaluate-ai-quizzes.ts` — CSV emitter

**Files:**
- Create: `scripts/evaluate-ai-quizzes.ts`
- Create: `scripts/__tests__/evaluate-ai-quizzes.test.ts` (new)

3 unit tests on the pure CSV-shaping helper. The CLI orchestration (arg parsing, file I/O) is exercised via the integration test in Task 7's pattern but kept thin so it doesn't need its own test file.

- [ ] **Step 1: Write the failing tests (3 cases)**

Create `scripts/__tests__/evaluate-ai-quizzes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildEvalRows, type EvalInputs } from '../evaluate-ai-quizzes.js'

describe('buildEvalRows (#208 eval harness)', () => {
  it('emits paired rows: hand-authored + AI-authored for the same step', () => {
    const inputs: EvalInputs = {
      slug: 'cap-getting-started',
      handAuthored: new Map([
        [3, [
          { id: 'validate-3', type: 'multiple-choice', question: 'What does cds.connect.to do?', options: ['A', 'B', 'C', 'D'], correctAnswer: 'B' },
        ]],
      ]),
      aiAuthored: new Map([
        [3, [
          { id: 'validate-3-ai-1', type: 'multiple-choice', question: 'Which CDS API connects to a runtime service?', options: ['cds.connect.to', 'cds.requires', 'cds.entities', 'cds.serve'], correctAnswer: 'cds.connect.to', aiAuthored: true },
          { id: 'validate-3-ai-2', type: 'text', question: 'Explain the difference between cds.connect.to and cds.requires', __aiCorrectAnswer: 'cds.connect.to is a runtime call; cds.requires is a declaration', aiGrading: true, aiAuthored: true },
        ]],
      ]),
    }
    const rows = buildEvalRows(inputs)
    expect(rows).toHaveLength(3)  // 1 hand + 2 AI
    expect(rows[0]).toMatchObject({ slug: 'cap-getting-started', stepNumber: 3, source: 'hand-authored', questionType: 'multiple-choice' })
    expect(rows[1]).toMatchObject({ source: 'ai-authored', questionType: 'multiple-choice', correctAnswer: 'cds.connect.to' })
    expect(rows[2]).toMatchObject({ source: 'ai-authored', questionType: 'text', correctAnswer: 'cds.connect.to is a runtime call; cds.requires is a declaration' })
    // Sentinel field stripped from text question's emit
    expect((rows[2] as any).__aiCorrectAnswer).toBeUndefined()
  })

  it('skips steps that lack both hand AND AI questions', () => {
    const inputs: EvalInputs = {
      slug: 's',
      handAuthored: new Map([[1, []]]),
      aiAuthored: new Map([[1, []]]),
    }
    expect(buildEvalRows(inputs)).toEqual([])
  })

  it('only emits steps that have BOTH hand AND AI questions (the comparison case)', () => {
    const inputs: EvalInputs = {
      slug: 's',
      handAuthored: new Map([
        [1, [{ id: 'validate-1', type: 'text', question: 'Q1?', correctAnswer: 'A1' }]],  // hand only
        [2, [{ id: 'validate-2', type: 'text', question: 'Q2?', correctAnswer: 'A2' }]],  // both
      ]),
      aiAuthored: new Map([
        [2, [{ id: 'validate-2-ai-1', type: 'text', question: 'AI Q2?', __aiCorrectAnswer: 'AI A2', aiGrading: true, aiAuthored: true }]],
        [3, [{ id: 'validate-3-ai-1', type: 'text', question: 'AI Q3?', __aiCorrectAnswer: 'AI A3', aiGrading: true, aiAuthored: true }]],  // ai only
      ]),
    }
    const rows = buildEvalRows(inputs)
    // Only step 2 has both. Step 1 hand-only and step 3 ai-only are skipped.
    expect(rows.every(r => r.stepNumber === 2)).toBe(true)
    expect(rows).toHaveLength(2)  // 1 hand + 1 AI for step 2
  })
})
```

- [ ] **Step 2: Run tests, expect failure**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx vitest run scripts/__tests__/evaluate-ai-quizzes.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `evaluate-ai-quizzes.ts`**

Create `scripts/evaluate-ai-quizzes.ts`:

```ts
#!/usr/bin/env tsx
// scripts/evaluate-ai-quizzes.ts
//
// CSV emitter for the #208 evaluation harness. Reads pilot-slug
// AI quiz caches + hand-authored [VALIDATE_N] questions, emits a
// side-by-side CSV the author hand-grades.
//
// Usage:
//   npx tsx scripts/evaluate-ai-quizzes.ts --slugs slug-a,slug-b --output verdicts/eval.csv [--types both]
//
// Outputs CSV with columns:
//   slug, stepNumber, source, questionType, question, correctAnswer,
//   options, authorWouldShip, authorNotes
//
// The author fills in authorWouldShip (yes/no/maybe) + authorNotes;
// scripts/aggregate-ai-quiz-eval.ts reads the filled CSV and prints
// the would-ship report.
//
// Spec: docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseRulesVrEnriched } from './parsers/rules.js'
import { loadAiQuizCache } from './lib/ai-quiz-cache.js'
import type { ValidationQuestion } from './parsers/types.js'

export interface EvalInputs {
  slug: string
  handAuthored: Map<number, ValidationQuestion[]>
  aiAuthored: Map<number, ValidationQuestion[]>
}

export interface EvalRow {
  slug: string
  stepNumber: number
  source: 'hand-authored' | 'ai-authored'
  questionType: 'multiple-choice' | 'text'
  question: string
  correctAnswer: string
  options: string  // pipe-separated
  authorWouldShip: ''  // filled by reviewer
  authorNotes: ''      // filled by reviewer
}

/**
 * Pure helper — emits one row per question for steps that have BOTH
 * hand-authored AND AI-authored questions (the comparison case).
 */
export function buildEvalRows(inputs: EvalInputs): EvalRow[] {
  const rows: EvalRow[] = []
  for (const [stepNum, hand] of inputs.handAuthored) {
    if (hand.length === 0) continue
    const ai = inputs.aiAuthored.get(stepNum) ?? []
    if (ai.length === 0) continue  // only emit steps that have BOTH
    for (const q of hand) rows.push(toRow(inputs.slug, stepNum, 'hand-authored', q))
    for (const q of ai) rows.push(toRow(inputs.slug, stepNum, 'ai-authored', q))
  }
  return rows
}

function toRow(
  slug: string,
  stepNumber: number,
  source: 'hand-authored' | 'ai-authored',
  q: ValidationQuestion,
): EvalRow {
  // For AI-authored text questions, the correctAnswer is in __aiCorrectAnswer
  // (the public ValidationQuestion shape strips correctAnswer per #209 anti-leak).
  const correctAnswer = (q as any).__aiCorrectAnswer ?? q.correctAnswer ?? ''
  return {
    slug,
    stepNumber,
    source,
    questionType: q.type,
    question: q.question,
    correctAnswer,
    options: (q.options ?? []).join(' | '),
    authorWouldShip: '',
    authorNotes: '',
  }
}

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

export function rowsToCSV(rows: EvalRow[]): string {
  const headers = ['slug', 'stepNumber', 'source', 'questionType', 'question', 'correctAnswer', 'options', 'authorWouldShip', 'authorNotes']
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push([
      csvEscape(r.slug),
      String(r.stepNumber),
      r.source,
      r.questionType,
      csvEscape(r.question),
      csvEscape(r.correctAnswer),
      csvEscape(r.options),
      r.authorWouldShip,
      r.authorNotes,
    ].join(','))
  }
  return lines.join('\n') + '\n'
}

// ─── CLI ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { slugs: string[]; output: string; types: 'mcq' | 'text' | 'both' } {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      args.set(key, argv[i + 1] ?? '')
      i++
    }
  }
  const slugs = (args.get('slugs') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const output = args.get('output') ?? ''
  const types = (args.get('types') ?? 'both') as 'mcq' | 'text' | 'both'
  if (!slugs.length || !output) {
    console.error('Usage: tsx scripts/evaluate-ai-quizzes.ts --slugs <comma-list> --output <path> [--types mcq|text|both]')
    process.exit(2)
  }
  return { slugs, output, types }
}

async function main() {
  const { slugs, output, types } = parseArgs(process.argv.slice(2))
  const allRows: EvalRow[] = []

  for (const slug of slugs) {
    // Read hand-authored from cached rules.vr
    const rulesPath = join('.tutorial-cache', `${slug}.rules.vr`)
    if (!existsSync(rulesPath)) {
      console.warn(`[evaluate] missing rules.vr cache for ${slug} (run fetch-tutorials first)`)
      continue
    }
    const rulesContent = readFileSync(rulesPath, 'utf8')
    const { map: handAuthored } = parseRulesVrEnriched(rulesContent)

    // Read AI-authored from cache file
    const aiCache = loadAiQuizCache(slug)
    const aiAuthored = new Map<number, ValidationQuestion[]>()
    for (const [stepNumStr, entry] of Object.entries(aiCache.entries)) {
      aiAuthored.set(parseInt(stepNumStr, 10), entry.questions)
    }

    // Filter by --types
    const filterFn = (q: ValidationQuestion) => {
      if (types === 'both') return true
      if (types === 'mcq') return q.type === 'multiple-choice'
      if (types === 'text') return q.type === 'text'
      return true
    }
    for (const [stepNum, qs] of handAuthored) handAuthored.set(stepNum, qs.filter(filterFn))
    for (const [stepNum, qs] of aiAuthored) aiAuthored.set(stepNum, qs.filter(filterFn))

    allRows.push(...buildEvalRows({ slug, handAuthored, aiAuthored }))
  }

  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, rowsToCSV(allRows))
  console.log(`[evaluate] wrote ${allRows.length} rows across ${slugs.length} slugs → ${output}`)
}

// ESM entry guard — see scripts/check-build-collisions.ts pattern (#255)
import { pathToFileURL } from 'node:url'
const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (isDirect) main()
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx vitest run scripts/__tests__/evaluate-ai-quizzes.test.ts`
Expected: 3/3 passing.

- [ ] **Step 5: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/208-ai-authored-quizzes" ] && \
  git add scripts/evaluate-ai-quizzes.ts scripts/__tests__/evaluate-ai-quizzes.test.ts && \
  git commit -m "feat(ai-quiz): evaluation CSV emitter (#208)

- buildEvalRows() pure helper: only emits paired rows for steps that
  have BOTH hand-authored AND AI-authored questions.
- For AI-authored text questions, surfaces correctAnswer from the
  cache's __aiCorrectAnswer sentinel (the public ValidationQuestion
  shape strips correctAnswer per #209 anti-leak).
- CLI: --slugs comma-list, --output csv-path, --types mcq|text|both.
- 3/3 unit tests pass."
```

---

### Task 9: `aggregate-ai-quiz-eval.ts` — would-ship report

**Files:**
- Create: `scripts/aggregate-ai-quiz-eval.ts`
- Create: `scripts/__tests__/aggregate-ai-quiz-eval.test.ts` (new)

3 unit tests on the aggregation math + rejection-note tokenization. The CLI orchestration (glob expansion, file I/O) stays thin.

- [ ] **Step 1: Write the failing tests (3 cases)**

Create `scripts/__tests__/aggregate-ai-quiz-eval.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { aggregateRows, tokenizeNotes, type FilledRow } from '../aggregate-ai-quiz-eval.js'

const ROW = (overrides: Partial<FilledRow> = {}): FilledRow => ({
  slug: 's', stepNumber: 1, source: 'ai-authored', questionType: 'multiple-choice',
  question: 'Q', correctAnswer: 'A', options: 'a | b | c | d',
  authorWouldShip: '', authorNotes: '',
  ...overrides,
})

describe('aggregateRows (#208 eval aggregation)', () => {
  it('counts MCQ + text would-ship rates correctly across multiple authors', () => {
    const rows: FilledRow[] = [
      // Hand rows are skipped — only AI rows count toward the would-ship rate.
      ROW({ source: 'hand-authored', authorWouldShip: '' }),  // skipped
      ROW({ source: 'ai-authored', questionType: 'multiple-choice', authorWouldShip: 'yes' }),
      ROW({ source: 'ai-authored', questionType: 'multiple-choice', authorWouldShip: 'yes' }),
      ROW({ source: 'ai-authored', questionType: 'multiple-choice', authorWouldShip: 'no' }),
      ROW({ source: 'ai-authored', questionType: 'text', authorWouldShip: 'yes' }),
      ROW({ source: 'ai-authored', questionType: 'text', authorWouldShip: 'no' }),
      ROW({ source: 'ai-authored', questionType: 'text', authorWouldShip: 'maybe' }),  // 'maybe' counts as no
    ]
    const agg = aggregateRows(rows)
    expect(agg.mcq).toEqual({ total: 3, yes: 2, rate: 2 / 3 })
    expect(agg.text).toEqual({ total: 3, yes: 1, rate: 1 / 3 })
    expect(agg.overall).toEqual({ total: 6, yes: 3, rate: 0.5 })
    expect(agg.tutorialsEvaluated).toBe(1)
    expect(agg.stepsWithBoth).toBe(1)  // only step 1 has rows
  })

  it('returns zeroed buckets when no AI rows are filled', () => {
    const rows: FilledRow[] = [
      ROW({ source: 'hand-authored' }),
      ROW({ source: 'ai-authored', authorWouldShip: '' }),  // unfilled — counted as total but not yes
    ]
    const agg = aggregateRows(rows)
    expect(agg.overall).toEqual({ total: 1, yes: 0, rate: 0 })
  })

  it('tokenizeNotes counts substring frequencies (case-insensitive, punctuation-split)', () => {
    const notes = [
      'answer too vague',
      'Answer too vague',
      'wrong on a fact',
      'duplicates earlier question',
      'Wrong on a fact, also too vague.',
    ]
    const counts = tokenizeNotes(notes)
    expect(counts.get('too vague')).toBe(3)
    expect(counts.get('wrong on a fact')).toBe(2)
    expect(counts.get('duplicates earlier question')).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests, expect failure**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx vitest run scripts/__tests__/aggregate-ai-quiz-eval.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `aggregate-ai-quiz-eval.ts`**

Create `scripts/aggregate-ai-quiz-eval.ts`:

```ts
#!/usr/bin/env tsx
// scripts/aggregate-ai-quiz-eval.ts
//
// Reads filled CSV(s) from scripts/evaluate-ai-quizzes.ts, prints a
// would-ship report. Drives the spike's graduate / iterate / shelve
// decision per the threshold table in the spec.
//
// Usage:
//   npx tsx scripts/aggregate-ai-quiz-eval.ts <csv-glob>
//
// Spec: docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md

import { readFileSync } from 'node:fs'

// Node 20 (project minimum per CLAUDE.md) has no built-in glob; we accept
// literal CSV paths instead. Authors typically have a small number of
// per-pilot CSVs; aggregating across many is fine via shell-side wildcards
// the user passes through (the shell expands them before invocation).

export interface FilledRow {
  slug: string
  stepNumber: number
  source: 'hand-authored' | 'ai-authored'
  questionType: 'multiple-choice' | 'text'
  question: string
  correctAnswer: string
  options: string
  authorWouldShip: '' | 'yes' | 'no' | 'maybe'
  authorNotes: string
}

export interface Aggregate {
  tutorialsEvaluated: number
  stepsWithBoth: number
  mcq: { total: number; yes: number; rate: number }
  text: { total: number; yes: number; rate: number }
  overall: { total: number; yes: number; rate: number }
}

export function aggregateRows(rows: FilledRow[]): Aggregate {
  const aiRows = rows.filter(r => r.source === 'ai-authored')
  const tutorials = new Set(rows.map(r => r.slug))
  const stepKeys = new Set(rows.map(r => `${r.slug}#${r.stepNumber}`))

  const buckets = (rs: FilledRow[]) => {
    const total = rs.length
    const yes = rs.filter(r => r.authorWouldShip === 'yes').length
    return { total, yes, rate: total === 0 ? 0 : yes / total }
  }
  return {
    tutorialsEvaluated: tutorials.size,
    stepsWithBoth: stepKeys.size,
    mcq: buckets(aiRows.filter(r => r.questionType === 'multiple-choice')),
    text: buckets(aiRows.filter(r => r.questionType === 'text')),
    overall: buckets(aiRows),
  }
}

/** Tokenize rejection notes — case-insensitive, punctuation-split, substring-frequency.
 *  Good-enough heuristic for an N=~100 sample (per spec; not formal NLP). */
export function tokenizeNotes(notes: string[]): Map<string, number> {
  const phrases = new Map<string, number>()
  for (const note of notes) {
    if (!note.trim()) continue
    // Split on punctuation/newline; keep multi-word fragments.
    const fragments = note.toLowerCase().split(/[.,;\n]/).map(s => s.trim()).filter(s => s.length > 3)
    for (const f of fragments) {
      // Strip leading "answer", "the answer", "this is" filler so similar
      // critiques cluster.
      const cleaned = f.replace(/^(answer|the answer|this is|it is|it's)\s+/, '').trim()
      if (!cleaned) continue
      phrases.set(cleaned, (phrases.get(cleaned) ?? 0) + 1)
    }
  }
  return phrases
}

function parseCSV(content: string): FilledRow[] {
  const lines = content.split(/\r?\n/).filter(l => l.length > 0)
  if (lines.length === 0) return []
  const headers = parseCsvLine(lines[0])
  const rows: FilledRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i])
    const row: any = {}
    headers.forEach((h, j) => row[h] = fields[j] ?? '')
    row.stepNumber = parseInt(row.stepNumber, 10) || 0
    rows.push(row as FilledRow)
  }
  return rows
}

function parseCsvLine(line: string): string[] {
  // Minimal CSV parser — handles quoted fields with embedded commas + escaped quotes.
  const out: string[] = []
  let cur = '', inQuotes = false, i = 0
  while (i < line.length) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 2; continue }
      if (c === '"') { inQuotes = false; i++; continue }
      cur += c; i++
    } else {
      if (c === '"') { inQuotes = true; i++; continue }
      if (c === ',') { out.push(cur); cur = ''; i++; continue }
      cur += c; i++
    }
  }
  out.push(cur)
  return out
}

function main() {
  const args = process.argv.slice(2)
  if (!args.length) {
    console.error('Usage: tsx scripts/aggregate-ai-quiz-eval.ts <csv-path-or-glob> [...more]')
    process.exit(2)
  }
  const allRows: FilledRow[] = []
  // Each arg is a literal CSV path. Shell-side wildcards (e.g.
  // `verdicts/*.csv`) expand before this script sees them — this is
  // standard Unix behavior and avoids requiring globSync (Node 22+).
  for (const csvPath of args) {
    try {
      allRows.push(...parseCSV(readFileSync(csvPath, 'utf8')))
    } catch (err) {
      console.warn(`[aggregate] skip ${csvPath}:`, (err as Error).message)
    }
  }
  const agg = aggregateRows(allRows)
  const aiRows = allRows.filter(r => r.source === 'ai-authored')
  const noteCounts = [...tokenizeNotes(aiRows.map(r => r.authorNotes)).entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 10)

  console.log(`=== AI-authored quiz evaluation ===`)
  console.log(`Tutorials evaluated: ${agg.tutorialsEvaluated}`)
  console.log(`Steps with both hand+AI: ${agg.stepsWithBoth}`)
  console.log(`AI questions reviewed: ${agg.overall.total} (${agg.mcq.total} MCQ, ${agg.text.total} text)`)
  console.log()
  console.log(`By type:`)
  console.log(`  MCQ:   ${agg.mcq.yes} / ${agg.mcq.total} marked "yes" → ${(agg.mcq.rate * 100).toFixed(0)}% would-ship`)
  console.log(`  Text:  ${agg.text.yes} / ${agg.text.total} marked "yes" → ${(agg.text.rate * 100).toFixed(0)}% would-ship`)
  console.log()
  console.log(`Overall: ${agg.overall.yes} / ${agg.overall.total} → ${(agg.overall.rate * 100).toFixed(0)}% would-ship rate`)
  if (noteCounts.length) {
    console.log()
    console.log(`Most-common rejection notes (text frequency):`)
    for (const [phrase, count] of noteCounts) console.log(`  - "${phrase}" (${count})`)
  }
}

import { pathToFileURL } from 'node:url'
const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (isDirect) main()
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx vitest run scripts/__tests__/aggregate-ai-quiz-eval.test.ts`
Expected: 3/3 passing.

- [ ] **Step 5: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/208-ai-authored-quizzes" ] && \
  git add scripts/aggregate-ai-quiz-eval.ts scripts/__tests__/aggregate-ai-quiz-eval.test.ts && \
  git commit -m "feat(ai-quiz): would-ship aggregation reducer (#208)

Reads filled CSVs from evaluate-ai-quizzes.ts, prints the by-type
+ overall would-ship rate that drives the spike's graduate / iterate
/ shelve decision per the threshold table in the spec:
  ≥75% overall + MCQ ≥80% + text ≥60% → graduate
  50-74%                              → iterate (try v2 prompt)
  <50%                                → shelve

Plus rejection-note frequency for failure-mode analysis. Notes are
tokenized by punctuation-split + filler-prefix-strip; good-enough
heuristic for an N≈100 sample.

3/3 unit tests pass."
```

---

## Phase 6 — Docs + final verification + draft PR

End state after Phase 6: developer-reference doc shipped + sidebar registered + `predocs:build` passes; CLAUDE.md gotcha entry added; final verification + draft PR opened.

### Task 10: Developer doc + sidebar registration + CLAUDE.md gotcha

**Files:**
- Create: `docs/developers/architecture/ai-authored-quizzes.md`
- Modify: `docs/.vitepress/config.ts` (sidebar entry)
- Modify: `CLAUDE.md` (Gotchas section)

- [ ] **Step 1: Read existing precedent doc**

Run: `cat docs/developers/architecture/free-text-grader.md` (PR #234's reference). Use its structure as the template — flow diagram, directive syntax, anti-leak guarantees, rate limits / cost, local dev, author flow, references.

- [ ] **Step 2: Write `docs/developers/architecture/ai-authored-quizzes.md`**

Cover (~50 lines):

- End-to-end flow diagram — author writes `[AUTOAUTHOR_*]` → parser emits placeholder → `expandAiAuthoredQuestions` calls LLM → cache write → emitted as ValidationQuestion[] → flows through validation widget + `validate-answer-spec-publish` (for text questions) identically to hand-authored content.
- Directive syntax + precedence table (per-step wins over tutorial-wide; hand-authored `[VALIDATE_N]` always wins).
- Cache invalidation rules — content-hash; deleting `.tutorial-cache/<slug>.ai-quiz-cache.json` re-pays cost for that one slug.
- Cost table (per-call ~0.005-0.012 USD; default cap 200/build; first-pilot ≈ $0.60).
- Operator runbook (verbatim from spec section "Operator runbook" — 9 steps).
- Spike exit criteria (graduate/iterate/shelve thresholds).
- Cross-references to PR #205 + PR #226 + PR #234 + spec.

- [ ] **Step 3: Register in sidebar**

Edit `docs/.vitepress/config.ts`. Find the `architecture/` group in `themeConfig.sidebar`. Add an entry adjacent to `free-text-grader`:

```ts
{ text: 'AI-authored quizzes',           link: '/developers/architecture/ai-authored-quizzes' },
```

- [ ] **Step 4: Add CLAUDE.md gotcha**

Append to the Gotchas section (next to the existing "AI code-check" entry around line ~270):

```markdown
- **AI-authored quizzes (issue #208, behind `AI_AUTHOR_ENABLED=true`)** — author opt-in via `[AUTOAUTHOR_*]` directives in `rules.vr`; per-step or tutorial-wide, with optional `:mcq` / `:text` type suffixes. Default-OFF; runs as a post-parse expansion step in `scripts/fetch-tutorials.ts`. Per-tutorial content-hash cache at `.tutorial-cache/<slug>.ai-quiz-cache.json`. Hard cap default 200 LLM calls per build (configurable via `AI_AUTHOR_BUILD_CAP`). Use `npm run seed-ai-quizzes` for the first-time bulk-seed pass. AI-authored questions emit the same `ValidationQuestion` shape as hand-authored ones; the validation widget (PR #226) and AI free-text grader (PR #234) treat them identically. Eval harness at `scripts/evaluate-ai-quizzes.ts` + `scripts/aggregate-ai-quiz-eval.ts`. Spec: [docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md](docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md).
```

- [ ] **Step 5: Run sidebar guard**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npm run docs:build 2>&1 | tail -10`
Expected: pass. The `predocs:build` check rejects unregistered pages or dead links — adding the sidebar entry above clears it.

- [ ] **Step 6: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/208-ai-authored-quizzes" ] && \
  git add docs/developers/architecture/ai-authored-quizzes.md docs/.vitepress/config.ts CLAUDE.md && \
  git commit -m "docs: AI-authored quizzes reference (#208)

End-to-end flow + directive syntax + precedence table + cache
invalidation + cost table + operator runbook + spike exit criteria.
Sidebar entry added under developers/architecture/. CLAUDE.md
Gotchas entry parallels the existing AI code-check entry.

predocs:build sidebar guard passes."
```

---

### Task 11: Final verification + draft PR

- [ ] **Step 1: Run the full new-test suite**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx vitest run scripts/parsers/__tests__/rules-autoauthor.test.ts srv/lib/__tests__/ai-quiz-generator.test.js scripts/__tests__/ai-quiz-cache.test.ts scripts/__tests__/expand-ai-authored.test.ts test/integration/ai-quiz-flow.test.ts scripts/__tests__/evaluate-ai-quizzes.test.ts scripts/__tests__/aggregate-ai-quiz-eval.test.ts`
Expected: all green. Specifically:

- 6 in `rules-autoauthor.test.ts` (Task 2)
- 10 in `ai-quiz-generator.test.js` (Task 3)
- 4 in `ai-quiz-cache.test.ts` (Task 4)
- 6 in `expand-ai-authored.test.ts` (Task 5)
- 1 in `ai-quiz-flow.test.ts` (Task 7)
- 3 in `evaluate-ai-quizzes.test.ts` (Task 8)
- 3 in `aggregate-ai-quiz-eval.test.ts` (Task 9)

= 33 new unit/integration tests.

- [ ] **Step 2: Run lint / type-check**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx tsc --noEmit -p . 2>&1 | tail -20`
Expected: no errors related to new modules.

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npx eslint scripts/lib/ai-quiz-cache.ts scripts/lib/expand-ai-authored.ts scripts/evaluate-ai-quizzes.ts scripts/aggregate-ai-quiz-eval.ts srv/lib/ai-quiz-generator.js 2>&1 | tail -10`
Expected: no errors. (Project's lint may not be wired to a strict `npm run` script; if `eslint` isn't found, skip — it's covered by CI.)

- [ ] **Step 3: Run the build-collisions guard (Task 11 of #255)**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && npm run postbuild:apps 2>&1 | tail -3`
Expected: `[check-build-collisions] OK — N Vite entries vs M Hugo js.Build refs, no collisions.` (No new collisions since this PR doesn't touch Vite/Hugo's build entries.)

- [ ] **Step 4: Smoke-test the flag-OFF default**

Run: `cd d:/projects/tutorials-poc/.worktrees/spec-208 && AI_AUTHOR_ENABLED= node -e "
const m = require('./scripts/parsers/rules.js');
const c = 'tutorial body';
const result = m.parseRulesVrEnriched(c);
console.log('flag-off behavior: parser still imports cleanly, allDirective=', result.allDirective);
"`
Expected: imports cleanly. `allDirective` is undefined for `rules.vr` content with no `[AUTOAUTHOR_ALL]` directive.

- [ ] **Step 5: Verify worktree state + push**

Run:

```bash
cd d:/projects/tutorials-poc/.worktrees/spec-208 && \
  BR=$(git branch --show-current) && [ "$BR" = "feature/208-ai-authored-quizzes" ] && \
  git status --short && \
  git log --oneline main..HEAD
```

Expected: working tree clean (no untracked + no modified). Commits enumerated:

1. Task 1 — `feat(types):` ValidationQuestion.aiAuthored
2. Task 2 — `feat(parser):` `[AUTOAUTHOR_*]` directives
3. Task 3 — `feat(ai-quiz):` generator + anti-leak guards
4. Task 4 — `feat(ai-quiz):` cache helper
5. Task 5 — `feat(ai-quiz):` post-parse expansion orchestrator
6. Task 6 — `feat(ai-quiz):` wire fetch-tutorials + seed script
7. Task 7 — `test(integration):` cache round-trip
8. Task 8 — `feat(ai-quiz):` evaluation CSV emitter
9. Task 9 — `feat(ai-quiz):` would-ship aggregation
10. Task 10 — `docs:` reference + sidebar + CLAUDE.md gotcha

Push the branch:

```bash
git push -u origin feature/208-ai-authored-quizzes
```

- [ ] **Step 6: Open the draft PR**

Run:

```bash
gh pr create --draft \
  --title "feat: AI-authored quizzes spike (closes #208)" \
  --body "$(cat <<'EOF'
## Summary

Closes #208. Build-time generator that, on author opt-in via `[AUTOAUTHOR_*]` directives in `rules.vr`, produces `[VALIDATE_N]` candidate questions for tutorial steps that don't already have hand-authored ones. Mirrors PR #205's spike pattern with PR #234's anti-leak posture applied to free-text questions.

This is the third sub-capability from issue #171's original vision (after PR #205's AI code-check and PR #234's AI free-text grader).

## What ships

**Parser (`scripts/parsers/rules.ts`):** new `[AUTOAUTHOR_N]`, `[AUTOAUTHOR_N:mcq]`, `[AUTOAUTHOR_N:text]`, `[AUTOAUTHOR_ALL]`, `[AUTOAUTHOR_ALL:mcq]`, `[AUTOAUTHOR_ALL:text]` directive recognition. Per-step directives emit sentinel placeholders for steps lacking `[VALIDATE_N]`. Tutorial-wide directive captured on a new `allDirective` field of the parser return.

**Generator (`srv/lib/ai-quiz-generator.js`):** pure module. Forced tool-call schema for 1-3 ValidationQuestion[] outputs (MCQ + text). Three anti-leak guards beyond the schema: MCQ correctness consistency, leak detection, public-shape conversion (text questions strip correctAnswer per #209).

**Cache (`scripts/lib/ai-quiz-cache.ts`):** content-hash cache over per-tutorial sidecar files at `.tutorial-cache/<slug>.ai-quiz-cache.json`. Hash key uses `\x00` NUL-byte separator.

**Orchestrator (`scripts/lib/expand-ai-authored.ts`):** post-parse expansion. Walks placeholders + applies the all-directive against the actual step list. Hard cap (default 200 calls/build, configurable via `AI_AUTHOR_BUILD_CAP`); over-cap drop-not-fail per spec.

**Build wiring (`scripts/fetch-tutorials.ts`):** `AI_AUTHOR_ENABLED=true` env flag gates expansion. Slot between `parseRulesVrEnriched` and `collectAiGradedSpecs` so AI-authored text questions flow through the existing validate-answer-spec sidecar (no new publish endpoint).

**Bulk-seed escape hatch:** `npm run seed-ai-quizzes` wraps `fetch-tutorials` with the flag on + cap bumped to 10000.

**Eval harness:** `scripts/evaluate-ai-quizzes.ts` (CSV emitter) + `scripts/aggregate-ai-quiz-eval.ts` (would-ship reducer). Drives the spike's graduate / iterate / shelve decision per the threshold table.

**Anti-leak (end-to-end):**
- AI-authored MCQ: `correctAnswer` ships in public Hugo frontmatter (consistent with hand-authored MCQ; client-side equality grading per #226).
- AI-authored text: `correctAnswer` stripped from public emit (per #209). Lives in the cache + flows to `ValidateAnswerSpecs` via the existing `collectAiGradedSpecs` path.

## Cost ceiling

Per-call ~0.005-0.012 USD. Default cap 200 calls/build → ~$2.40 first-time bulk seed. Cache hits on subsequent builds (near-zero cost). 10-tutorial pilot ≈ $0.60.

## Tests

33 new unit + integration tests:

```
6  in scripts/parsers/__tests__/rules-autoauthor.test.ts
10 in srv/lib/__tests__/ai-quiz-generator.test.js
4  in scripts/__tests__/ai-quiz-cache.test.ts
6  in scripts/__tests__/expand-ai-authored.test.ts
1  in test/integration/ai-quiz-flow.test.ts
3  in scripts/__tests__/evaluate-ai-quizzes.test.ts
3  in scripts/__tests__/aggregate-ai-quiz-eval.test.ts
```

Hybrid + smoke not needed — feature is build-time only, no DB writes, no HTTP endpoint.

## Spike posture

Default-OFF behind `AI_AUTHOR_ENABLED`. Merging this PR ships only the plumbing; the spike's evaluation phase begins after the operator (Tom) flips the flag locally + adds `[AUTOAUTHOR_*]` directives to 5-10 pilot tutorials' `rules.vr` files. Threshold-driven decision per the spec:

- ≥75% overall + MCQ ≥80% + text ≥60% → graduate
- 50-74% → iterate (v2 prompt, possibly RAG)
- <50% → shelve, retain code behind flag

Detailed runbook in [`docs/developers/architecture/ai-authored-quizzes.md`](docs/developers/architecture/ai-authored-quizzes.md) (this PR).

## Closes

#208

## Related

- Spec: `docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md`
- PR #205 (#171 — AI code-check spike, the pattern this mirrors)
- PR #226 (#212 — validation widget, AI questions render through it)
- PR #234 (#209 — AI free-text grader, AI text questions submit through it)
EOF
)" \
  --base main
```

Expected: PR opens as draft, 10 commits visible.

---

## Cross-cutting concerns

### Branch hygiene (every commit)

Every commit in this plan uses the branch-guard pattern:

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/208-ai-authored-quizzes" ] && git commit ...
```

If the branch flips silently between bash invocations (a known harness bug per `feedback_verify_branch_before_commit`), the guard fails — the implementer MUST stash, re-checkout `feature/208-ai-authored-quizzes`, and try again. Never bypass.

### Commit hygiene (granularity)

Each task = one logical commit. Tests + impl + wire-up land together. Subagents must NOT commit half-finished tasks. Subagents must NOT amend prior commits without explicit instruction (unless the per-task review loop says to fix and amend — that pattern is fine).

### Naming

- Vite entry name: NOT applicable (no new Vite entry).
- File names use `ai-quiz-` prefix (parser-agnostic; this is build-pipeline + LLM-call territory) and `ai-author-` prefix for the orchestrator (which understands the parser's `[AUTOAUTHOR]` directive specifically).
- Telemetry field: `aiAuthored: true`. NOT `aiGenerated` (the spec consistently uses `aiAuthored`).

### Anti-leak invariant (recap)

The end-to-end anti-leak posture for AI-authored questions matches the pattern established by #209 + #234:

| Question type | `correctAnswer` location |
|---|---|
| AI-authored MCQ | Public Hugo frontmatter (same as hand-authored MCQ — needed for client-side equality grading) |
| AI-authored text | Stripped from public; stored in `.tutorial-cache/<slug>.ai-quiz-cache.json` (build-time) and uploaded to `ValidateAnswerSpecs` HANA entity (server-side, via existing #234 publish pipeline) |

The text-question stripping happens in `ai-quiz-generator.js`'s public-shape conversion (Guard 3). The cache stores `__aiCorrectAnswer` for the eval harness; emission to public frontmatter strips this sentinel before ValidationQuestion shape is finalized.

### Pre-flight checklist (before drafting PR)

- [ ] All 11 tasks complete + committed.
- [ ] `npx vitest run` clean on all 7 new test files (33 tests passing).
- [ ] `npx tsc --noEmit` clean on all new modules.
- [ ] `npm run docs:build` passes (sidebar registration in place).
- [ ] `npm run postbuild:apps` passes (no Vite/Hugo collisions, per #255).
- [ ] AI_AUTHOR_ENABLED= (flag-off) smoke-test confirms parser handles `[AUTOAUTHOR_*]` cleanly (no crash, just no expansion).
- [ ] All 10 commits use the branch-guard pattern.
- [ ] PR description references `closes #208`.

---

**Done.**
