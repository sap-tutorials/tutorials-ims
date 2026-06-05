# AI Free-Text Grader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace exact-match grading on opted-in `[VALIDATE_N]` text questions with LLM-graded verdicts (pass/partial/fail), gated behind `ChatSettings.validateAnswerEnabled`, persisted to `ValidateAnswerSubmissions` with full telemetry. Authors opt-in via a new `###Grading: ai-judged` directive in `rules.vr`; existing `regex` and `regex-begins-with` rule types auto-route to AI grading (fixing a pre-existing silent bug).

**Architecture:** Structurally a clone of PR #205 (AI code-check spike) with a smaller payload and 3-state UI. New `srv/lib/validate-answer-tool.js` mirrors `dispatchCheckCode`'s shape; new `srv/lib/validate-answer-prompt.js` mirrors the prompt builder + leak-redaction guard; new `POST /api/validate-answer` Express endpoint mirrors `/api/codecheck`. Reuses `defaultCallModel` from `srv/lib/code-check-llm.js` unchanged. New `ValidateAnswerSpecs` entity is populated by the publish pipeline (mirrors `CodeCheckSpecs`); new `ValidateAnswerSubmissions` entity captures every submission with full telemetry. Frontend integration extends the Vue island shipped in #226 (`hugo-apps/src/validation/Validation.vue`) with an async branch that calls the endpoint for `aiGrading: true` questions.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds` ^9.9), HANA Cloud (SQLite for unit tests), `@sap-ai-sdk/orchestration`, Vue 3 + Vite, UI5 Web Components, Vitest.

**Spec:** [`docs/superpowers/specs/2026-06-04-209-free-text-grader-design.md`](../specs/2026-06-04-209-free-text-grader-design.md)

