# AI Free-Text Grader for `[VALIDATE_N]` Text Questions — Design

**Status:** Draft for review
**Tracking issue:** [sap-tutorials/tutorials-ims#209](https://github.com/sap-tutorials/tutorials-ims/issues/209)
**Date:** 2026-06-04
**Author:** Tom Jung (with Claude)
**Depends on:** #212 (validation widget UI5 modernisation) must merge first.

## Summary

Replace exact-match grading on `[VALIDATE_N]` text questions with LLM-graded verdicts when the author opts in. Authors mark a question with a new `###Grading: ai-judged` directive in `rules.vr`. Additionally: existing `regex` and `regex-begins-with` rule types — which have been silently treated as plain string equality in `tutorial.ts` since the loader was written, never actually evaluated as regex — auto-route to the AI grader when the feature flag is on. The flag is `ChatSettings.validateAnswerEnabled` (default false).

Structurally a clone of PR #205 (the AI code-check spike) with a smaller payload and a 3-state verdict UI (pass / partial-with-hint / fail). Most of the dispatch shape, prompt builder pattern, forced-tool-call structured output, leak-redaction guard, telemetry table, rate-limit mechanism, and hybrid test pattern transfer directly.

## Goals

1. Authors can opt a `[VALIDATE_N]` text question into AI grading via a single new directive in `rules.vr`.
2. Existing `regex` and `regex-begins-with` rule types automatically participate in AI grading when the flag is on, fixing a pre-existing silent bug where these rules had never actually been evaluated as regex.
3. Learners get nuanced 3-state feedback (pass / partial / fail) on AI-graded questions, with an LLM-supplied hint on partial verdicts.
4. Submissions persist with full telemetry (token counts, latency, model name, errorReason) for offline grader-quality eval.
5. Reuse PR #205's infrastructure where the shape carries over: forced tool-call structured output, leak-redaction guard, rate-limit shape, `@PersonalData` cascade default.

## Non-Goals

- AI-authored quiz generation (#208) — separate ticket.
- Multi-language answer acceptance for non-en_us tutorials — the project is en_us only.
- Free-form chat-style help/discussion on a question — `Joule` chat is a separate surface.
- Backend-driven multiple-choice grading — multiple-choice stays client-side; AI grading is text-only.

## Approach

The new endpoint is `POST /api/validate-answer`. Per-question opt-in via `###Grading: ai-judged` (or implicit via `regex` rule type). The Vue island built in #212 routes AI-graded questions to the endpoint; non-AI-graded questions stay on the client-side path.

Approach mirrors PR #205 with the smaller schema described below. Patterns directly reused:
- `dispatchValidateAnswer(input, deps)` mirrors `dispatchCheckCode`'s signature.
- `defaultCallModel({ system, user, schema })` from `srv/lib/code-check-llm.js` reused as-is — same forced-tool-call SDK pattern.
- Express handler with sliding-window rate limits (30/hr per user + 5/5min per `(user, slug, step)`) — same shape as `code-check-handler.js`.
- `@PersonalData` annotation with the default `'null-personal'` cascade from PR #221.

## Architecture

```
scripts/parsers/rules.ts (modified)              New: srv/lib/validate-answer-tool.js
  parseBlock() now also reads:                     dispatchValidateAnswer(input, deps)
  ###Grading: ai-judged → aiGrading: true          (mirrors dispatchCheckCode)
  rule type ∈ {regex, regex-begins-with}
    → aiGrading: true (auto)                     New: srv/lib/validate-answer-prompt.js
                                                   buildSystemPrompt() / buildUserMessage()
scripts/parsers/types.ts (modified)                VALIDATE_ANSWER_OUTPUT_SCHEMA
  + ValidationQuestion.aiGrading?: boolean         redactReferenceLeaks (reused from code-check-prompt)

db/schema.cds (modified)                         New: srv/lib/validate-answer-handler.js
  + entity ValidateAnswerSubmissions               Express handler factory + rate limits
  + extend ChatSettings with validateAnswerEnabled
                                                 srv/server.js (modified)
db/audit-logging.cds (modified)                    + POST /api/validate-answer route
  + @PersonalData on ValidateAnswerSubmissions
                                                 hugo-apps/src/validation/Validation.vue (modified, from #212)
                                                   + onSubmit branches: if question.aiGrading
                                                     → POST /api/validate-answer
                                                   + 3-state UI: pass / partial / fail

srv/lib/code-check-llm.js (REUSED)               New tests:
  defaultCallModel — same shape, no change         test/unit/validate-answer-prompt.test.js
                                                   test/unit/validate-answer-tool.test.js
                                                   test/hybrid/validate-answer.test.js
                                                   test/smoke/validate-answer.test.js
```

The new code lives in `srv/lib/validate-answer-*.js` parallel to `srv/lib/code-check-*.js`. No refactor to consolidate; the two features stay independent because their grading semantics, output schemas, and prompts diverge.

## Parser change — opt-in directive + regex auto-route

In `scripts/parsers/rules.ts` `parseBlock` (around line 39-74), add the new directive parsing:

```ts
// Inside parseBlock, after the existing question/match extraction:
const gradingMatch = raw.match(/###Grading\s*\n([\s\S]*?)(?=###|$)/);
const gradingValue = gradingMatch?.[1]?.trim().toLowerCase();
const explicitlyAiGraded = gradingValue === 'ai-judged';

const REGEX_RULE_TYPES = new Set(['regex', 'regex-begins-with']);
const autoAiGraded = REGEX_RULE_TYPES.has(ruleType);

const aiGrading = explicitlyAiGraded || autoAiGraded;

// In the returned object:
return [{
  id: `validate-${stepNum}`,
  question,
  type,
  correctAnswer: matchContent,
  ...(aiGrading ? { aiGrading: true } : {})
}];
```

In `scripts/parsers/types.ts`:

```ts
export interface ValidationQuestion {
  id: string;
  question: string;
  type: 'multiple-choice' | 'text';
  options?: string[];
  correctAnswer: string;
  aiGrading?: boolean; // NEW
}
```

The auto-route for `regex` rule types is intentional: those rule types have been silently broken since the loader was written. Authors who explicitly chose `regex` (e.g. for "answer that matches this pattern") were getting plain string-equality grading, which is far stricter than they intended. Routing to the AI grader gives them what they originally wanted: "did the learner's answer match the spirit/structure of this pattern."

## CDS schema additions

```cds
// db/schema.cds
entity ValidateAnswerSubmissions : managed {
  key ID            : UUID;
  user              : Association to Users;
  tutorialSlug      : String(200) @mandatory;
  stepNumber        : Integer @mandatory;
  questionId        : String(40);              // 'validate-{stepNum}'
  questionText      : LargeString;             // captured for offline eval
  correctAnswer     : LargeString;             // captured for offline eval
  submittedAnswer   : LargeString @mandatory;
  verdict           : String(10);              // 'pass'|'partial'|'fail'|'error'
  summary           : LargeString;             // AI feedback (one sentence)
  hint              : LargeString;             // null on pass/fail; populated on partial
  modelName         : String(80);
  promptTokens      : Integer;
  completionTokens  : Integer;
  latencyMs         : Integer;
  errorReason       : String(200);
}

extend ChatSettings with {
  validateAnswerEnabled : Boolean default false;
}
```

`questionText` and `correctAnswer` are captured for offline grader-quality eval. The code-check spike's `CodeCheckSubmissions` table doesn't capture goal text and the omission has made eval clunkier; this avoids the same trap.

`@PersonalData` annotation in `db/audit-logging.cds`:

```cds
annotate ims.ValidateAnswerSubmissions with @PersonalData: {
  EntitySemantics: 'Other'
} {
  user            @PersonalData.FieldSemantics: 'DataSubjectID';
  submittedAnswer @PersonalData.IsPotentiallyPersonal;
};
```

Default `'null-personal'` cascade applies (PR #221's annotation walker handles this with no JS change).

## Prompt design

System prompt (lives in `srv/lib/validate-answer-prompt.js`, version-stamped):

```
You are a patient tutorial grader evaluating a learner's answer to a free-text
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
NEVER fabricate or invent additional context the question didn't include.
```

User-message structure (deterministic, ordered):

```
Question:
<question text>

Author's expected answer (DO NOT QUOTE — for your judgment only):
<correctAnswer>

Learner's answer:
<submittedAnswer>
```

No "step text" or "tutorial samples" sections — text-question grading doesn't benefit from broader tutorial context. Adds tokens for no measurable benefit. (This diverges from code-check which DOES include step context, because code grading benefits more from "what was the learner being taught when they wrote this code".)

Output schema:

```js
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

Smaller than code-check's schema (no `correctAspects` / `suggestions` arrays) because the input is smaller and the output is naturally simpler.

`PROMPT_VERSION = 'v1'` exported for telemetry-vintage tagging — same pattern as code-check.

## `dispatchValidateAnswer` core

`srv/lib/validate-answer-tool.js`. Mirrors the shape of `srv/lib/code-check-tool.js`:

```js
export async function dispatchValidateAnswer(input, deps) {
  // input: { tutorialSlug, stepNumber, questionId, submittedAnswer }
  // deps:  { user?, callModel, loadQuestion, db? }

  const startedAt = Date.now();
  const slug = (input.tutorialSlug ?? '').toLowerCase();
  const { ChatSettings, ValidateAnswerSubmissions } = cds.entities('com.sap.developers.ims');

  // 1. Flag check
  const settings = await SELECT.one.from(ChatSettings);
  if (!settings?.validateAnswerEnabled) {
    return persistError({ ...input, slug }, 'disabled', startedAt);
  }

  // 2. Load question via injected callback
  const question = await safeCall(deps.loadQuestion, slug, input.stepNumber, input.questionId);
  if (!question) return persistError({ ...input, slug }, 'question_missing', startedAt);
  if (!question.aiGrading) return persistError({ ...input, slug }, 'not_ai_graded', startedAt);

  // 3. Build prompt
  const system = buildSystemPrompt();
  const user = buildUserMessage({
    question: question.question,
    correctAnswer: question.correctAnswer,
    submittedAnswer: input.submittedAnswer
  });

  // 4. Call LLM
  let modelResp;
  try {
    modelResp = await deps.callModel({ system, user, schema: VALIDATE_ANSWER_OUTPUT_SCHEMA });
  } catch (err) {
    LOG.warn('validate-answer upstream failure', err.message);
    return persistError({ ...input, slug, question }, 'upstream', startedAt);
  }

  // 5. Validate verdict shape
  const verdict = modelResp.verdict;
  if (!verdict || !['pass', 'partial', 'fail'].includes(verdict.verdict)
      || typeof verdict.summary !== 'string') {
    return persistError({ ...input, slug, question }, 'schema', startedAt, modelResp);
  }

  // 6. Reference-leak redaction
  const safe = redactReferenceLeaks(verdict, question.correctAnswer);
  if (safe !== verdict) {
    LOG.warn('validate-answer reference leak redacted', { slug, stepNumber: input.stepNumber, questionId: input.questionId });
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
    promptTokens: modelResp.promptTokens,
    completionTokens: modelResp.completionTokens,
    latencyMs: Date.now() - startedAt
  });

  return safe;
}
```

`loadQuestion(slug, stepNumber, questionId)` is the injected callback that resolves a `ValidationQuestion`. The default implementation (production wiring) reads the parsed validation array from the same source as Hugo's `#tutorial-data` — the `Tutorials` entity's parsed-content blob OR a new lightweight DB cache table. The exact mechanism is plan-time detail; the contract is: returns `ValidationQuestion | null`.

`redactReferenceLeaks` is reused as-is from `srv/lib/code-check-prompt.js`. The 30-char window guard handles short answers (like 5-character crossword answers) by being a no-op when the reference is shorter than the window — that's the intended behavior.

`PROMPT_VERSION` is bumped on any prompt-semantics change so telemetry can be analyzed by vintage.

## Express endpoint

`POST /api/validate-answer`:

- XSUAA auth required (anonymous → 401)
- Body: `{ tutorialSlug: string, stepNumber: number, questionId: string, submittedAnswer: string }`
- `submittedAnswer` capped at 5 KB
- Per-user rate limit: 30 successful submissions / hour
- Per-(user, slug, step) rate limit: 5 / 5 min
- 503 when `validateAnswerEnabled` is false
- 200 returns the verdict object: `{ verdict, summary, hint? }`
- 429 with `Retry-After` header on rate breach
- 500 on unexpected errors (rate limit not incremented for 500s)

Implementation: `srv/lib/validate-answer-handler.js` follows the `makeCodeCheckHandler` factory pattern (handler factory takes `{ callModel, loadQuestion }` deps, mounts the rate limiter, returns the Express middleware). Wired in `srv/server.js` next to the `/api/codecheck` route.

## Frontend integration

In `Validation.vue` (built in #212), the submit handler branches:

```ts
async function onSubmit() {
  submitted.value = true;

  // Local-graded questions: synchronous client-side path (existing).
  const localQuestions = props.questions.filter(q => !q.aiGrading);
  const localResult = gradeAnswers(localQuestions, answers.value);

  // AI-graded questions: per-question fetch.
  const aiResults: Record<string, AiVerdict> = {};
  const aiQuestions = props.questions.filter(q => q.aiGrading);
  for (const q of aiQuestions) {
    try {
      const res = await fetch('/api/validate-answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tutorialSlug: props.slug,
          stepNumber: props.stepNumber,
          questionId: q.id,
          submittedAnswer: (answers.value[q.id] ?? '').trim()
        })
      });
      if (!res.ok) {
        aiResults[q.id] = { verdict: 'error', summary: 'Could not grade — try again.' };
      } else {
        aiResults[q.id] = await res.json();
      }
    } catch {
      aiResults[q.id] = { verdict: 'error', summary: 'Network error — try again.' };
    }
  }

  // Aggregate result.
  const allLocalCorrect = localResult.correct;
  const allAiPass = aiQuestions.every(q => aiResults[q.id]?.verdict === 'pass');
  const anyAiPartial = aiQuestions.some(q => aiResults[q.id]?.verdict === 'partial');
  const anyAiFail = aiQuestions.some(q => aiResults[q.id]?.verdict === 'fail' || aiResults[q.id]?.verdict === 'error');

  if (allLocalCorrect && allAiPass) {
    result.value = 'correct';
    writePersisted(props.slug, props.stepNumber, true);
  } else if (anyAiFail || !allLocalCorrect) {
    result.value = 'incorrect';
  } else if (anyAiPartial) {
    result.value = 'partial';
    // Per-question hints rendered inline; no localStorage write (re-submit allowed).
  }
}
```

UI rendering for the 3-state result:

- `pass` (correct) → `<ui5-message-strip design="Positive">` "Correct!"
- `partial` → `<ui5-message-strip design="Information">` per AI question, showing `summary` + `hint`. Submit button stays enabled — learner can refine and re-submit.
- `fail` (incorrect) → `<ui5-message-strip design="Negative">` "Not quite — give it another try."

Per-question feedback for AI-graded questions: render the `summary` string in a small `<ui5-message-strip>` adjacent to that question's input field. On `partial`, also render the `hint`.

## Testing

### Unit tests

- `test/unit/validate-answer-prompt.test.js` (~7 cases): system prompt mentions verdict scale; user message section ordering; absent sections cleanly omitted; output schema enforces verdict enum + maxLength constraints; reference-leak redaction guard works for short and long references.
- `test/unit/validate-answer-tool.test.js` (~7 cases): happy path persists row + tokens; question_missing path; not_ai_graded path; upstream LLM error; schema mismatch (still records token telemetry); reference leak redaction; codeCheckEnabled=false short-circuit (… actually `validateAnswerEnabled=false`); anonymous user → user_ID null.
- `test/unit/validate-answer-handler.test.js` (~13 cases, mirror of code-check-handler.test.js): body validation 4 sub-cases; auth 401; happy path 200; per-user rate limit 429; per-step rate limit 429; upstream-not-counted; disabled→503.
- `test/unit/rules-parser-grading.test.js` (~5 cases): explicit `###Grading: ai-judged` sets `aiGrading: true`; `regex` rule type sets `aiGrading: true` automatically; `regex-begins-with` sets `aiGrading: true` automatically; absence → `aiGrading: undefined`; case-insensitivity of `ai-judged` directive value.

### Hybrid test

`test/hybrid/validate-answer.test.js`. Verifies the `@PersonalData` cascade fires on `ValidateAnswerSubmissions` when a user is anonymized. Same `__TEST__cc-209-` prefix conventions as PR #221's hybrid test 4. Runs against deployed DEV via `npm run test:hybrid`.

### Smoke test

`test/smoke/validate-answer.test.js`. Verifies:
- 401 on unauthenticated POST.
- 503 when flag is off.
- 200 + verdict shape on a known seeded question (skip-gated on `SMOKE_VALIDATE_ANSWER_TOKEN` env var).

## Migration / Risk

**Low-medium risk.** The new endpoint is additive — no existing code path changes. The Vue island in #212 grew an optional async branch.

**Risk surfaces:**
- **Auto-route of `regex` rule types**: any tutorial with `###Rule: regex` or `regex-begins-with` automatically gets AI grading when the flag is on. This is a SILENT semantic change — those questions previously failed with plain string equality (and authors may have been working around the bug), and now they pass with AI judgment. Mitigation: spec is explicit about this; CLAUDE.md gotcha entry calls it out; rollout is gated by the `validateAnswerEnabled` flag (default false), so no surprise on first deploy.
- **AI grading nondeterminism**: same answer can grade differently across LLM runs. Mitigation: low temperature; deterministic prompt; offline eval harness will surface any high-variance cases. The spike's exit gate (≥80% author-rated agreement on pass-vs-fail) is the same shape as code-check.
- **Cost**: text-answer grading is cheap (~100-500 tokens per call). At 30/hr per user worst case, max ~$0.20/user/day at gpt-4o pricing — affordable.

**Roll-forward**: revert is one git commit. The flag stays false in production until evidence supports turning it on.

## Documentation Updates

- New developer-facing reference at `docs/developers/architecture/validate-answer.md` (~50 lines): how the cascade fires, how to add `###Grading` to a rules.vr block, the 3-state UI semantics, the regex auto-route behavior.
- CLAUDE.md gotcha section: append entry about `regex` rule type auto-routing to AI when `validateAnswerEnabled` is true.

## Acceptance Criteria

- [ ] Authors can opt a `[VALIDATE_N]` text question into AI grading via `###Grading: ai-judged` in `rules.vr`.
- [ ] `regex` and `regex-begins-with` rule types auto-route to AI grading when `validateAnswerEnabled: true`.
- [ ] `POST /api/validate-answer` (XSUAA) accepts `{tutorialSlug, stepNumber, questionId, submittedAnswer}` and returns `{verdict: 'pass'|'partial'|'fail', summary, hint?}`.
- [ ] `ChatSettings.validateAnswerEnabled` flag-gates the endpoint (503 when off).
- [ ] Per-user 30/hr + per-(user, slug, step) 5/5min rate limits.
- [ ] Submissions persist to `ValidateAnswerSubmissions` with full telemetry.
- [ ] `@PersonalData` cascade fires automatically (default `null-personal`) — verified in hybrid test.
- [ ] Existing exact-match path stays untouched for non-AI-graded text questions and all multiple-choice questions.
- [ ] Reference-leak redaction guard active.
- [ ] All unit tests pass (~32 cases across 4 test files).
- [ ] Smoke tests pass against deployed DEV.
- [ ] CLAUDE.md gotcha + developer doc shipped.

## Open Questions

None outstanding. All design decisions answered during the resumed-from-yesterday brainstorming session on 2026-06-04.

## Provenance

Resumed from yesterday's brainstorm-state document (`docs/superpowers/specs/.draft-2026-06-04-209-free-text-grader-brainstorm.md`). The 6 open questions in that draft were answered in the 2026-06-04 morning session; this finalised spec carries forward those decisions:

- Q1 (opt-in mechanism) → A: per-question `###Grading: ai-judged` directive
- Q2 (regex bug) → A: regex rule types auto-route to AI grader
- Q3 (capture telemetry) → A: capture both `questionText` and `correctAnswer`
- Q4 (hybrid test) → Yes: matching PR #221 pattern
- Q5 (frontend integration) → resolved by #212 (Vue island is the integration point)
- Q6 (partial verdict UI) → 3-state with hint on partial

The draft document at `docs/superpowers/specs/.draft-2026-06-04-209-free-text-grader-brainstorm.md` will be removed once this spec lands; its status note is updated to "superseded by 2026-06-04-209-free-text-grader-design.md".