**Tracking issue:** [sap-tutorials/tutorials-ims#209](https://github.com/sap-tutorials/tutorials-ims/issues/209)

**Depends on:** #212 (PR #226) merged 2026-06-04 — the validation Vue island this PR extends.

---

## Working assumptions

- You will work on a feature branch `feature/209-free-text-grader` cut from `spec/209-free-text-grader` (which is rebased on top of post-#226 main).
- TDD discipline on all the new srv-side modules (parser extension, prompt builder, dispatch core, handler, publish endpoint).
- Branch hygiene: every commit verifies `git branch --show-current` shows the feature branch (per [feedback_verify_branch_before_commit](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_verify_branch_before_commit.md)).
- `cf login` is NOT required for any task — the hybrid test is authored but verified post-deploy via CI.
- Do NOT run the full unit suite (`npm test` reliably hangs in fresh worktrees per [feedback_worktree_tests_hang](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_worktree_tests_hang.md)). Run targeted test files only.

## Useful skills

- `superpowers:test-driven-development` — for the TDD discipline on each new srv/lib module
- `superpowers:verification-before-completion` — before claiming a task done

## File map

**New files:**
- `srv/lib/validate-answer-prompt.js` — `buildSystemPrompt`, `buildUserMessage`, `VALIDATE_ANSWER_OUTPUT_SCHEMA`, `redactReferenceLeaks` (re-export from code-check), `PROMPT_VERSION`. Pure module.
- `srv/lib/validate-answer-tool.js` — `dispatchValidateAnswer(input, deps)` core dispatch.
- `srv/lib/validate-answer-handler.js` — Express handler factory `makeValidateAnswerHandler(deps)` with rate limits.
- `srv/lib/validate-answer-question-loader.js` — `defaultLoadQuestion(slug, stepNumber, questionId)` reads from `ValidateAnswerSpecs` entity.
- `srv/lib/validate-answer-spec-publish.js` — `validateAnswerSpecPublishHandler(req, res)` for `POST /content/validate-answer-specs`.
- `scripts/lib/publish-validate-answer.js` — `collectValidateAnswerSpecs(cacheDir)` + `publishValidateAnswerSpecs(baseUrl, apiKey, specs)` for the CLI.
- `test/unit/rules-parser-grading.test.js` — parser tests for `###Grading` directive + regex auto-route (~5 cases).
- `test/unit/validate-answer-prompt.test.js` — prompt builder tests (~7 cases).
- `test/unit/validate-answer-tool.test.js` — dispatch core tests (~7 cases).
- `test/unit/validate-answer-handler.test.js` — Express handler tests (~13 cases).
- `test/unit/validate-answer-spec-publish.test.js` — publish endpoint tests (~5 cases).
- `test/unit/validate-answer-publish-cli.test.js` — CLI helper tests (~3 cases).
- `test/hybrid/validate-answer.test.js` — hybrid test for `@PersonalData` cascade.
- `test/smoke/validate-answer.test.js` — smoke test (auth + flag-gating + happy path).
- `docs/developers/architecture/validate-answer.md` — developer reference (~50 lines).

**Modified files:**
- `db/schema.cds` — add `ValidateAnswerSpecs` entity, `ValidateAnswerSubmissions` entity, `ChatSettings.validateAnswerEnabled` flag.
- `db/audit-logging.cds` — `@PersonalData` annotation on `ValidateAnswerSubmissions`.
- `scripts/parsers/rules.ts` — extend `parseBlock` to read `###Grading` directive + auto-route on regex rule types.
- `scripts/parsers/types.ts` — add `aiGrading?: boolean` to `ValidationQuestion` interface.
- `scripts/fetch-tutorials.ts` — write `<slug>.validate-answer.json` sidecar for AI-graded questions (mirrors `<slug>.codecheck.json`).
- `scripts/publish-content.ts` — call `publishValidateAnswerSpecs` after the chunked content commit.
- `srv/server.js` — wire `POST /api/validate-answer` route + `POST /content/validate-answer-specs` route.
- `app/admin-annotations.cds` — `@analytics.exposed` on `ValidateAnswerSubmissions`.
- `hugo-apps/src/validation/Validation.vue` — extend `onSubmit` to branch on `aiGrading`; render 3-state UI (pass/partial-with-hint/fail).
- `hugo-apps/src/validation/grading.ts` — `aiGrading?: boolean` already on `ValidationQuestion` from #226 (no change needed; verify).
- `docs/.vitepress/config.ts` — sidebar registration for the new architecture doc.
- `CLAUDE.md` — Gotchas section: `regex` rule type auto-routing.

---

## Phase 1 — Backend behind a flag

End state: a curl with a fresh XSUAA token + a known-seeded spec returns a structured verdict. Flag-off returns 503. Rate-limit returns 429. No frontend yet.

### Task 1: CDS schema — entities + flag

**Files:**
- Modify: `db/schema.cds`
- Modify: `db/audit-logging.cds`
- Test: `test/unit/validate-answer-schema.test.js` (new)

- [ ] **Step 1: Write the failing schema test**

Create `test/unit/validate-answer-schema.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

describe('ValidateAnswer CDS schema', () => {
  beforeAll(async () => {
    await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
  });

  it('ValidateAnswerSpecs accepts insert with required fields', async () => {
    const { Tutorials, ValidateAnswerSpecs } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries({ ID: '11111111-1111-1111-1111-111111111111', slug: 't1', title: 'T1', status: 'ACTIVE' });
    await INSERT.into(ValidateAnswerSpecs).entries({
      tutorial_ID: '11111111-1111-1111-1111-111111111111',
      stepNumber: 3,
      questionId: 'validate-3',
      questionText: 'What is the difference between cds.connect.to and cds.requires?',
      correctAnswer: 'connect.to is runtime; requires is declaration.',
      ruleType: 'exact-match',
      aiGrading: true
    });
    const rows = await SELECT.from(ValidateAnswerSpecs);
    expect(rows).toHaveLength(1);
    expect(rows[0].questionText).toMatch(/connect.to and cds.requires/);
  });

  it('ValidateAnswerSubmissions accepts insert with required fields', async () => {
    const { ValidateAnswerSubmissions } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ValidateAnswerSubmissions).entries({
      ID: '22222222-2222-2222-2222-222222222222',
      tutorialSlug: 't1', stepNumber: 3,
      questionId: 'validate-3',
      submittedAnswer: 'one connects to a service, the other declares it',
      verdict: 'pass'
    });
    const rows = await SELECT.from(ValidateAnswerSubmissions);
    expect(rows).toHaveLength(1);
  });

  it('ChatSettings exposes validateAnswerEnabled with default false', async () => {
    // Use cds.db.model.definitions per project memory [Module Singletons in vitest+CDS]
    const insp = cds.db.model.definitions['com.sap.developers.ims.ChatSettings'];
    expect(insp.elements.validateAnswerEnabled).toBeDefined();
    expect(insp.elements.validateAnswerEnabled.type).toBe('cds.Boolean');
    expect(insp.elements.validateAnswerEnabled.default?.val).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run test/unit/validate-answer-schema.test.js`
Expected: fail with `ValidateAnswerSpecs is undefined` or similar.

- [ ] **Step 3: Add the entities + flag to `db/schema.cds`**

Find the existing `entity ChatSettings : cuid, managed { … }` block. Add the new flag at the end:

```cds
  // AI free-text grader (issue #209). When false, /api/validate-answer → 503
  // and the dispatch short-circuits without calling the LLM.
  validateAnswerEnabled : Boolean default false;
```

After `entity CodeCheckSubmissions { … }` (or wherever the code-check entities live), add:

```cds
// Author-supplied free-text-grader specs per (tutorial, step, questionId).
// Populated by the publish-content pipeline; read by srv/lib/validate-answer-tool.js.
// Server-only — `correctAnswer` lives ONLY here for AI-graded questions.
// The parser (Task 2) strips correctAnswer from the public Hugo frontmatter
// when aiGrading: true, so the LLM grader's reference answer never enters
// the <script id="tutorial-data"> JSON shipped to clients.
entity ValidateAnswerSpecs : managed {
  key tutorial      : Association to Tutorials;
  key stepNumber    : Integer;
  key questionId    : String(40);
  questionText      : LargeString @mandatory;
  correctAnswer     : LargeString @mandatory;
  ruleType          : String(40);          // e.g. 'exact-match', 'regex', 'regex-begins-with'
  aiGrading         : Boolean default false;
}

// Every learner submission. Drives offline grader-quality evaluation.
// 'verdict' allows 'error' as a server-side outcome value (the LLM JSON
// schema only emits 'pass' | 'partial' | 'fail').
entity ValidateAnswerSubmissions : managed {
  key ID            : UUID;
  user              : Association to Users;
  tutorialSlug      : String(200) @mandatory;
  stepNumber        : Integer @mandatory;
  questionId        : String(40);
  questionText      : LargeString;         // captured for offline eval
  correctAnswer     : LargeString;         // captured for offline eval
  submittedAnswer   : LargeString @mandatory;
  verdict           : String(10);          // 'pass'|'partial'|'fail'|'error'
  summary           : LargeString;
  hint              : LargeString;         // null on pass/fail; populated on partial
  modelName         : String(80);
  promptVersion     : String(10);
  promptTokens      : Integer;
  completionTokens  : Integer;
  latencyMs         : Integer;
  errorReason       : String(200);
}
```

- [ ] **Step 4: Add `@PersonalData` annotations**

In [`db/audit-logging.cds`](../../../db/audit-logging.cds), follow the existing pattern for `CodeCheckSubmissions` (annotated by PR #205, default cascade by PR #221):

```cds
annotate ims.ValidateAnswerSubmissions with @PersonalData : {
  EntitySemantics: 'Other'
} {
  user            @PersonalData.FieldSemantics: 'DataSubjectID';
  submittedAnswer @PersonalData.IsPotentiallyPersonal;
};
```

Default `'null-personal'` cascade applies via the PR #221 annotation walker — no JS change needed.

- [ ] **Step 5: Run test, verify pass**

Run: `npx vitest run test/unit/validate-answer-schema.test.js`
Expected: 3 passing.

- [ ] **Step 6: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/209-free-text-grader" ] && \
  git add db/schema.cds db/audit-logging.cds test/unit/validate-answer-schema.test.js && \
  git commit -m "feat(codecheck): add ValidateAnswerSpecs + ValidateAnswerSubmissions entities (#209)

- ChatSettings.validateAnswerEnabled flag (default false).
- ValidateAnswerSpecs: server-only spec including correctAnswer.
- ValidateAnswerSubmissions: per-submission telemetry, @PersonalData
  annotated with EntitySemantics: 'Other'. Default 'null-personal'
  cascade from PR #221 applies automatically.

Refs sap-tutorials/tutorials-ims#209"
```

---

### Task 2: Parser extension — `###Grading` directive + regex auto-route

**Files:**
- Modify: `scripts/parsers/types.ts` (add `aiGrading?: boolean` to `ValidationQuestion`)
- Modify: `scripts/parsers/rules.ts` (extend `parseBlock`)
- Test: `test/unit/rules-parser-grading.test.js` (new)

This is the build-time entry point. After this task, the Hugo frontmatter (and `<script id="tutorial-data">` JSON) carries `aiGrading: true` for opted-in questions.

- [ ] **Step 1: Author the failing parser test**

Create `test/unit/rules-parser-grading.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { parseRulesVr } from '../../scripts/parsers/rules.js';

describe('parseRulesVr — Grading directive + regex auto-route (#209)', () => {
  it('explicit ###Grading: ai-judged sets aiGrading: true', () => {
    const content = `[VALIDATE_3]
###Rule
exact-match
###Grading
ai-judged
###Question
What is the difference between cds.connect.to and cds.requires?
###Match
The first connects to a service at runtime; the second declares a dependency.
`;
    const map = parseRulesVr(content);
    const questions = map.get(3) ?? [];
    expect(questions).toHaveLength(1);
    expect(questions[0].aiGrading).toBe(true);
    expect(questions[0].type).toBe('text');
  });

  it('regex rule type auto-routes to AI grading even without ###Grading directive', () => {
    const content = `[VALIDATE_2]
###Rule
regex
###Question
What's the response message?
###Match
Received message ".*" in topic ".*"
`;
    const map = parseRulesVr(content);
    const questions = map.get(2) ?? [];
    expect(questions).toHaveLength(1);
    expect(questions[0].aiGrading).toBe(true);
  });

  it('regex-begins-with rule type auto-routes to AI grading', () => {
    const content = `[VALIDATE_4]
###Rule
regex-begins-with
###Question
What does the URL begin with?
###Match
https://api.example.com
`;
    const map = parseRulesVr(content);
    expect(map.get(4)?.[0].aiGrading).toBe(true);
  });

  it('absent ###Grading + non-regex rule type → aiGrading is undefined (omitted)', () => {
    const content = `[VALIDATE_1]
###Rule
exact-match
###Question
What's the answer?
###Match
fields
`;
    const map = parseRulesVr(content);
    const q = map.get(1)?.[0];
    expect(q).toBeDefined();
    expect(q?.aiGrading).toBeUndefined();
  });

  it('case-insensitivity: ###Grading: AI-JUDGED still sets aiGrading: true', () => {
    const content = `[VALIDATE_5]
###Rule
exact-match
###Grading
AI-JUDGED
###Question
Q?
###Match
A
`;
    const map = parseRulesVr(content);
    expect(map.get(5)?.[0].aiGrading).toBe(true);
  });

  it('multiple-choice rule type with ai-judged is still aiGrading: true', () => {
    // Edge case: an author marks a multiple-choice question as ai-judged.
    // The parser still emits aiGrading: true; whether the dispatch uses it
    // is a runtime concern (the AI grader is text-only by design, but the
    // parser doesn't gate on type — that's the dispatch's job).
    const content = `[VALIDATE_6]
###Rule
single-choice
###Grading
ai-judged
###Question
Q?
###Match
[x] A
[ ] B
`;
    const map = parseRulesVr(content);
    expect(map.get(6)?.[0].aiGrading).toBe(true);
    expect(map.get(6)?.[0].type).toBe('multiple-choice');
  });

  it('ANTI-LEAK: AI-graded question OMITS correctAnswer from public shape', () => {
    const content = `[VALIDATE_7]
###Rule
exact-match
###Grading
ai-judged
###Question
What is X?
###Match
The reference answer that must NOT ship to clients.
`;
    const map = parseRulesVr(content);
    const q = map.get(7)?.[0];
    expect(q).toBeDefined();
    expect(q?.aiGrading).toBe(true);
    expect(q?.correctAnswer).toBeUndefined();
    // Defense-in-depth: belt-and-braces grep for the literal string.
    expect(JSON.stringify(q)).not.toContain('reference answer that must NOT');
  });

  it('non-AI question STILL includes correctAnswer (backward compat)', () => {
    const content = `[VALIDATE_8]
###Rule
exact-match
###Question
What is Y?
###Match
The Y answer.
`;
    const map = parseRulesVr(content);
    const q = map.get(8)?.[0];
    expect(q?.aiGrading).toBeUndefined();
    expect(q?.correctAnswer).toBe('The Y answer.');
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run test/unit/rules-parser-grading.test.js`
Expected: fail — `aiGrading` property not on the returned questions.

- [ ] **Step 3: Update the type definition**

In `scripts/parsers/types.ts`, find the `ValidationQuestion` interface. Update:

```ts
export interface ValidationQuestion {
  id: string;
  question: string;
  type: 'multiple-choice' | 'text';
  options?: string[];
  // CHANGED: correctAnswer is now optional. Omitted for AI-graded
  // questions (issue #209) — the reference answer ships server-side
  // via ValidateAnswerSpecs and never enters the public Hugo
  // frontmatter or <script id="tutorial-data"> JSON.
  correctAnswer?: string;
  aiGrading?: boolean; // NEW — opted in via ###Grading: ai-judged OR via regex rule types (issue #209)
}
```

The `correctAnswer?: string` change ripples to two consumers:
- `hugo-apps/src/validation/grading.ts` (defined in PR #226). The `gradeAnswers` function reads `q.correctAnswer` — for non-AI questions it's still defined; for AI questions `gradeAnswers` should treat them as "skip" (Task 10 separates AI Qs from local Qs before calling `gradeAnswers` anyway, so this is naturally safe).
- `scripts/parsers/rules.ts` parseBlock (this same task) — already updated to omit it conditionally.

Verify by grepping `q.correctAnswer` and `correctAnswer:` across `scripts/parsers/`, `hugo/assets/js/`, `hugo-apps/src/`, and `srv/lib/` to confirm no consumer dereferences it without a guard. If a consumer does, update Task 10 to handle it.

- [ ] **Step 4: Extend `parseBlock` in `scripts/parsers/rules.ts`**

Read the existing `parseBlock` function (lines 39-74 of `rules.ts`). Add the `###Grading` directive parse + regex auto-route logic. The existing code emits one `ValidationQuestion` at the end — extend the returned object to include `aiGrading` when applicable.

```ts
function parseBlock(content: string, stepNum: number): ValidationQuestion[] {
  // ... existing question/match parsing ...

  // NEW: parse ###Grading directive (case-insensitive)
  const gradingMatch = content.match(/###Grading\s*\n([\s\S]*?)(?=###|$)/);
  const gradingValue = gradingMatch?.[1]?.trim().toLowerCase();
  const explicitlyAiGraded = gradingValue === 'ai-judged';

  // NEW: auto-route regex rule types to AI grading (issue #209).
  // These rule types have been silently treated as case-insensitive string
  // equality in tutorial.ts since the loader was written. Authors who chose
  // them for "match this pattern" semantics never got that. AI grading
  // gives them the spirit-of-the-answer evaluation they wanted.
  const REGEX_RULE_TYPES = new Set(['regex', 'regex-begins-with']);
  const autoAiGraded = REGEX_RULE_TYPES.has(ruleType);

  const aiGrading = explicitlyAiGraded || autoAiGraded;

  // Existing return: emit ValidationQuestion. Add aiGrading conditionally
  // so the JSON output stays clean (no aiGrading: undefined fields).
  //
  // ANTI-LEAK: when aiGrading is true, OMIT correctAnswer from the public
  // shape. The reference answer ships server-side via ValidateAnswerSpecs
  // (Task 3 sidecar + Task 8 publish endpoint). The Vue island handles a
  // missing correctAnswer for AI-graded questions as "server-only grading
  // required" — see Task 10's 503/disabled fallback for behavior.
  const publicQuestion: ValidationQuestion = {
    id: `validate-${stepNum}`,
    question,
    type,
    ...(options ? { options } : {}),
    ...(aiGrading ? { aiGrading: true } : {}),
    // correctAnswer omitted for AI-graded; included otherwise.
    ...(aiGrading ? {} : { correctAnswer: matchContent })
  };
  return [publicQuestion];
}
```

(Adapt to the existing function's exact shape — read `parseBlock` carefully before editing. The shape above is illustrative; preserve existing whitespace, options handling, and return-flow logic.)

- [ ] **Step 5: Run test, verify pass**

Run: `npx vitest run test/unit/rules-parser-grading.test.js`
Expected: 8 passing (6 directive/auto-route cases + 2 anti-leak cases).

Also run the existing parser tests to make sure no regression: `npx vitest run test/unit/rules-parser.test.js` (if it exists; otherwise grep for parser tests).

- [ ] **Step 6: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/209-free-text-grader" ] && \
  git add scripts/parsers/rules.ts scripts/parsers/types.ts test/unit/rules-parser-grading.test.js && \
  git commit -m "feat(codecheck): rules.vr parser extension for ###Grading directive (#209)

- ValidationQuestion gains aiGrading?: boolean; correctAnswer
  becomes optional.
- Explicit ###Grading: ai-judged → aiGrading: true.
- Implicit auto-route: regex / regex-begins-with rule types
  → aiGrading: true (fixes pre-existing silent bug where these
  rule types were treated as plain string equality).
- Case-insensitive directive value.
- Multiple-choice + ai-judged is allowed at parse time; dispatch
  enforces text-only at runtime.
- ANTI-LEAK: correctAnswer is OMITTED from the public emit when
  aiGrading=true. Reference answer ships server-side via
  ValidateAnswerSpecs (Task 3 sidecar) and never enters the public
  Hugo frontmatter or <script id='tutorial-data'> JSON."
```

---

### Task 3: Build pipeline wire-up — write `<slug>.validate-answer.json` sidecar

**Files:**
- Modify: `scripts/fetch-tutorials.ts` (write sidecar for steps with AI-graded questions)
- Test: `test/unit/validate-answer-fetch-attach.test.js` (new — pure-function test of the sidecar collector)

This task does NOT touch the publish pipeline yet (that's Task 7). Here we just (a) collect AI-graded questions during fetch, (b) write the sidecar to `.tutorial-cache/<slug>.validate-answer.json`.

The sidecar shape is: `{ slug: string, specs: Array<{ stepNumber, questionId, questionText, correctAnswer, ruleType, aiGrading }> }`. Mirrors `<slug>.codecheck.json` from PR #205.

- [ ] **Step 1: Add a small helper function to scripts/parsers/rules.ts**

Append to `scripts/parsers/rules.ts`:

```ts
/**
 * Collect AI-graded questions across all steps for a tutorial.
 * Returns the spec entries that should be persisted server-side via
 * the publish pipeline (issue #209). Mirrors attachCodeCheckSpecs from
 * PR #205.
 */
export function collectAiGradedSpecs(
  validationByStep: Map<number, ValidationQuestion[]>,
  ruleTypeByStepAndId: Map<string, string>,
  correctAnswerByStepAndId: Map<string, string>
): Array<{ stepNumber: number; questionId: string; questionText: string; correctAnswer: string; ruleType: string | undefined; aiGrading: boolean }> {
  const specs: Array<{ stepNumber: number; questionId: string; questionText: string; correctAnswer: string; ruleType: string | undefined; aiGrading: boolean }> = [];
  for (const [stepNumber, questions] of validationByStep) {
    for (const q of questions) {
      if (!q.aiGrading) continue;
      const key = `${stepNumber}:${q.id}`;
      const correctAnswer = correctAnswerByStepAndId.get(key);
      if (correctAnswer === undefined) {
        // Should never happen: parseBlock populates this map for every
        // question it emits, AI-graded or not. Defensive log + skip.
        continue;
      }
      specs.push({
        stepNumber,
        questionId: q.id,
        questionText: q.question,
        correctAnswer,                    // <-- from sibling map, NOT q.correctAnswer
        ruleType: ruleTypeByStepAndId.get(key),
        aiGrading: true
      });
    }
  }
  return specs;
}
```

**Why two sibling maps instead of `q.correctAnswer`:** Task 2 strips `correctAnswer` from the public `ValidationQuestion` shape when `aiGrading: true` (anti-leak). The collector therefore CANNOT read it from `q` for AI-graded questions — the field will be `undefined`. The `correctAnswerByStepAndId` map carries the reference answer privately within the parser/build pipeline; it never enters the public Hugo frontmatter or `<script id="tutorial-data">` JSON.

Update `parseBlock` (or the wrapper API per the alternative below) to populate BOTH maps as it processes each block. Both maps use the same key format: `${stepNumber}:${questionId}`.

- [ ] **Step 2: Author the failing test**

Create `test/unit/validate-answer-fetch-attach.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { collectAiGradedSpecs } from '../../scripts/parsers/rules.js';

describe('collectAiGradedSpecs (#209)', () => {
  it('returns one spec per AI-graded question across multiple steps', () => {
    // Note: q.correctAnswer is OMITTED for AI-graded questions in the
    // public ValidationQuestion shape (anti-leak); the collector reads
    // the reference answer from the sibling correctAnswerByStepAndId map.
    const validation = new Map([
      [2, [
        { id: 'validate-2', question: 'Q2', type: 'text', aiGrading: true }
      ]],
      [4, [
        { id: 'validate-4', question: 'Q4', type: 'text', aiGrading: true }
      ]]
    ]);
    const ruleTypes = new Map([
      ['2:validate-2', 'regex'],
      ['4:validate-4', 'exact-match']
    ]);
    const correctAnswers = new Map([
      ['2:validate-2', 'A2'],
      ['4:validate-4', 'A4']
    ]);

    const specs = collectAiGradedSpecs(validation, ruleTypes, correctAnswers);

    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({
      stepNumber: 2,
      questionId: 'validate-2',
      questionText: 'Q2',
      correctAnswer: 'A2',
      ruleType: 'regex',
      aiGrading: true
    });
    expect(specs[1]).toMatchObject({
      stepNumber: 4,
      questionId: 'validate-4',
      ruleType: 'exact-match'
    });
  });

  it('skips non-AI-graded questions', () => {
    const validation = new Map([
      [1, [
        // Non-AI: correctAnswer remains in the public shape
        { id: 'validate-1', question: 'Q', type: 'text', correctAnswer: 'A' },
        // AI: correctAnswer stripped from public shape; lives in sibling map
        { id: 'validate-1b', question: 'Qb', type: 'text', aiGrading: true }
      ]]
    ]);
    const ruleTypes = new Map([['1:validate-1b', 'exact-match']]);
    const correctAnswers = new Map([['1:validate-1b', 'Ab']]);

    const specs = collectAiGradedSpecs(validation, ruleTypes, correctAnswers);
    expect(specs).toHaveLength(1);
    expect(specs[0].questionId).toBe('validate-1b');
    expect(specs[0].correctAnswer).toBe('Ab');
  });

  it('skips AI-graded question when correctAnswer map missing entry (defensive)', () => {
    const validation = new Map([
      [1, [{ id: 'validate-1', question: 'Q', type: 'text', aiGrading: true }]]
    ]);
    const ruleTypes = new Map();
    const correctAnswers = new Map();  // empty — should not crash

    const specs = collectAiGradedSpecs(validation, ruleTypes, correctAnswers);
    expect(specs).toHaveLength(0);
  });

  it('returns empty array when no AI-graded questions exist', () => {
    const validation = new Map([
      [1, [{ id: 'validate-1', question: 'Q', type: 'text', correctAnswer: 'A' }]]
    ]);
    expect(collectAiGradedSpecs(validation, new Map(), new Map())).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test, expect failure**

Run: `npx vitest run test/unit/validate-answer-fetch-attach.test.js`
Expected: fail — `collectAiGradedSpecs` not exported.

- [ ] **Step 4: Implement, run tests, verify pass**

Implement `collectAiGradedSpecs` per Step 1. Run again, expect 4 passing.

If you went with the "alternative" approach (separate `parseRulesVrEnriched`), thread BOTH sibling maps (`ruleTypeByStepAndId` and `correctAnswerByStepAndId`) through `parseBlock` — read the existing function carefully, decide where to capture the `ruleType` string before normalisation + the `matchContent` string, and emit them via the maps.

- [ ] **Step 5: Wire into `scripts/fetch-tutorials.ts`**

Find the existing `validation` block in `fetch-tutorials.ts` (around line 654, where `parseRulesVr` is called). The CodeCheck block from PR #205 is right there too — model the new code on it.

After `parseRulesVr` returns, IF any step has at least one `aiGrading: true` question, write the sidecar file:

```ts
// Inside the existing rules-parsing block, after parseRulesVr completes:
const aiGradedSpecs = collectAiGradedSpecs(validationByStep, ruleTypeByStepAndId);
if (aiGradedSpecs.length > 0) {
  writeFileSync(
    join(CACHE_DIR, `${t.slug.toLowerCase()}.validate-answer.json`),
    JSON.stringify({ slug: t.slug.toLowerCase(), specs: aiGradedSpecs }, null, 2)
  );
}
```

Use `t.slug.toLowerCase()` (per the [Tutorial slugs are lowercase canonical](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/) gotcha + #211's reaffirmation). The sidecar filename also lowercases for consistency with `<slug>.codecheck.json`.

- [ ] **Step 6: Smoke run**

Run a one-off Node script to verify the sidecar collector against synthetic data:

```bash
node --import tsx -e "
import('./scripts/parsers/rules.js').then(async ({ parseRulesVr, collectAiGradedSpecs }) => {
  const sample = '[VALIDATE_3]\n###Rule\nregex\n###Question\nQ?\n###Match\nfoo.*bar\n';
  const map = parseRulesVr(sample);
  const specs = collectAiGradedSpecs(map, new Map([['3:validate-3','regex']]));
  console.log(JSON.stringify(specs, null, 2));
});
"
```

Expected: prints one spec with `aiGrading: true`, `ruleType: 'regex'`, `questionText: 'Q?'`, `correctAnswer: 'foo.*bar'`.

- [ ] **Step 7: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/209-free-text-grader" ] && \
  git add scripts/parsers/rules.ts scripts/fetch-tutorials.ts test/unit/validate-answer-fetch-attach.test.js && \
  git commit -m "feat(codecheck): collect AI-graded specs in build pipeline (#209)

- collectAiGradedSpecs() extracts AI-graded questions across all
  steps for a tutorial. Returns one spec per AI-graded question
  with stepNumber, questionId, questionText, correctAnswer,
  ruleType, aiGrading.
- fetch-tutorials writes .tutorial-cache/<slug>.validate-answer.json
  sidecar when any step has AI-graded questions. Mirrors the
  <slug>.codecheck.json sidecar from PR #205.
- Slug lowercased at sidecar write time (per CLAUDE.md slug
  canonical convention)."
```

---

### Task 4: Prompt builder + JSON schema (pure module)

**Files:**
- Create: `srv/lib/validate-answer-prompt.js`
- Test: `test/unit/validate-answer-prompt.test.js` (new)

Pure module — no network, no DB. The dispatch function (next task) consumes it.

- [ ] **Step 1: Write the failing test**

Create `test/unit/validate-answer-prompt.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  PROMPT_VERSION,
  buildSystemPrompt,
  buildUserMessage,
  VALIDATE_ANSWER_OUTPUT_SCHEMA,
  redactReferenceLeaks
} from '../../srv/lib/validate-answer-prompt.js';

describe('validate-answer prompt builder', () => {
  it('PROMPT_VERSION is a non-empty string', () => {
    expect(typeof PROMPT_VERSION).toBe('string');
    expect(PROMPT_VERSION.length).toBeGreaterThan(0);
  });

  it('system prompt mentions verdict scale + DO-NOT-QUOTE rule', () => {
    const sys = buildSystemPrompt();
    expect(sys).toMatch(/\bpass\b/i);
    expect(sys).toMatch(/\bpartial\b/i);
    expect(sys).toMatch(/\bfail\b/i);
    expect(sys).toMatch(/NEVER reveal/i);
    expect(sys).toMatch(/JSON/i);
  });

  it('user message orders sections deterministically', () => {
    const msg = buildUserMessage({
      question: 'What is 2+2?',
      correctAnswer: '4',
      submittedAnswer: 'four'
    });
    const idx = (s) => msg.indexOf(s);
    expect(idx('Question:')).toBeGreaterThanOrEqual(0);
    expect(idx('Question:')).toBeLessThan(idx("Author's expected answer"));
    expect(idx("Author's expected answer")).toBeLessThan(idx("Learner's answer"));
  });

  it('output schema has correct shape', () => {
    expect(VALIDATE_ANSWER_OUTPUT_SCHEMA.required).toContain('verdict');
    expect(VALIDATE_ANSWER_OUTPUT_SCHEMA.required).toContain('summary');
    expect(VALIDATE_ANSWER_OUTPUT_SCHEMA.properties.verdict.enum).toEqual(['pass','partial','fail']);
    expect(VALIDATE_ANSWER_OUTPUT_SCHEMA.additionalProperties).toBe(false);
    expect(VALIDATE_ANSWER_OUTPUT_SCHEMA.properties.summary.maxLength).toBe(300);
    expect(VALIDATE_ANSWER_OUTPUT_SCHEMA.properties.hint.maxLength).toBe(250);
  });

  it('redactReferenceLeaks: 30+ char overlap with correctAnswer is redacted', () => {
    const correctAnswer = 'The handler should add a before-READ event on Books, filtering by stock';
    const verdict = {
      verdict: 'pass',
      summary: 'Yes, the handler should add a before-READ event on Books — exactly right.',
      hint: ''
    };
    const safe = redactReferenceLeaks(verdict, correctAnswer);
    expect(safe.summary).toBe('[redacted]');
  });

  it('redactReferenceLeaks: short overlap is preserved', () => {
    const correctAnswer = 'The exact answer';
    const verdict = { verdict: 'pass', summary: 'Yes, that is correct.', hint: '' };
    const safe = redactReferenceLeaks(verdict, correctAnswer);
    expect(safe.summary).toBe('Yes, that is correct.');
  });

  it('redactReferenceLeaks: no-op when correctAnswer is empty/null', () => {
    const verdict = { verdict: 'pass', summary: 'OK', hint: '' };
    expect(redactReferenceLeaks(verdict, '')).toEqual(verdict);
    expect(redactReferenceLeaks(verdict, null)).toEqual(verdict);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run test/unit/validate-answer-prompt.test.js`
Expected: module not found.

- [ ] **Step 3: Implement the module**

Create `srv/lib/validate-answer-prompt.js`. Re-use `redactReferenceLeaks` from `srv/lib/code-check-prompt.js` (it's the same algorithm — just imported).

```js
// srv/lib/validate-answer-prompt.js
//
// Pure module — no network, no DB.
// Mirrors srv/lib/code-check-prompt.js's shape with a smaller schema
// suited to free-text answer grading (no correctAspects/suggestions
// arrays — just verdict + summary + optional hint).
//
// PROMPT_VERSION is bumped on any prompt-semantics change so telemetry
// in ValidateAnswerSubmissions.promptVersion can be analyzed by vintage.

export { redactReferenceLeaks } from './code-check-prompt.js';

export const PROMPT_VERSION = 'v1';

export function buildSystemPrompt() {
  return `You are a patient tutorial grader evaluating a learner's answer to a free-text
question in a software development tutorial. You receive the question, the
author's expected answer, and the learner's answer. Grade based on whether
the learner has demonstrated understanding of the concept the question targets
— not whether their answer is verbatim equal to the author's expected answer.

Verdict scale:
- "pass": the learner's answer is essentially correct. Synonyms, paraphrases,
  alternate but valid terminology, and minor wording differences are FINE if
  they convey the same idea.
- "partial": the learner has the right concept but is missing key detail
  the author explicitly required, OR the answer is correct in spirit but
  uses imprecise terminology that should be tightened.
- "fail": the answer addresses a different concept, is wrong, or is empty.

When uncertain between pass and partial, prefer partial.
When uncertain between partial and fail, prefer fail (so the learner doesn't
get false credit for an actually-wrong answer).

Output JSON: { verdict, summary, hint? }
- summary: ONE sentence stating the grade in plain language.
- hint: ONE sentence of guidance toward the correct answer. Populate ONLY
  for partial. Empty/omitted on pass and fail.

NEVER reveal the author's expected answer literally. Speak about concepts.
NEVER fabricate or invent additional context the question didn't include.`;
}

/**
 * Deterministic, ordered user message. Sections always in this order:
 *   Question → Author's expected answer → Learner's answer.
 * No "step text" or "tutorial samples" sections — text-question grading
 * doesn't benefit from broader tutorial context (this diverges from
 * code-check, which DOES include those because code grading benefits
 * more from "what was the learner being taught when they wrote this code").
 */
export function buildUserMessage({ question, correctAnswer, submittedAnswer }) {
  return [
    `Question:\n${question}`,
    `Author's expected answer (DO NOT QUOTE — for your judgment only):\n${correctAnswer}`,
    `Learner's answer:\n${submittedAnswer}`
  ].join('\n\n');
}

/**
 * Forced-tool-call output schema. Used by srv/lib/code-check-llm.js
 * (which is reused as-is for #209 — same SDK escape hatch via
 * tool_choice + tool.parameters).
 *
 * Smaller than CHECK_CODE_OUTPUT_SCHEMA because the input is smaller
 * and the output is naturally simpler. Length caps prevent the LLM
 * from running away with a long-winded explanation.
 */
export const VALIDATE_ANSWER_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'partial', 'fail'] },
    summary: { type: 'string', maxLength: 300 },
    hint:    { type: 'string', maxLength: 250 }
  }
};
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/unit/validate-answer-prompt.test.js`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/209-free-text-grader" ] && \
  git add srv/lib/validate-answer-prompt.js test/unit/validate-answer-prompt.test.js && \
  git commit -m "feat(codecheck): prompt builder + JSON schema for free-text grader (#209)

Pure module: system prompt, deterministic user-message ordering,
JSON-schema constants for the forced tool-call output, and re-export
of redactReferenceLeaks from code-check-prompt.js (same algorithm).

Smaller schema than code-check (no correctAspects/suggestions arrays)
because text answers warrant less structure than code submissions."
```

---

### Task 5: `dispatchValidateAnswer` core (mock LLM, real DB)

**Files:**
- Create: `srv/lib/validate-answer-tool.js`
- Test: `test/unit/validate-answer-tool.test.js` (new)

This is the spike's center of gravity. A single function:
- Takes `{ tutorialSlug, stepNumber, questionId, submittedAnswer }`.
- Loads the spec from HANA via `loadQuestion` callback (mockable in unit tests).
- Calls the LLM via `callModel` callback (real impl in Task 7).
- Applies leak redaction.
- Persists `ValidateAnswerSubmissions`.
- Returns the verdict object.

LLM and question-loader are injected so all unit tests run without network or HANA.

- [ ] **Step 1: Write the failing test**

Create `test/unit/validate-answer-tool.test.js`. Cover, in this order:

1. **Happy path:** mock spec returned from loadQuestion, mock callModel returns `{verdict: {verdict:'pass', summary:'OK'}, promptTokens: 100, completionTokens: 50, modelName: 'gpt-4o'}`. `dispatchValidateAnswer` returns the verdict and inserts a `ValidateAnswerSubmissions` row with verdict + token telemetry + promptVersion.
2. **Question missing:** loadQuestion returns null → returns `{verdict:'error', errorReason:'question_missing'}`, persists row.
3. **Not AI-graded:** loadQuestion returns a spec with `aiGrading: false` → returns `{verdict:'error', errorReason:'not_ai_graded'}`, persists row.
4. **Upstream LLM error:** callModel throws → returns `{verdict:'error', errorReason:'upstream'}`, persists row.
5. **Schema mismatch:** callModel resolves with malformed object (missing `summary` or wrong-type) → returns `{verdict:'error', errorReason:'schema'}`, persists row (still record token telemetry — those tokens were spent).
6. **Reference leak redaction:** mock spec has a long `correctAnswer`; mock LLM returns a verdict whose summary contains a 30+ char overlap → persisted summary is `'[redacted]'`, leak warning logged.
7. **`validateAnswerEnabled = false`:** ChatSettings says flag is off → dispatch short-circuits, returns `{verdict:'error', errorReason:'disabled'}`, no LLM call attempted.
8. **Anonymous user → `user_ID: null`:** dispatch with `user.id === 'anonymous'` or `user: null` produces a row with null user FK.

Test setup: deploy `db/schema.cds` to in-memory SQLite via `cds.deploy(...).to('sqlite::memory:')` in `beforeAll`. In `beforeEach`, DELETE from `ValidateAnswerSubmissions`, `ValidateAnswerSpecs`, `ChatSettings`, `Tutorials`, then INSERT the per-test fixtures (`ChatSettings` with `validateAnswerEnabled: true` for tests 1-6+8, with `false` for test 7).

Test sketch (the happy path):
```js
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { dispatchValidateAnswer } from '../../srv/lib/validate-answer-tool.js';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

beforeEach(async () => {
  const { ValidateAnswerSubmissions, ValidateAnswerSpecs, ChatSettings, Tutorials } =
    cds.entities('com.sap.developers.ims');
  await DELETE.from(ValidateAnswerSubmissions);
  await DELETE.from(ValidateAnswerSpecs);
  await DELETE.from(ChatSettings);
  await DELETE.from(Tutorials);
  await INSERT.into(ChatSettings).entries({
    ID: '00000000-0000-0000-0000-000000000001',
    enabled: true, validateAnswerEnabled: true
  });
  await INSERT.into(Tutorials).entries({
    ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    slug: 'sample', title: 'Sample', status: 'ACTIVE'
  });
});

it('happy path persists verdict + tokens + promptVersion', async () => {
  const callModel = vi.fn().mockResolvedValue({
    verdict: { verdict: 'pass', summary: 'OK', hint: '' },
    promptTokens: 100, completionTokens: 50, modelName: 'gpt-4o'
  });
  const loadQuestion = vi.fn().mockResolvedValue({
    questionId: 'validate-2',
    question: 'What is 2+2?',
    correctAnswer: '4',
    aiGrading: true
  });

  const out = await dispatchValidateAnswer(
    { tutorialSlug: 'sample', stepNumber: 2, questionId: 'validate-2', submittedAnswer: 'four' },
    { user: { id: 'u1' }, callModel, loadQuestion }
  );

  expect(out.verdict).toBe('pass');
  const { ValidateAnswerSubmissions } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(ValidateAnswerSubmissions);
  expect(rows).toHaveLength(1);
  expect(rows[0].verdict).toBe('pass');
  expect(rows[0].promptTokens).toBe(100);
  expect(rows[0].modelName).toBe('gpt-4o');
  expect(rows[0].promptVersion).toBe('v1');
});
```

(Author the remaining 7 cases following the same shape.)

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run test/unit/validate-answer-tool.test.js`
Expected: module not found.

- [ ] **Step 3: Implement `dispatchValidateAnswer`**

Create `srv/lib/validate-answer-tool.js`:

```js
import cds from '@sap/cds';
import {
  PROMPT_VERSION,
  buildSystemPrompt,
  buildUserMessage,
  VALIDATE_ANSWER_OUTPUT_SCHEMA,
  redactReferenceLeaks
} from './validate-answer-prompt.js';

const LOG = cds.log('validate-answer');

/**
 * @param {object} input  { tutorialSlug, stepNumber, questionId, submittedAnswer }
 * @param {object} deps   { user?, callModel, loadQuestion }
 *   - user: { id, ... } or null/undefined; user.id === 'anonymous' → user_ID: null
 *   - callModel({ system, user, schema }) → { verdict, promptTokens, completionTokens, modelName }
 *   - loadQuestion(slug, stepNumber, questionId) → { questionId, question, correctAnswer, aiGrading } | null
 * @returns { verdict, summary?, hint?, errorReason? }
 */
export async function dispatchValidateAnswer(input, deps) {
  const startedAt = Date.now();
  const slug = (input.tutorialSlug ?? '').toLowerCase();
  const { ValidateAnswerSubmissions, ChatSettings } = cds.entities('com.sap.developers.ims');

  // 1. Flag check
  const settings = await SELECT.one.from(ChatSettings);
  if (!settings?.validateAnswerEnabled) {
    return persistError({ ...input, slug }, 'disabled', startedAt, deps);
  }

  // 2. Load question via injected callback
  const question = await safeCall(deps.loadQuestion, slug, input.stepNumber, input.questionId);
  if (!question) {
    return persistError({ ...input, slug }, 'question_missing', startedAt, deps);
  }
  if (!question.aiGrading) {
    return persistError({ ...input, slug, question }, 'not_ai_graded', startedAt, deps);
  }

  // 3. Build prompt
  const system = buildSystemPrompt();
  const userMsg = buildUserMessage({
    question: question.question,
    correctAnswer: question.correctAnswer,
    submittedAnswer: input.submittedAnswer
  });

  // 4. Call LLM
  let modelResp;
  try {
    modelResp = await deps.callModel({ system, user: userMsg, schema: VALIDATE_ANSWER_OUTPUT_SCHEMA });
  } catch (err) {
    LOG.warn('validate-answer upstream failure', err.message);
    return persistError({ ...input, slug, question }, 'upstream', startedAt, deps);
  }

  // 5. Validate verdict shape.
  // modelResp.verdict is the parsed object from the forced-tool-call response.
  // Its inner `.verdict` field is the enum string. Renaming the local for
  // clarity to avoid the double-`.verdict` confusion.
  const parsed = modelResp.verdict;
  if (!parsed || !['pass', 'partial', 'fail'].includes(parsed.verdict)
      || typeof parsed.summary !== 'string') {
    return persistError({ ...input, slug, question }, 'schema', startedAt, deps, modelResp);
  }

  // 6. Reference-leak redaction
  const safe = redactReferenceLeaks(parsed, question.correctAnswer);
  if (safe !== parsed) {
    LOG.warn('validate-answer reference leak redacted', {
      slug, stepNumber: input.stepNumber, questionId: input.questionId
    });
  }

  // 7. Persist
  await INSERT.into(ValidateAnswerSubmissions).entries({
    ID: cds.utils.uuid(),
    user_ID: deps.user?.id && deps.user.id !== 'anonymous' ? deps.user.id : null,
    tutorialSlug: slug,
    stepNumber: input.stepNumber,
    questionId: input.questionId,
    questionText: question.question,
    correctAnswer: question.correctAnswer,
    submittedAnswer: input.submittedAnswer,
    verdict: safe.verdict,
    summary: safe.summary,
    hint: safe.hint || null,
    modelName: modelResp.modelName,
    promptVersion: PROMPT_VERSION,
    promptTokens: modelResp.promptTokens,
    completionTokens: modelResp.completionTokens,
    latencyMs: Date.now() - startedAt
  });

  return safe;
}

async function persistError(ctx, errorReason, startedAt, deps, modelResp) {
  const { ValidateAnswerSubmissions } = cds.entities('com.sap.developers.ims');
  await INSERT.into(ValidateAnswerSubmissions).entries({
    ID: cds.utils.uuid(),
    user_ID: deps?.user?.id && deps.user.id !== 'anonymous' ? deps.user.id : null,
    tutorialSlug: ctx.slug,
    stepNumber: ctx.stepNumber,
    questionId: ctx.questionId,
    questionText: ctx.question?.question ?? null,
    correctAnswer: ctx.question?.correctAnswer ?? null,
    submittedAnswer: ctx.submittedAnswer,
    verdict: 'error',
    errorReason,
    modelName: modelResp?.modelName ?? null,
    promptVersion: PROMPT_VERSION,
    promptTokens: modelResp?.promptTokens ?? null,
    completionTokens: modelResp?.completionTokens ?? null,
    latencyMs: Date.now() - startedAt
  });
  return { verdict: 'error', errorReason };
}

async function safeCall(fn, ...args) {
  if (!fn) return null;
  try { return await fn(...args); } catch { return null; }
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/unit/validate-answer-tool.test.js`
Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/209-free-text-grader" ] && \
  git add srv/lib/validate-answer-tool.js test/unit/validate-answer-tool.test.js && \
  git commit -m "feat(codecheck): dispatchValidateAnswer core with injected LLM + DB (#209)

Single dispatch path consumed by the /api/validate-answer endpoint.
Persists ValidateAnswerSubmissions on every outcome with full token
+ latency telemetry. Honors validateAnswerEnabled flag. Applies leak
redaction post-LLM. LLM and question-loader are injected for
testability — no network in unit tests.

Mirrors srv/lib/code-check-tool.js's dispatchCheckCode shape from
PR #205, with smaller payload (no step-text or tutorial-samples
sections — text-question grading doesn't need broader context)."
```

---

### Task 6: `/api/validate-answer` Express endpoint + rate limits

**Files:**
- Create: `srv/lib/validate-answer-handler.js`
- Modify: `srv/server.js` (wire route alongside `/api/codecheck`)
- Test: `test/unit/validate-answer-handler.test.js` (new)

The handler is a thin shell: validates body, applies two rate limits (per-user 30/hour, per-(user,slug,step) 5/5min), looks up the user via `contextMw + authMw` (already declared in `srv/server.js`), calls `dispatchValidateAnswer`, responds JSON.

Rate-limit shape mirrors `srv/lib/code-check-handler.js` exactly per the spec — same windows, same in-memory `Map<key, number[]>` mechanism, same `_resetRateLimitForTest()` test export.

- [ ] **Step 1: Write the failing test**

Create `test/unit/validate-answer-handler.test.js`. Mirror the structure of `test/unit/code-check-handler.test.js` (PR #205 Task 1.6).

Cover:

1. **Body validation:** missing `tutorialSlug` → 400 `{error:'invalid_body'}`. Missing `submittedAnswer` → 400. Missing `stepNumber` → 400. Missing `questionId` → 400. `submittedAnswer.length > 5000` (5 KB cap) → 400 `{error:'too_long'}`.
2. **Anonymous user → 401.**
3. **Happy path** with mock dispatch returning a `pass` verdict → 200 + JSON body matches verdict shape.
4. **`partial` verdict** → 200 + body has `hint` field.
5. **Per-user rate limit** — 30 successful → 31st returns 429 + `Retry-After` header.
6. **Per-(user, slug, step) rate limit** — 5 in 5 min → 6th returns 429.
7. **Failed dispatch (`errorReason='upstream'`) doesn't count toward rate cap.**
8. **Disabled flag → 503:** dispatch returns `errorReason: 'disabled'` → handler returns 503 (NOT 200 with the error verdict).

(Total ~13 cases including sub-cases of body validation.)

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run test/unit/validate-answer-handler.test.js`
Expected: module not found.

- [ ] **Step 3: Implement the handler**

Create `srv/lib/validate-answer-handler.js`. Mirror `srv/lib/code-check-handler.js` exactly except:
- Function name: `makeValidateAnswerHandler(deps)`.
- Body field validation: `tutorialSlug` + `stepNumber` + `questionId` + `submittedAnswer`.
- `MAX_ANSWER_BYTES = 5_000` (5 KB, smaller than code-check's 20 KB).
- Calls `dispatchValidateAnswer` with deps `{ user: req.user, callModel, loadQuestion }`.
- Per-user limit + per-(user,slug,step) limit copy from code-check (same 30/hour + 5/5min).
- `_resetRateLimitForTest()` exported for test isolation.

Skeleton (read `code-check-handler.js` end-to-end first; mirror its shape):

```js
import { dispatchValidateAnswer } from './validate-answer-tool.js';

const PER_USER_LIMIT  = { count: 30, windowMs: 60 * 60 * 1000 };  // 30/hour
const PER_STEP_LIMIT  = { count: 5,  windowMs: 5  * 60 * 1000 };  // 5/5min
const MAX_ANSWER_BYTES = 5_000;

const userCalls = new Map();
const stepCalls = new Map();

export function _resetRateLimitForTest() {
  userCalls.clear(); stepCalls.clear();
}

export function makeValidateAnswerHandler(deps = {}) {
  const callModel = deps.callModel;
  const loadQuestion = deps.loadQuestion;
  if (typeof callModel !== 'function') {
    throw new Error('makeValidateAnswerHandler requires deps.callModel to be a function');
  }
  if (typeof loadQuestion !== 'function') {
    throw new Error('makeValidateAnswerHandler requires deps.loadQuestion to be a function');
  }

  return async function validateAnswerHandler(req, res) {
    if (!req.user || req.user.id === 'anonymous') {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    const { tutorialSlug, stepNumber, questionId, submittedAnswer } = req.body || {};
    if (typeof tutorialSlug !== 'string' || !tutorialSlug
        || typeof stepNumber !== 'number'
        || typeof questionId !== 'string' || !questionId
        || typeof submittedAnswer !== 'string' || !submittedAnswer) {
      return res.status(400).json({ error: 'invalid_body' });
    }
    if (Buffer.byteLength(submittedAnswer, 'utf8') > MAX_ANSWER_BYTES) {
      return res.status(400).json({ error: 'too_long' });
    }

    const now = Date.now();
    const uid = req.user.id;
    const stepKey = `${uid}|${tutorialSlug.toLowerCase()}|${stepNumber}`;
    if (overLimit(userCalls, uid, now, PER_USER_LIMIT)) {
      return rateLimitResponse(res, userCalls.get(uid), now, PER_USER_LIMIT);
    }
    if (overLimit(stepCalls, stepKey, now, PER_STEP_LIMIT)) {
      return rateLimitResponse(res, stepCalls.get(stepKey), now, PER_STEP_LIMIT);
    }

    let verdict;
    try {
      verdict = await dispatchValidateAnswer(
        { tutorialSlug, stepNumber, questionId, submittedAnswer },
        { user: req.user, callModel, loadQuestion }
      );
    } catch (err) {
      return res.status(500).json({ error: 'internal' });
    }

    if (verdict.errorReason === 'disabled') {
      return res.status(503).json({ error: 'disabled' });
    }

    // Successful outcomes (pass/partial/fail) count toward limits.
    // 'error' outcomes do NOT — the user shouldn't be punished for our flake.
    if (verdict.verdict !== 'error') {
      record(userCalls, uid, now, PER_USER_LIMIT.windowMs);
      record(stepCalls, stepKey, now, PER_STEP_LIMIT.windowMs);
    }

    return res.status(200).json(verdict);
  };
}

// rate-limit helpers identical to code-check-handler.js
function record(map, key, now, windowMs) {
  const arr = map.get(key) || [];
  arr.push(now);
  while (arr.length > 1 && now - arr[0] > windowMs) arr.shift();
  map.set(key, arr);
}

function overLimit(map, key, now, limit) {
  const arr = map.get(key) || [];
  while (arr.length && now - arr[0] > limit.windowMs) arr.shift();
  map.set(key, arr);
  return arr.length >= limit.count;
}

function rateLimitResponse(res, hits, now, limit) {
  const oldest = hits[0] ?? now;
  const retryAfterSec = Math.ceil((limit.windowMs - (now - oldest)) / 1000);
  const safe = Math.max(1, retryAfterSec);
  res.setHeader('Retry-After', String(safe));
  return res.status(429).json({ error: 'rate_limited', retryAfter: safe });
}
```

- [ ] **Step 4: Wire into `srv/server.js`**

Find the existing `/api/codecheck` route registration (introduced by PR #205). Add the new route alongside it:

```js
import { makeValidateAnswerHandler } from './lib/validate-answer-handler.js';
import { defaultLoadQuestion } from './lib/validate-answer-question-loader.js';
// (defaultCallModel from code-check-llm.js is already imported)

// ... inside the cds.on('served', ...) block, near makeCodeCheckHandler:
const validateAnswerHandler = makeValidateAnswerHandler({
  callModel: defaultCallModel,
  loadQuestion: defaultLoadQuestion
});
app.post('/api/validate-answer',
  express.json({ limit: '64kb' }),
  contextMw, authMw,
  validateAnswerHandler
);
```

`defaultLoadQuestion` is created in Task 7 (next task). For this task, the route registration code is added but the build won't actually start the server successfully until Task 7 ships the loader. That's fine — this task ships the handler factory + endpoint registration; the server-startable state is reached at the end of Task 7.

- [ ] **Step 5: Run test, verify pass**

Run: `npx vitest run test/unit/validate-answer-handler.test.js`
Expected: 13 passing.

- [ ] **Step 6: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/209-free-text-grader" ] && \
  git add srv/lib/validate-answer-handler.js srv/server.js test/unit/validate-answer-handler.test.js && \
  git commit -m "feat(codecheck): /api/validate-answer endpoint with rate limits (#209)

- Per-user: 30 successful checks / hour.
- Per-(user,slug,step): 5 / 5 min.
- 401 for anonymous, 400 for invalid body or > 5 KB answer,
  429 with Retry-After on rate cap, 503 when validateAnswerEnabled=false.
- Failed dispatches (errorReason='upstream') do NOT count toward
  the rate cap so transient flake doesn't punish learners.
- Mirrors srv/lib/code-check-handler.js's shape exactly with smaller
  body cap (5KB vs 20KB) since text answers are smaller than code."
```

---

### Task 7: `defaultCallModel` is reused; ship `defaultLoadQuestion`

**Files:**
- Create: `srv/lib/validate-answer-question-loader.js`
- Test: `test/unit/validate-answer-question-loader.test.js` (new)

`defaultCallModel` from `srv/lib/code-check-llm.js` is reused **as-is** — no new file. The forced-tool-call SDK pattern is identical; only the schema differs (handled by passing different `schema` param in dispatch).

The new module is the question loader: `defaultLoadQuestion(slug, stepNumber, questionId)` reads from `ValidateAnswerSpecs` entity.

- [ ] **Step 1: Write the failing test**

Create `test/unit/validate-answer-question-loader.test.js`:

```js
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { defaultLoadQuestion } from '../../srv/lib/validate-answer-question-loader.js';

describe('defaultLoadQuestion', () => {
  beforeAll(async () => {
    await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
  });

  beforeEach(async () => {
    const { ValidateAnswerSpecs, Tutorials } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ValidateAnswerSpecs);
    await DELETE.from(Tutorials);
    await INSERT.into(Tutorials).entries({
      ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      slug: 'sample',
      title: 'Sample',
      status: 'ACTIVE'
    });
    await INSERT.into(ValidateAnswerSpecs).entries({
      tutorial_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      stepNumber: 3,
      questionId: 'validate-3',
      questionText: 'What is X?',
      correctAnswer: 'X is Y.',
      ruleType: 'exact-match',
      aiGrading: true
    });
  });

  it('returns the spec when found', async () => {
    const result = await defaultLoadQuestion('sample', 3, 'validate-3');
    expect(result).toEqual({
      questionId: 'validate-3',
      question: 'What is X?',
      correctAnswer: 'X is Y.',
      aiGrading: true
    });
  });

  it('lowercases the slug for lookup', async () => {
    const result = await defaultLoadQuestion('SAMPLE', 3, 'validate-3');
    expect(result?.questionId).toBe('validate-3');
  });

  it('returns null when slug not found', async () => {
    expect(await defaultLoadQuestion('nonexistent', 3, 'validate-3')).toBeNull();
  });

  it('returns null when step+questionId not found in that tutorial', async () => {
    expect(await defaultLoadQuestion('sample', 99, 'validate-99')).toBeNull();
  });

  it('returns null gracefully on any error', async () => {
    // Pass a bogus arg to provoke an internal error path
    expect(await defaultLoadQuestion(null, 3, 'validate-3')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run test/unit/validate-answer-question-loader.test.js`
Expected: module not found.

- [ ] **Step 3: Implement the loader**

```js
// srv/lib/validate-answer-question-loader.js
import cds from '@sap/cds';

const LOG = cds.log('validate-answer-loader');

/**
 * Resolve a single ValidateAnswerSpec by (slug, stepNumber, questionId).
 * Returns the dispatch-shaped object or null on miss / error.
 *
 * Defensive: any thrown error is caught and logged. The dispatch function
 * treats null as "question_missing" — same as a real miss.
 */
export async function defaultLoadQuestion(slug, stepNumber, questionId) {
  try {
    if (typeof slug !== 'string' || !slug) return null;
    const lcSlug = slug.toLowerCase();
    const { Tutorials, ValidateAnswerSpecs } = cds.entities('com.sap.developers.ims');

    // Two-step lookup: first the Tutorial by slug, then the spec by FK.
    // Same pattern as srv/lib/code-check-step-loader.js.
    const tut = await SELECT.one.from(Tutorials).where({ slug: lcSlug });
    if (!tut) return null;

    const spec = await SELECT.one.from(ValidateAnswerSpecs).where({
      tutorial_ID: tut.ID,
      stepNumber,
      questionId
    });
    if (!spec) return null;

    return {
      questionId: spec.questionId,
      question: spec.questionText,
      correctAnswer: spec.correctAnswer,
      aiGrading: Boolean(spec.aiGrading)
    };
  } catch (err) {
    LOG.warn('defaultLoadQuestion error', err.message);
    return null;
  }
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run test/unit/validate-answer-question-loader.test.js`
Expected: 5 passing.

Also re-run the handler tests to confirm no regression: `npx vitest run test/unit/validate-answer-handler.test.js`. Expected: 13 still passing.

- [ ] **Step 5: Confirm `srv/server.js` syntax**

Run: `node --check srv/server.js`
Expected: silent (exit 0). The route registration from Task 6 now resolves cleanly because `defaultLoadQuestion` exists.

- [ ] **Step 6: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/209-free-text-grader" ] && \
  git add srv/lib/validate-answer-question-loader.js test/unit/validate-answer-question-loader.test.js && \
  git commit -m "feat(codecheck): defaultLoadQuestion reads ValidateAnswerSpecs (#209)

Two-step lookup via Tutorials slug (lowercased) → tutorial_ID →
ValidateAnswerSpecs by (tutorial_ID, stepNumber, questionId).
Same pattern as code-check-step-loader.js.

Returns null on miss / error so the dispatch can map to
'question_missing' uniformly. defaultCallModel from
srv/lib/code-check-llm.js is reused as-is — same SDK forced-
tool-call pattern, only the schema differs."
```

---

### Task 8: Publish endpoint `/content/validate-answer-specs`

**Files:**
- Create: `srv/lib/validate-answer-spec-publish.js`
- Modify: `srv/server.js` (wire route alongside `/content/code-check-specs`)
- Test: `test/unit/validate-answer-spec-publish.test.js` (new)

The publish endpoint accepts a JSON payload of `{ slug, specs: [{ stepNumber, questionId, questionText, correctAnswer, ruleType, aiGrading }] }` and upserts into `ValidateAnswerSpecs` keyed by `(tutorial_ID, stepNumber, questionId)`. Bearer auth via `CONTENT_API_KEY` (same gate as `/content/publish` and `/content/code-check-specs`).

The endpoint is REPLACE-per-slug semantics: every call deletes the slug's existing rows and inserts the new ones in a single transaction. Same shape as `srv/lib/code-check-spec-publish.js` (PR #205 Task 1.8) — mirror it.

- [ ] **Step 1: Write the failing test**

Create `test/unit/validate-answer-spec-publish.test.js`. Mirror `test/unit/code-check-spec-publish.test.js` shape.

Cover:

1. **Missing/wrong bearer → 401.**
2. **Body validation:** missing `slug` → 400. `specs` not array → 400. Spec missing `stepNumber` → 400. `correctAnswer.length > 10000` → 400 (10 KB max).
3. **Tutorial not found by slug → 404 `{ error: 'tutorial_not_found' }`.**
4. **Happy path — single spec inserted.** Verify a row in `ValidateAnswerSpecs` with the right FK + content.
5. **Replace semantics:** publish slug A with 2 specs → publish A with 1 spec → only the 1 spec remains for A.
6. **Other slugs untouched:** publish slug A → publish slug B → A's specs still present.
7. **Slug lowercased on lookup** (mirror code-check pattern).

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run test/unit/validate-answer-spec-publish.test.js`
Expected: module not found.

- [ ] **Step 3: Implement**

```js
// srv/lib/validate-answer-spec-publish.js
import cds from '@sap/cds';

const LOG = cds.log('validate-answer-publish');
const MAX_FIELD_BYTES = 10_000;

export function makeValidateAnswerSpecPublishHandler(deps = {}) {
  const apiKey = deps.apiKey;
  if (typeof apiKey !== 'string' || !apiKey) {
    throw new Error('makeValidateAnswerSpecPublishHandler requires deps.apiKey');
  }

  return async function publishValidateAnswerSpecs(req, res) {
    const auth = req.get('authorization') || '';
    const expected = `Bearer ${apiKey}`;
    if (auth !== expected) {
      return res.status(401).json({ error: 'unauthenticated' });
    }

    const { slug, specs } = req.body || {};
    if (typeof slug !== 'string' || !slug || !Array.isArray(specs)) {
      return res.status(400).json({ error: 'invalid_body' });
    }
    for (const s of specs) {
      if (typeof s.stepNumber !== 'number'
          || typeof s.questionId !== 'string' || !s.questionId
          || typeof s.questionText !== 'string'
          || typeof s.correctAnswer !== 'string'
          || typeof s.ruleType !== 'string') {
        return res.status(400).json({ error: 'invalid_spec' });
      }
      if (Buffer.byteLength(s.correctAnswer, 'utf8') > MAX_FIELD_BYTES
          || Buffer.byteLength(s.questionText, 'utf8') > MAX_FIELD_BYTES) {
        return res.status(400).json({ error: 'too_long' });
      }
    }

    const lcSlug = slug.toLowerCase();
    const { Tutorials, ValidateAnswerSpecs } = cds.entities('com.sap.developers.ims');

    try {
      await cds.tx(async () => {
        const tut = await SELECT.one.from(Tutorials).where({ slug: lcSlug });
        if (!tut) {
          const err = new Error('tutorial_not_found');
          err.status = 404;
          throw err;
        }
        await DELETE.from(ValidateAnswerSpecs).where({ tutorial_ID: tut.ID });
        if (specs.length) {
          await INSERT.into(ValidateAnswerSpecs).entries(
            specs.map(s => ({
              tutorial_ID: tut.ID,
              stepNumber: s.stepNumber,
              questionId: s.questionId,
              questionText: s.questionText,
              correctAnswer: s.correctAnswer,
              ruleType: s.ruleType,
              aiGrading: Boolean(s.aiGrading)
            }))
          );
        }
      });
      return res.status(200).json({ ok: true, count: specs.length });
    } catch (err) {
      if (err.status === 404) {
        return res.status(404).json({ error: 'tutorial_not_found' });
      }
      LOG.error('validate-answer-spec-publish failed', err);
      return res.status(500).json({ error: 'internal' });
    }
  };
}
```

- [ ] **Step 4: Wire into `srv/server.js`**

Find the existing `/content/code-check-specs` route. Add alongside:

```js
import { makeValidateAnswerSpecPublishHandler } from './lib/validate-answer-spec-publish.js';

// Inside cds.on('served'):
const validateAnswerPublishHandler = makeValidateAnswerSpecPublishHandler({
  apiKey: process.env.CONTENT_API_KEY
});
app.post('/content/validate-answer-specs',
  express.json({ limit: '5mb' }),
  validateAnswerPublishHandler
);
```

- [ ] **Step 5: Run test, verify pass**

Run: `npx vitest run test/unit/validate-answer-spec-publish.test.js`
Expected: 7 passing.

- [ ] **Step 6: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/209-free-text-grader" ] && \
  git add srv/lib/validate-answer-spec-publish.js srv/server.js test/unit/validate-answer-spec-publish.test.js && \
  git commit -m "feat(codecheck): /content/validate-answer-specs publish endpoint (#209)

Bearer-auth-gated (CONTENT_API_KEY) endpoint that REPLACES all
ValidateAnswerSpecs rows for a single tutorial slug in one
transaction. Mirrors srv/lib/code-check-spec-publish.js shape:
slug-keyed, tutorial-not-found returns 404, body cap 10 KB
per text field, lowercased slug lookup. Other slugs untouched
on a per-slug publish."
```

---

### Task 9: Publish CLI extension — `publish-validate-answer.js`

**Files:**
- Create: `scripts/lib/publish-validate-answer.js`
- Modify: `scripts/publish-content.ts` (call the helper after `publishCodeCheckSpecs`)
- Test: `test/unit/publish-validate-answer.test.js` (new) — for the helper module only

The helper walks the Hugo build output for `<slug>.validate-answer.json` sidecar files (Task 3 emits them), POSTs to `/content/validate-answer-specs` for each one, and reports any failures non-fatally (CI doesn't fail the whole publish if one slug's specs fail). Mirror `scripts/lib/publish-code-check.js` shape.

- [ ] **Step 1: Write the failing test**

Create `test/unit/publish-validate-answer.test.js`. Mirror `test/unit/publish-code-check.test.js`. Use `node:test` style or vitest, whatever the existing test uses.

Cover:

1. **No sidecar files → empty result, no HTTP calls.**
2. **One sidecar → POST'd to correct URL with bearer header.**
3. **Multiple sidecars → multiple POSTs in series.**
4. **404 on one slug → captured in `failures` array, others continue.**
5. **5xx on one slug → captured in `failures` array, others continue.**
6. **Auth header uses `apiKey` argument, not env var directly** (testability).

- [ ] **Step 2: Run test, expect failure**

Run: `npx vitest run test/unit/publish-validate-answer.test.js`
Expected: module not found.

- [ ] **Step 3: Implement the helper**

```js
// scripts/lib/publish-validate-answer.js
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Walk Hugo build output for *.validate-answer.json sidecar files,
 * POST each one to /content/validate-answer-specs.
 *
 * @param {object} opts
 * @param {string} opts.publicDir - Hugo build output dir (e.g. hugo/public)
 * @param {string} opts.baseUrl   - CAP base URL
 * @param {string} opts.apiKey    - CONTENT_API_KEY value
 * @param {Function} [opts.fetch] - injected fetch (for testing)
 * @returns {Promise<{published: number, failures: Array<{slug: string, status: number, body: string}>}>}
 */
export async function publishValidateAnswerSpecs({ publicDir, baseUrl, apiKey, fetch: injectedFetch }) {
  const f = injectedFetch ?? globalThis.fetch;
  const sidecars = await findSidecars(publicDir);
  const failures = [];
  let published = 0;

  for (const sidecar of sidecars) {
    const raw = await readFile(sidecar.path, 'utf8');
    const payload = JSON.parse(raw);  // { slug, specs }

    const res = await f(`${baseUrl}/content/validate-answer-specs`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: raw  // raw is already the JSON body
    });

    if (!res.ok) {
      failures.push({
        slug: payload.slug,
        status: res.status,
        body: await res.text().catch(() => '')
      });
      continue;
    }
    published++;
  }
  return { published, failures };
}

async function findSidecars(publicDir) {
  // Hugo emits to publicDir/tutorials/<slug>/index.html and we co-locate
  // <slug>.validate-answer.json under publicDir/tutorials/<slug>/.
  const tutorialsDir = path.join(publicDir, 'tutorials');
  let dirents;
  try { dirents = await readdir(tutorialsDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const candidate = path.join(tutorialsDir, d.name, `${d.name}.validate-answer.json`);
    try {
      const stat = await readFile(candidate, 'utf8');
      if (stat) out.push({ slug: d.name, path: candidate });
    } catch { /* skip */ }
  }
  return out;
}
```

- [ ] **Step 4: Wire into `scripts/publish-content.ts`**

Find where `publishCodeCheckSpecs` is called (PR #205 Task 1.9). Add a sibling call right after:

```ts
import { publishValidateAnswerSpecs } from './lib/publish-validate-answer.js';
// ...
const veResult = await publishValidateAnswerSpecs({
  publicDir: HUGO_PUBLIC_DIR,
  baseUrl: CAP_BASE_URL,
  apiKey: process.env.CONTENT_API_KEY ?? ''
});
console.log(`[validate-answer] published ${veResult.published} specs, ${veResult.failures.length} failures`);
if (veResult.failures.length) {
  for (const f of veResult.failures) {
    console.warn(`  - ${f.slug}: ${f.status} ${f.body.slice(0, 200)}`);
  }
}
// Don't `process.exit(1)` on failures — non-fatal per spec.
```

- [ ] **Step 5: Run test, verify pass**

Run: `npx vitest run test/unit/publish-validate-answer.test.js`
Expected: 6 passing.

- [ ] **Step 6: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/209-free-text-grader" ] && \
  git add scripts/lib/publish-validate-answer.js scripts/publish-content.ts test/unit/publish-validate-answer.test.js && \
  git commit -m "feat(codecheck): publish-content.ts uploads validate-answer specs (#209)

Walks hugo/public/tutorials/<slug>/<slug>.validate-answer.json
sidecar files emitted by the Hugo build (Task 3) and POSTs each
to /content/validate-answer-specs with the CONTENT_API_KEY
bearer. Failures are reported but non-fatal — a single bad slug
does not abort the publish run. Mirrors scripts/lib/publish-code-check.js."
```

---

## Phase 2 — Frontend integration

### Task 10: Extend `Validation.vue` with the AI-graded async branch + 3-state UI

**Files:**
- Modify: `hugo-apps/src/validation/Validation.vue`
- Modify: `hugo-apps/src/validation/grading.ts` (add `isAiGraded` helper + tighten types if needed)
- Test: `test/unit/validation-grading.test.js` (add new cases for `isAiGraded` partition)
- Test: `test/unit/validation-component.test.js` (new — smoke-test the async branch via `@vue/test-utils`, optional)

The integration seam from #212 is `onSubmit()` in `Validation.vue`. This task adds an async branch:

```ts
async function onSubmit() {
  submitted.value = true;
  pending.value = true;
  try {
    const aiQs   = props.questions.filter(isAiGraded);
    const localQs = props.questions.filter(q => !isAiGraded(q));

    // Local synchronous grading first (cheap, fail-fast).
    const local = gradeAnswers(localQs, answers.value);
    if (!local.correct) {
      result.value = 'incorrect';
      return;
    }

    // All local Qs pass — now grade AI Qs (one POST per question).
    let allPass = true;
    let firstHint = '';
    for (const q of aiQs) {
      const submitted = (answers.value[q.id] ?? '').trim();
      if (!submitted) { allPass = false; break; }
      const r = await gradeAi(props.slug, props.stepNumber, q.id, submitted);
      if (r.verdict === 'pass') continue;
      allPass = false;
      if (r.verdict === 'partial' && r.hint && !firstHint) firstHint = r.hint;
      // 'fail' / 'error' / 'disabled' — short-circuit, no hint surfaced.
      break;
    }

    if (allPass) {
      result.value = 'correct';
      hint.value = '';
      writePersisted(props.slug, props.stepNumber, true);
      const ev = new CustomEvent('step-validated', { detail: { stepNumber: props.stepNumber } });
      document.dispatchEvent(ev);
    } else if (firstHint) {
      result.value = 'partial';
      hint.value = firstHint;
    } else {
      result.value = 'incorrect';
    }
  } finally {
    pending.value = false;
  }
}

async function gradeAi(slug: string, stepNumber: number, questionId: string, submittedAnswer: string) {
  try {
    const res = await fetch('/api/validate-answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ tutorialSlug: slug, stepNumber, questionId, submittedAnswer })
    });
    if (res.status === 503) return { verdict: 'disabled' as const };
    if (res.status === 429) return { verdict: 'error' as const, errorReason: 'rate_limited' };
    if (!res.ok)            return { verdict: 'error' as const, errorReason: 'http_' + res.status };
    return await res.json();
  } catch {
    return { verdict: 'error' as const, errorReason: 'network' };
  }
}
```

3-state UI:

| `result` | UI |
|---------|-------------|
| `correct` | `<ui5-message-strip design="Positive">` "Correct!" |
| `partial` | `<ui5-message-strip design="Information">` `{{ hint }}` (the model-authored partial-credit hint, NOT canned text) |
| `incorrect` | `<ui5-message-strip design="Negative">` "Not quite — try again." |

When the AI endpoint returns `disabled` (503), the component falls back to **rendering the form as if no AI grading were configured** — the question stays gradable client-side via `correctAnswer` equality (#212 path). The user sees no error message; just the standard pass/fail flow. This mirrors the spec's graceful-degradation behavior.

When `pending.value === true` show `<ui5-busy-indicator delay="0" active>` overlaying the submit button. Use `<ui5-button :disabled="pending">` to prevent double-click.

- [ ] **Step 1: Add `isAiGraded` to `grading.ts`**

```ts
// hugo-apps/src/validation/grading.ts
export function isAiGraded(q: ValidationQuestion): boolean {
  return q.aiGrading === true;
}
```

Update the `ValidationQuestion` interface comment: `aiGrading?: boolean` is now USED (not reserved). Keep the field optional so #212-only consumers don't break.

- [ ] **Step 2: Add unit tests for `isAiGraded` + 3-state grading partition**

In `test/unit/validation-grading.test.js`:

1. `isAiGraded` returns `true` for `{ aiGrading: true }`.
2. `isAiGraded` returns `false` for `{ aiGrading: false }`.
3. `isAiGraded` returns `false` for `{}` (undefined).
4. `gradeAnswers` only grades non-AI questions (existing behavior preserved when an AI question is mixed in).

Run `npx vitest run test/unit/validation-grading.test.js` — expected: 19 passing (15 + 4 new).

- [ ] **Step 3: Modify `Validation.vue`**

Add reactive state: `pending`, `hint`. Add `gradeAi(...)` helper. Replace synchronous `onSubmit` body with the async branch above. Add the `Information`-design `<ui5-message-strip>` for the `partial` state.

Add `<ui5-busy-indicator>` import to `ui5-bootstrap.ts` if not already present:

```ts
import "@ui5/webcomponents/dist/BusyIndicator.js";
```

(Verify with `grep BusyIndicator hugo/assets/js/ui5-bootstrap.ts` — if already present, skip.)

- [ ] **Step 4: Manual smoke (deferred until task 14 wires it in dev)**

Mark this step as deferred — actual integration smoke happens via the hybrid test (Task 12). The component file should compile and the bundle should build under budget.

Run: `cd hugo-apps && npm run build`
Expected: `validation.js` still under 8 KB gzipped.

If it exceeds 8 KB: bump the budget in `hugo-apps/vite.config.ts` to `MAX_VALIDATION_GZIP = 12_000` and document the bump in the commit. The `gradeAi` helper is ~50 LOC of pure code; it should fit.

- [ ] **Step 5: Run unit tests**

Run: `npx vitest run test/unit/validation-grading.test.js`
Expected: 19 passing.

- [ ] **Step 6: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/209-free-text-grader" ] && \
  git add hugo-apps/src/validation/Validation.vue hugo-apps/src/validation/grading.ts \
          hugo/assets/js/ui5-bootstrap.ts test/unit/validation-grading.test.js && \
  git commit -m "feat(codecheck): Validation.vue async AI-graded branch (#209)

- Local-first grading: synchronous gradeAnswers() runs first;
  AI questions only POST'd if local Qs all pass (fail-fast saves
  upstream calls + token spend).
- 3-state UI: pass / partial-with-model-hint / fail.
  Partial is gated on the model returning a non-empty hint;
  otherwise the result is treated as incorrect (no canned hint).
- 503 (disabled) falls through to client-side correctAnswer
  equality grading — feature flag off behaves like #212 only.
- ui5-busy-indicator overlay during async grading; double-click
  prevented via :disabled.
- step-validated CustomEvent fires on full pass (preserves the
  Done-button gate from PR #226)."
```

---

### Task 11: Mark `ValidateAnswerSubmissions` as `@analytics.exposed`

**Files:**
- Modify: `db/schema.cds` (add `@analytics.exposed: true` annotation on the entity defined in Task 1)
- Test: `test/unit/analytics-validate-answer-exposure.test.js` (new)

The Analytics Builder (PR #142) gates its surface on `@analytics.exposed`. This task adds the annotation so admins can drill into AI grading outcomes without code changes.

- [ ] **Step 1: Write the failing test**

Create `test/unit/analytics-validate-answer-exposure.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

describe('ValidateAnswerSubmissions analytics exposure', () => {
  let model;
  beforeAll(async () => {
    model = await cds.load(path.join(process.cwd(), 'db', 'schema.cds'));
  });

  it('exposes ValidateAnswerSubmissions to AnalyticsService', () => {
    const def = model.definitions['com.sap.developers.ims.ValidateAnswerSubmissions'];
    expect(def).toBeDefined();
    // Real CSN can store this as flat OR nested — check both shapes.
    const flat = def['@analytics.exposed'];
    const nested = def['@analytics']?.exposed;
    expect(flat === true || nested === true).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run test/unit/analytics-validate-answer-exposure.test.js`
Expected: assertion failure — `@analytics.exposed` not set.

- [ ] **Step 3: Add the annotation**

Edit `db/schema.cds`. Find the `ValidateAnswerSubmissions` entity defined in Task 1. Add **only** the `@analytics.exposed` annotation as a single-line annotation directly above the entity declaration (do NOT redefine the entity body, do NOT add `@PersonalData` here — that already lives in `db/audit-logging.cds` per Task 1 Step 4, and the default `null-personal` cascade from PR #221 handles user-ID nulling automatically):

```cds
@analytics.exposed: true
entity ValidateAnswerSubmissions : managed {
  // existing fields from Task 1 — DO NOT MODIFY THE BODY
}
```

The other `@PersonalData.*` annotations live in `db/audit-logging.cds` (already added in Task 1 Step 4 via the `annotate ims.ValidateAnswerSubmissions with @PersonalData : { ... }` block). PR #221's annotation walker reads from the merged CSN at compile time, so wherever the annotation is declared, the cascade picks it up.

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run test/unit/analytics-validate-answer-exposure.test.js`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/209-free-text-grader" ] && \
  git add db/schema.cds test/unit/analytics-validate-answer-exposure.test.js && \
  git commit -m "feat(codecheck): expose ValidateAnswerSubmissions to analytics (#209)

@analytics.exposed: true makes the table queryable from
the Analytics Builder without code changes. Useful for
admins drilling into AI grading verdicts (pass/partial/fail
distribution, retry counts, prompt-version drift)."
```

---

## Phase 3 — Tests + verification

### Task 12: Hybrid test for `@PersonalData.cascade` anonymization + loader HANA quirks

**Files:**
- Test: `test/hybrid/validate-answer-anonymize.test.js` (new)
- Test: `test/hybrid/validate-answer-loader.test.js` (new — added during Task 7 review)

The PR #221 anonymize cascade walks `@PersonalData.cascade.anonymize` annotations across all entities. `ValidateAnswerSubmissions.user_ID` declared in Task 1 should be NULLed for the target user during anonymization. This test verifies the real HANA pipeline.

**Loader HANA quirks (added per Task 7 quality review):** when running on real HANA, `defaultLoadQuestion` must (a) coerce `aiGrading` to a real JS boolean even when HANA returns `0/1` integers, and (b) find rows when `Tutorials.slug` is stored mixed-case (the publish-write path lowercases per [[feedback_audit_all_callers_of_buggy_primitive]], but a defense-in-depth hybrid test pins the contract). Add a second hybrid test file alongside the cascade test that asserts:

1. Insert a Tutorial with a known-lowercase slug + a ValidateAnswerSpec with `aiGrading: true` → loader returns `aiGrading === true` (typeof === 'boolean').
2. Insert a Tutorial with a known-lowercase slug + a ValidateAnswerSpec with `aiGrading: false` → loader returns `aiGrading === false`.
3. Loader called with mixed-case slug input → finds the lowercase-stored row (verifies `slug.toLowerCase()` defense).

- [ ] **Step 1: Write the test**

```js
// test/hybrid/validate-answer-anonymize.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import './_guard.js';  // write-safety guard

describe('ValidateAnswerSubmissions cascade on anonymization (hybrid)', () => {
  let cleanupIds = [];

  beforeAll(async () => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('hybrid writes disabled');
    }
  });

  afterAll(async () => {
    if (!cleanupIds.length) return;
    const { Users, ValidateAnswerSubmissions } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ValidateAnswerSubmissions).where({ user_ID: { in: cleanupIds } });
    await DELETE.from(Users).where({ ID: { in: cleanupIds } });
  });

  it('NULLs user_ID on anonymize via @PersonalData.cascade', async () => {
    const { Users, ValidateAnswerSubmissions } = cds.entities('com.sap.developers.ims');
    const userId = `__TEST__user-${Date.now()}`;
    cleanupIds.push(userId);

    await INSERT.into(Users).entries({
      ID: userId,
      email: '__TEST__cascade@example.invalid',
      displayName: '__TEST__ Cascade User',
      status: 'ACTIVE'
    });
    await INSERT.into(ValidateAnswerSubmissions).entries({
      user_ID: userId,
      tutorialSlug: '__test__-slug',
      stepNumber: 1,
      questionId: 'q1',
      submittedAnswer: '__TEST__ answer text',
      verdict: 'pass',
      promptVersion: 'v1'
    });

    // Trigger admin anonymize action.
    const adminSrv = await cds.connect.to('AdminService');
    await adminSrv.send('anonymizeUser', { userId });

    // Confirm cascade.
    const after = await SELECT.from(ValidateAnswerSubmissions).where({ tutorialSlug: '__test__-slug' });
    expect(after.length).toBe(1);
    expect(after[0].user_ID).toBeNull();
    // Other fields preserved (only user_ID is the PII handle).
    expect(after[0].submittedAnswer).toBe('__TEST__ answer text');
  });
});
```

- [ ] **Step 2: Run hybrid suite**

Run: `ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --config vitest.config.ts --project hybrid test/hybrid/validate-answer-anonymize.test.js`

Expected: pass against deployed HANA. (`cf login` must already point at DEV space.)

If this fails with `column USER_ID does not exist`: the schema change from Task 1 hasn't been deployed yet. Run `cf push tutorials-db-deployer -p ../gen/db --no-route --health-check-type process -b nodejs_buildpack` (per the project memory `cf-push-db-deployer-fast-path`). Re-run the test.

- [ ] **Step 3: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/209-free-text-grader" ] && \
  git add test/hybrid/validate-answer-anonymize.test.js && \
  git commit -m "test(hybrid): cascade NULLs ValidateAnswerSubmissions.user_ID (#209)

Verifies the @PersonalData.cascade.anonymize annotation walker
shipped in PR #221 picks up the new entity automatically.
Real-HANA test — schema must be deployed before this passes."
```

---

### Task 13: Smoke test for `/api/validate-answer` against deployed app

**Files:**
- Test: `test/smoke/validate-answer.test.js` (new)

- [ ] **Step 1: Write the test**

```js
// test/smoke/validate-answer.test.js
import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_SRV_URL;
if (!BASE) throw new Error('SMOKE_SRV_URL not set');

describe('/api/validate-answer smoke', () => {
  it('rejects anonymous (no cookie)', async () => {
    const res = await fetch(`${BASE}/api/validate-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tutorialSlug: 'anything',
        stepNumber: 1,
        questionId: 'q',
        submittedAnswer: 'a'
      })
    });
    // 401 (auth gate) OR 503 (flag off) — both acceptable smoke results.
    expect([401, 503]).toContain(res.status);
  });

  it('returns 503 when validateAnswerEnabled=false (flag-off path)', async () => {
    // This case only runs if the flag is off in the deployed env.
    // If it's on, we expect 401 instead.
    const res = await fetch(`${BASE}/api/validate-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tutorialSlug: 'doesnt-matter',
        stepNumber: 1,
        questionId: 'q',
        submittedAnswer: 'a'
      })
    });
    expect([401, 503]).toContain(res.status);
  });
});
```

- [ ] **Step 2: Run smoke**

Run: `SMOKE_BASE_URL=https://... SMOKE_SRV_URL=https://... npm run test:smoke -- test/smoke/validate-answer.test.js`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/209-free-text-grader" ] && \
  git add test/smoke/validate-answer.test.js && \
  git commit -m "test(smoke): /api/validate-answer endpoint reachability (#209)

Verifies the route is registered + auth gate or feature flag
returns the expected 401/503. Deploy auto-runs this in CI."
```

---

### Task 14: Developer reference doc + sidebar registration

**Files:**
- Create: `docs/developers/architecture/free-text-grader.md`
- Modify: `docs/.vitepress/config.ts` (sidebar registration — predocs:build guard requires it)

Mirror the shape of `docs/developers/architecture/validation-widget.md` (PR #226).

Cover:

1. End-to-end flow diagram: rules.vr `[VALIDATE_N]` with `regex` rule type → parser auto-routes to AI grading → Hugo emits sidecar JSON → `publish-content.ts` POSTs to `/content/validate-answer-specs` → at runtime, `Validation.vue` POSTs to `/api/validate-answer` → `dispatchValidateAnswer` → `defaultLoadQuestion` (pulls correctAnswer from `ValidateAnswerSpecs`) → `defaultCallModel` (forced tool call) → `redactReferenceLeaks` → 3-state verdict back to UI.
2. The `ChatSettings.validateAnswerEnabled` flag (default false; admins flip it on per environment).
3. Anti-leak guarantees: correctAnswer NEVER ships in `<script id="tutorial-data">` for AI-graded questions. Server-side spec storage in `ValidateAnswerSpecs`. Prompt redaction layer. Telemetry-side correctAnswer capture is documented (intentional for explainability).
4. Rate limits: 30/hour per user, 5/5min per (user, slug, step). Same as `/api/codecheck`.
5. Local dev: how to set the flag on a hybrid run (`cds.update(ChatSettings).set({ validateAnswerEnabled: true })`).
6. Author flow: how to write a `[VALIDATE_N]` block that opts into AI grading (`###Grading: ai-judged` directive OR auto-route on `regex` rule type). Cross-link to the rules.vr authoring guide.

Add to sidebar in `docs/.vitepress/config.ts`:

```ts
{ text: 'Free-text Grader', link: '/developers/architecture/free-text-grader' },
```

- [ ] **Step 1: Write the doc**

Use the existing validation-widget doc as the template; replace headings + flow diagram + flag references.

- [ ] **Step 2: Run sidebar guard**

Run: `npm run docs:build`
Expected: pass. The `predocs:build` script will fail if a new page isn't sidebar-registered.

- [ ] **Step 3: Commit**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/209-free-text-grader" ] && \
  git add docs/developers/architecture/free-text-grader.md docs/.vitepress/config.ts && \
  git commit -m "docs: free-text grader reference (#209)

End-to-end flow + anti-leak guarantees + rate-limit table +
author opt-in pattern. Sidebar entry added to satisfy
predocs:build guard."
```

---

### Task 15: Final verification + draft PR

- [ ] **Step 1: Run the full unit test suite**

Run: `npm test`
Expected: existing baseline + new tests added in this PR all pass. No regressions.

- [ ] **Step 2: Run linter**

Run: `npx eslint srv/lib/validate-answer-*.js scripts/lib/publish-validate-answer.js hugo-apps/src/validation/`
Expected: no errors. Project's lint config (CommonJS for srv/lib pre-2026-05; ESM elsewhere — confirm against neighbors).

- [ ] **Step 3: Run schema-drift check**

Run: `node scripts/check-schema-drift.cjs` (if present) or compare prod/QA HDI artifacts manually per `.github/workflows/schema-drift-check.yml`.
Expected: only `JobLocks` drift (pre-existing). The new `ValidateAnswerSpecs` + `ValidateAnswerSubmissions` are in shared schema, not just prod or just QA.

- [ ] **Step 4: Run audit for srv-qa cp-list transitive deps**

Per `feedback_srv_qa_cp_list_recurring`: re-walk `./` imports from `srv/lib/content-store.js` AND from each new `srv/lib/validate-answer-*.js` file. Confirm every transitive dep is in `.deploy/mta.yaml`'s `srv-qa` `cp` list.

If a new lib import is NOT in srv-qa's cp list, ADD it. Boot test: `cd .deploy && mbt build`. If this is a server-side-only change (no QA UI involvement), the new files probably DO need to land in srv-qa because the QA srv reuses `content-store.js`'s import graph.

- [ ] **Step 5: Push branch and open draft PR**

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/209-free-text-grader" ] && \
  git push -u origin feature/209-free-text-grader && \
  gh pr create --draft --title "feat: AI free-text grader (closes #209)" --body "$(cat <<'EOF'
## Summary

Server-side AI grading of free-text validation answers. Closes #209.

## What ships

**Backend (srv/lib + srv/server.js):**
- `validate-answer-prompt.js` — prompt builder + JSON schema for forced tool call.
- `validate-answer-tool.js` — `dispatchValidateAnswer` core (pure).
- `validate-answer-handler.js` — `/api/validate-answer` Express handler with 30/hr per-user + 5/5min per-step rate limits.
- `validate-answer-question-loader.js` — pulls correctAnswer from new `ValidateAnswerSpecs` HANA entity.
- `validate-answer-spec-publish.js` — `/content/validate-answer-specs` publish endpoint (bearer-auth gated).

**Schema (db/schema.cds):**
- `ValidateAnswerSpecs` — server-side question + correctAnswer storage.
- `ValidateAnswerSubmissions` — telemetry + analytics surface (`@analytics.exposed`, `@PersonalData.cascade`).
- `ChatSettings.validateAnswerEnabled` — feature flag, default false.

**Build pipeline:**
- Parser: `###Grading: ai-judged` directive + auto-route on `regex` rule types.
- Hugo emits `<slug>.validate-answer.json` sidecar per tutorial.
- `scripts/lib/publish-validate-answer.js` walks sidecars + POSTs to `/content/validate-answer-specs`.

**Frontend:**
- `Validation.vue` extended with async branch — local-first grading, AI Qs grade serially, 3-state UI (pass / partial-with-model-hint / fail).
- `ui5-busy-indicator` overlay, `:disabled` double-click guard.

**Tests:**
- 50+ unit tests across the new modules.
- Hybrid test for the `@PersonalData.cascade` user_ID anonymization on real HANA.
- Smoke test for endpoint reachability against deployed app.

**Docs:**
- `docs/developers/architecture/free-text-grader.md` — end-to-end flow + anti-leak guarantees + rate limits.

## Anti-leak guarantees

- For AI-graded questions, correctAnswer **does NOT** ship in `<script id="tutorial-data">` (parser strips it from public frontmatter).
- correctAnswer lives only in `ValidateAnswerSpecs` (server-side).
- The prompt redaction layer (`redactReferenceLeaks` from PR #205) is reused before model output reaches the user.
- correctAnswer **IS** captured in telemetry submissions for explainability — documented trade-off.

## Rate limits

| Scope | Window | Cap |
|-------|--------|-----|
| Per user | 1 hour | 30 |
| Per (user, slug, step) | 5 min | 5 |

Same as `/api/codecheck` (PR #205).

## Feature flag

Default OFF (`ChatSettings.validateAnswerEnabled = false`). Admins flip it on per environment via the Joule Chat Settings tile.

## Cutover

1. Merge → schema deploys via auto-deploy db-deployer.
2. Author opt-in via `###Grading: ai-judged` directive in their `[VALIDATE_N]` blocks (rules.vr).
3. Admin flips flag on in DEV → spot-check via deployed smoke.
4. Roll to prod after a week of DEV soak.

## Related

- Built atop PR #226 (#212 — validation widget modernisation).
- Cascade tested against PR #221 (#211 — anonymize cascade).
- Mirror of PR #205 (#171 — AI code-check spike) shape.
EOF
)"
```

- [ ] **Step 6: Notify Tom**

Post a one-liner to the PR body or the channel: "PR #X is up as a draft. Hybrid test + smoke pass against DEV. Awaiting your review."

---

## Cross-cutting concerns

### Branch hygiene (every commit)

Every commit in this plan uses the guard:

```bash
BR=$(git branch --show-current) && [ "$BR" = "feature/209-free-text-grader" ] && git commit ...
```

If the branch flips silently (a known harness bug per memory `feedback_verify_branch_before_commit`), the guard FAILS — the implementer MUST stash, re-checkout, and try again. Never bypass.

### Commit hygiene (granularity)

Each task = one logical commit. Tests + impl + wire-up land together. Subagents should NOT commit half-finished tasks. Subagents should NOT amend prior commits without explicit instruction.

### Naming

`validate-answer` is the universal prefix throughout — endpoint URL, file names, function names, entity names, env vars (`CONTENT_API_KEY` is reused; no new key). Do not introduce variants like `free-text-grader-foo` or `vat-foo` in code; reserve those for issue-tracker shorthand only.

### Logging

Module-level loggers via `cds.log('validate-answer-...')` per file. NEVER log full submitted answers (PII risk). Log slug + step + verdict + duration. The `dispatchValidateAnswer` core MUST NOT log `submittedAnswer` even on error path.

### Token budget

- Prompt: ~1.5 KB system + spec JSON (~500 B) + answer (≤5 KB) ≈ 7 KB input ≈ 2 K tokens.
- Output: forced tool call returns small JSON ≈ 100-300 tokens.
- Per call: ~0.005-0.01 USD on the SDK's default model. With the 30/hour cap, max spend per user per hour is ~0.30 USD.

### Pre-flight checklist (before drafting PR)

- [ ] All 15 tasks complete + committed.
- [ ] `npm test` clean (no regressions).
- [ ] `npm run lint` clean (or whatever the project script name is).
- [ ] Unit count: ≥50 new tests passing.
- [ ] Hybrid test passing against deployed DEV.
- [ ] Smoke test passing against deployed DEV.
- [ ] Schema-drift check clean.
- [ ] srv-qa cp-list audited.
- [ ] Bundle budget: `validation.js` ≤ 8 KB gz (or budget bump documented in commit).
- [ ] All 7 commits use the branch-guard pattern.
- [ ] PR description references closes #209.

---

**Done.**
