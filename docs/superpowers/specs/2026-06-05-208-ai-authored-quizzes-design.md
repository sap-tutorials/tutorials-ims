# AI-Authored Quizzes — Design Spec

**Status:** Draft for review
**Tracking issue:** [sap-tutorials/tutorials-ims#208](https://github.com/sap-tutorials/tutorials-ims/issues/208)
**Date:** 2026-06-05
**Author:** Tom Jung (with Claude)

## Summary

Build a build-time generator that, on author opt-in, produces `[VALIDATE_N]` candidate questions for tutorial steps that don't already have hand-authored ones. AI generation is gated by a new `[AUTOAUTHOR_*]` directive in `rules.vr`, runs as a post-parse expansion step in `scripts/fetch-tutorials.ts`, and emits the same `ValidationQuestion` shape the existing parser produces — so AI-authored questions are indistinguishable from hand-authored ones at the consumer end. A standalone CLI evaluation harness mirrors PR #205's pattern: an author runs the script against 5–10 pilot tutorials, hand-grades a CSV, and the would-ship rate drives a graduate / iterate / shelve decision.

This is the third sub-capability from issue #171's original vision (after PR #205's AI code-check and PR #234's AI free-text grader). Both preconditions named in #208 — the client-side validation widget (PR #226) and the AI free-text grader (PR #234) — are now shipped, so this becomes the next-logical capability.

## Goals

1. **Author opt-in, parser-driven.** Authors get a single new directive (`[AUTOAUTHOR_N]` per step or `[AUTOAUTHOR_ALL]` per tutorial, optionally with `:mcq` / `:text` type suffixes) that triggers AI generation for steps lacking hand-authored `[VALIDATE_N]` blocks. Hand-authored content always wins.
2. **Indistinguishable downstream.** AI-authored questions emit the same `ValidationQuestion` shape — they flow through the same Hugo frontmatter, the same `<script id="tutorial-data">` JSON, the same Vue 3 validation widget, the same `aiGrading: true`-routed `/api/validate-answer` endpoint at submission. New consumers don't need to know they're AI-authored.
3. **Bounded build cost.** Default-OFF behind `AI_AUTHOR_ENABLED=true`. Per-tutorial content-hash cache means re-running `fetch-tutorials` against unchanged steps costs zero LLM calls. Hard cap (default 200 calls per build) prevents runaway spend on a first-time bulk generation.
4. **Spike-bounded evaluation.** Quantitative graduate / iterate / shelve gate based on author-rated would-ship rate from a CSV harness. Not a permanent shipment until evidence supports it.

## Non-Goals

- **Web UI for authors to accept/reject AI questions.** Out of scope for first iteration. Authors are GitHub-fluent ([[feedback_author_self_service]]); CSV workflow fits their tooling.
- **Multi-language variants.** Tutorials are English-only ([[project_developers_locales]]); generating other languages is a different problem.
- **RAG-over-related-steps.** Deferred to the "Iterate" path if the spike lands at 50–74% would-ship rate.
- **Hot-loop authoring tools** (e.g. browser tile that lets an author one-click-publish accepted AI questions). Out of scope; the issue explicitly defers this.
- **Server-side persistence of AI-authored questions distinct from hand-authored.** The cache is a build artifact; the public emission shape is the same as hand-authored content. The `aiAuthored: true` telemetry field is the only join key into the eval harness.

## Approach

**Approach B from brainstorming: post-parse pipeline step.**

The parser (`parseRulesVrEnriched` in `scripts/parsers/rules.ts`) recognizes `[AUTOAUTHOR_*]` directives and emits sentinel `ValidationQuestion` placeholders with a magic `__autoauthor: true` field. A new post-parse step in `scripts/fetch-tutorials.ts` walks the placeholders, calls the LLM (via injected `callModel` dep), validates the response, and swaps real questions in for the placeholders. The parser stays synchronous; existing parser tests + call sites are untouched.

Two approaches considered and rejected:

- **A — Generation inside the parser.** Would make `parseRulesVrEnriched` async, rippling through ~8 existing test fixtures + call sites. The single-pass purity wasn't worth the refactor cost.
- **C — Pre-parser text munging.** Generator splices synthetic `[VALIDATE_N]` blocks into the raw `rules.vr` text before parsing. Brittle: the generator has to produce valid rules.vr syntax, and any parser-syntax evolution silently produces invalid input.

## Architecture

```
.tutorial-cache/<slug>.rules.vr        (existing — input)
        ↓
parseRulesVrEnriched()                 (existing, modified to recognize [AUTOAUTHOR_*])
        ↓
ValidationQuestion[] with placeholder  (sentinels marked __autoauthor: true)
        ↓
expandAiAuthoredQuestions()            (NEW — post-parse step in fetch-tutorials.ts)
        ↓
ValidationQuestion[] with real         (LLM-generated questions swapped in)
        ↓
Hugo frontmatter + <script id="tutorial-data"> JSON
        ↓
hugo-apps/src/validation/Validation.vue (existing — handles MCQ + text + AI grading)
```

### New modules

| File | Responsibility |
|------|---------------|
| `srv/lib/ai-quiz-generator.js` | Pure LLM-call module: `generateQuiz({ stepBody, stepNumber, slug, types, deps })` → `{ questions, errorReason?, modelName, promptTokens, completionTokens, latencyMs }`. Builds the system prompt, builds the user message, calls the forced-tool-call SDK, validates the response, applies anti-leak guards. Mirrors `srv/lib/validate-answer-prompt.js` shape. Pure (no I/O beyond the injected `callModel`); unit-testable with mock `callModel`. |
| `scripts/lib/ai-quiz-cache.ts` | Content-hash cache over per-tutorial sidecar files at `.tutorial-cache/<slug>.ai-quiz-cache.json`. Functions: `loadAiQuizCache(slug)`, `saveAiQuizCache(slug, cache)`, plus `cache.get(stepHash)` / `cache.put(stepHash, entry)`. Hash key is `sha256(stepBody + directive + types + PROMPT_VERSION + modelName)`. |
| `scripts/lib/expand-ai-authored.ts` | The post-parse expansion step. `expandAiAuthoredQuestions(parsedMap, stepBodies, deps)` walks placeholders in the parsed map, consults cache, calls generator on miss, mutates parsedMap to replace placeholders with real questions. Honors hard cap. Emits one-line build summary. |

### Existing modules touched

| File | Change |
|------|--------|
| `scripts/parsers/rules.ts` | Recognize `[AUTOAUTHOR_N]`, `[AUTOAUTHOR_N:mcq]`, `[AUTOAUTHOR_N:text]`, `[AUTOAUTHOR_ALL]`, `[AUTOAUTHOR_ALL:mcq]`, `[AUTOAUTHOR_ALL:text]` directives. Emit sentinel `ValidationQuestion` with `__autoauthor: true`, `id: 'autoauthor-${stepNum}'`, plus `__directiveTypes` (`'mcq-only' \| 'text-only' \| 'mcq-and-text'`). Hand-authored `[VALIDATE_N]` always wins on a step that has both — the placeholder for that step is suppressed. |
| `scripts/parsers/types.ts` | Add `aiAuthored?: boolean` (telemetry — set on emitted questions, ships in public frontmatter for MCQ + sidecar for text). The internal `__autoauthor`/`__directiveTypes` fields are NOT exported in the type — they're internal placeholder shape, removed before emission. |
| `scripts/fetch-tutorials.ts` | Wire `expandAiAuthoredQuestions()` between `parseRulesVrEnriched()` and the existing codecheck-sidecar / validate-answer-sidecar emission (around lines 660–680). Behind `AI_AUTHOR_ENABLED === 'true'` env check. |
| `package.json` | New script: `"seed-ai-quizzes": "AI_AUTHOR_ENABLED=true AI_AUTHOR_BUILD_CAP=10000 npm run fetch-tutorials"`. |

## The `[AUTOAUTHOR_*]` directive

### Syntax

```
[AUTOAUTHOR_3]            → MCQ + text mix for step 3 (default)
[AUTOAUTHOR_3:mcq]        → MCQ-only for step 3
[AUTOAUTHOR_3:text]       → text-only for step 3
[AUTOAUTHOR_ALL]          → mix, every step missing [VALIDATE_N]
[AUTOAUTHOR_ALL:mcq]      → MCQ-only, every gap
[AUTOAUTHOR_ALL:text]     → text-only, every gap
```

The type suffix is optional; default (no suffix) is `mcq-and-text`. Authors who know their step is fact-recall (`mcq`) vs explanation (`text`) can bias the output.

### Precedence

| Step has `[VALIDATE_N]` | Step has `[AUTOAUTHOR_N]` | `[AUTOAUTHOR_ALL]` | Outcome |
|---|---|---|---|
| Yes | (any) | (any) | Hand-authored content. AUTOAUTHOR ignored. |
| No | Yes | (any) | AUTOAUTHOR_N wins. The per-step type suffix is used. |
| No | No | Yes | AUTOAUTHOR_ALL applies. Type suffix from ALL is used. |
| No | No | No | No questions for this step (current behavior). |

This precedence is enforced by the parser before the post-parse step ever sees the placeholders, so `expandAiAuthoredQuestions` only ever encounters one placeholder per step.

### Fallthrough behavior

If `AI_AUTHOR_ENABLED !== 'true'`, the parser still recognizes `[AUTOAUTHOR_*]` directives and emits placeholders, but `fetch-tutorials.ts` skips the expansion step entirely. Placeholders never make it to frontmatter — the parser's emission helper drops sentinel entries when serializing for Hugo. Net effect: a step with only `[AUTOAUTHOR_N]` and the flag off emits zero questions, identical to a step with no validation rules at all.

## LLM prompt + schema

### Inputs to `generateQuiz()`

```js
generateQuiz({
  stepBody,    // string — markdown body of one step (capped at 4000 chars)
  stepNumber,  // number — for the questionId emit
  slug,        // string — tutorial slug (for logging + cache key)
  types,       // 'mcq-only' | 'text-only' | 'mcq-and-text'
  deps: { callModel }  // dependency-injected for tests
})
```

Returns:

```ts
{
  questions: ValidationQuestion[],  // empty on error
  errorReason?: string,             // 'mcq_correct_not_in_options' | 'leak_detected' | 'upstream' | 'schema'
  modelName: string,
  promptTokens: number,
  completionTokens: number,
  latencyMs: number,
  promptVersion: 'v1'
}
```

### System prompt (fixed)

```
You are an SAP tutorial author writing comprehension-check questions
about a single tutorial step. Generate questions that test whether a
learner understood the step's main idea — not whether they memorized
exact wording.

Output rules:
- 1 to 3 questions per call. Pick the smallest set that covers the
  step's distinct learnings.
- Multiple-choice questions must have exactly 4 options, exactly 1
  correct. Wrong options must be plausible (not obvious filler).
- Text questions must accept a 1-3 sentence answer. Phrase the
  question to elicit explanation, not single-word recall.
- Never reference "the step" or "the tutorial" or "as shown above" —
  questions must read standalone.
- Never quote the step body verbatim in a question. Paraphrase.
- ANTI-LEAK: never reveal the correct answer's literal wording inside
  the question text.
```

`PROMPT_VERSION = 'v1'` — captured into the cache + telemetry so future runs can tell when a prompt change invalidated cached output.

### User message (per call)

```
TUTORIAL STEP CONTENT (markdown):
<stepBody, capped at 4000 chars>

REQUEST:
Generate <types> question(s) about the main learning of this step.
```

`<types>` interpolates as `multiple-choice`, `free-text`, or `multiple-choice and free-text`.

### Forced tool-call output schema

```js
{
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
                items: { type: 'string', maxLength: 200 }
              },
              correctAnswer: { type: 'string', maxLength: 200 }
            }
          },
          {
            type: 'object',
            required: ['type', 'question', 'correctAnswer'],
            additionalProperties: false,
            properties: {
              type: { const: 'text' },
              question: { type: 'string', maxLength: 400 },
              correctAnswer: { type: 'string', maxLength: 1000 }
            }
          }
        ]
      }
    }
  }
}
```

### Post-LLM validation

After `callModel` returns, `ai-quiz-generator.js` runs three checks beyond the schema:

1. **MCQ correctness consistency.** Each MCQ's `correctAnswer` must equal exactly one of `options` (string equality after trim). On mismatch: return empty `questions` with `errorReason: 'mcq_correct_not_in_options'`. Don't try to repair.
2. **Anti-leak guard.** For each question, check that `correctAnswer`'s normalized text doesn't appear inside the `question` text. Mirrors `redactReferenceLeaks` in `srv/lib/code-check-prompt.js` — same algorithm, same normalization (lowercase + collapse whitespace). On leak: return empty `questions` with `errorReason: 'leak_detected'`. The author who runs the eval CSV will see the cache miss + the warning in the build log.
3. **Conversion to `ValidationQuestion`.** Map the LLM output to the existing parser shape:

```ts
// MCQ
{
  id: `validate-${stepNumber}-ai-${index}`,
  question: llmQ.question,
  type: 'multiple-choice',
  options: llmQ.options,
  correctAnswer: llmQ.correctAnswer,
  aiAuthored: true
}

// Text
{
  id: `validate-${stepNumber}-ai-${index}`,
  question: llmQ.question,
  type: 'text',
  // correctAnswer omitted from public emission per #234 anti-leak strip;
  // lives in the cache only, then ships server-side via ValidateAnswerSpecs.
  aiGrading: true,
  aiAuthored: true
}
```

The `id` shape `validate-<step>-ai-<index>` distinguishes from hand-authored `validate-<step>` IDs. Eval harness joins on this prefix.

## Anti-leak posture

| Question type | `correctAnswer` location | Rationale |
|---|---|---|
| AI-authored MCQ | Public Hugo frontmatter (same as hand-authored MCQ) | MCQ grading is client-side equality (PR #226). Reference must be on the wire for the widget to grade. Consistent with existing `[VALIDATE_N]` MCQ posture. |
| AI-authored text | Stripped from public emission; stored in `.tutorial-cache/<slug>.ai-quiz-cache.json` (build-time only) and uploaded to `ValidateAnswerSpecs` HANA entity (per existing `validate-answer-spec-publish` route) | Server-side AI grading per #234. Same anti-leak as hand-authored text questions with `###Grading: ai-judged`. |

The publish path for AI-authored text questions reuses #234's existing `expandAiAuthoredQuestions` runs BEFORE the existing `collectAiGradedSpecs` step, so AI-authored text questions naturally flow into the same `<slug>.validate-answer.json` sidecar that already gets published to `ValidateAnswerSpecs`. No new publish endpoint needed.

## Cache

### File: `.tutorial-cache/<slug>.ai-quiz-cache.json` (gitignored)

Per-tutorial sidecar — sibling to existing `<slug>.codecheck.json`, `<slug>.validate-answer.json`. Keeps cache invalidation simple: deleting `.tutorial-cache/<slug>.*` re-fetches one tutorial; deleting the whole dir re-fetches everything. Single-slug `rebuild-content.yml` runs (the workflow Tom uses for one-tutorial refreshes) get correct invalidation for free.

### Shape

```json
{
  "promptVersion": "v1",
  "modelName": "gpt-4o",
  "entries": {
    "3": {
      "stepHash": "sha256:abc123...",
      "directive": "[AUTOAUTHOR_3]",
      "types": "mcq-and-text",
      "generatedAt": "2026-06-05T18:30:00Z",
      "questions": [
        { "id": "validate-3-ai-1", "type": "multiple-choice", "question": "...", "options": [...], "correctAnswer": "...", "aiAuthored": true },
        { "id": "validate-3-ai-2", "type": "text", "question": "...", "correctAnswer": "...", "aiGrading": true, "aiAuthored": true }
      ]
    }
  }
}
```

### Hash key

```ts
sha256(`${stepBody} ${directive} ${types} ${PROMPT_VERSION} ${modelName}`)
```

NUL separators avoid concatenation collisions (e.g. step body ending with `[AUTOAUTHOR_3]`-like text). Any change to step content, directive, type suffix, prompt vintage, or model invalidates the entry → cache miss → LLM call → new entry written.

### Cache hit/miss summary line

`expandAiAuthoredQuestions` emits one line at the end of build:

```
[ai-author] expanded 47 [AUTOAUTHOR_*] directives across 12 tutorials: 8 cache miss (LLM call), 39 cache hit, 0 errors. Build cap: 200 (used 8).
```

Operators read this in CI logs to know what the build paid for. A deeper per-slug breakdown is available with `LOG_LEVEL=debug`.

## Hard cap

```ts
const HARD_CAP = parseInt(process.env.AI_AUTHOR_BUILD_CAP ?? '200', 10);
let calls = 0;

for (const placeholder of placeholders) {
  if (calls >= HARD_CAP) {
    log.warn(`[ai-author] hit hard cap ${HARD_CAP}; skipping ${placeholder.slug} step ${placeholder.stepNumber}`);
    continue;  // drop the placeholder; emit no questions for this step
  }
  // ... cache check + (on miss) generate + record ...
}
```

**"Drop, don't fail" rationale:** First-time bulk generation needs to be predictable. With ~1400 tutorials, a few authors opting in via `[AUTOAUTHOR_ALL]` could easily exceed any sane cap. Dropping over-cap keeps the build green; the warning log + cache stats line tells the operator to bump the cap or run the bulk-seed script.

The over-cap step's frontmatter gets `validation: []` — same as a hand-authored block with no questions. The validation widget renders nothing for that step; the rest of the tutorial is unaffected.

## Bulk-seed escape hatch

```json
"scripts": {
  "seed-ai-quizzes": "AI_AUTHOR_ENABLED=true AI_AUTHOR_BUILD_CAP=10000 npm run fetch-tutorials"
}
```

Run once after merging the feature, before turning the flag on in CI. Populates per-tutorial caches from cold; subsequent CI runs hit the cache.

For the spike's pilot phase, the operator runs this against just the pilot tutorials by setting `TUTORIAL_SLUG=...` — the existing single-slug fetch convention already supported by `rebuild-content.yml`.

## Build wiring (in `fetch-tutorials.ts`)

Single new section, slotted between `parseRulesVrEnriched` (~line 660) and the existing codecheck-sidecar write (~line 685):

```ts
const parsed = parseRulesVrEnriched(rulesContent);

// [#208] AI-authored quiz expansion. Behind AI_AUTHOR_ENABLED env flag;
// hard-capped at AI_AUTHOR_BUILD_CAP per build. Cache lives at
// .tutorial-cache/<slug>.ai-quiz-cache.json. See:
// docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md
if (process.env.AI_AUTHOR_ENABLED === 'true') {
  const aiCache = await loadAiQuizCache(t.slug);
  await expandAiAuthoredQuestions(parsed, stepBodies, {
    cache: aiCache,
    callModel: defaultCallModel,
    onCallStats: globalCallStats  // accumulates across tutorials
  });
  await saveAiQuizCache(t.slug, aiCache);
}

// existing codecheck-sidecar + validate-answer-sidecar emission unchanged
```

The caller doesn't need to know about placeholders — `expandAiAuthoredQuestions` mutates `parsed.map` in place. After this block, the rest of `fetch-tutorials.ts` runs unchanged. AI-authored text questions naturally flow into the existing `<slug>.validate-answer.json` sidecar via `collectAiGradedSpecs` (since they have `aiGrading: true`).

## Evaluation harness

### `scripts/evaluate-ai-quizzes.ts`

**Inputs (CLI flags):**
- `--slugs <comma-separated>` (required) — pilot tutorials chosen by the operator.
- `--output <path>` (required) — CSV output path.
- `--types <mcq|text|both>` (optional, default `both`).

**Pre-conditions:** `.tutorial-cache/<slug>.ai-quiz-cache.json` must already be populated for each pilot slug. The eval script does NOT call the LLM — it reads what `seed-ai-quizzes` wrote. This makes the eval reproducible and free.

**What it does:**
1. For each slug, load the AI cache + the same slug's `.tutorial-cache/<slug>.rules.vr` (re-runs `parseRulesVrEnriched` — without expansion — to extract hand-authored questions).
2. For each step that has BOTH hand-authored AND AI-authored questions: emit one CSV row per question, paired by step.

**CSV output shape:**

```csv
slug,stepNumber,source,questionType,question,correctAnswer,options,authorWouldShip,authorNotes
cap-getting-started,3,hand-authored,multiple-choice,"What does cds.connect.to do?","Connects to a service at runtime","Option A | Option B | ...",,
cap-getting-started,3,ai-authored,multiple-choice,"Which CDS API connects to a runtime service?","cds.connect.to","cds.connect.to | cds.requires | cds.entities | cds.serve",,
cap-getting-started,3,ai-authored,text,"Explain the difference between cds.connect.to and cds.requires","cds.connect.to is a runtime call; cds.requires is a declaration",,,
```

The author fills in:
- `authorWouldShip`: `yes` / `no` / `maybe`
- `authorNotes`: free-text reasons (optional, valuable for failure-mode analysis)

### `scripts/aggregate-ai-quiz-eval.ts`

Reads filled CSVs (one or many — supports glob), computes:

```
=== AI-authored quiz evaluation ===
Tutorials evaluated: 8
Steps with both hand+AI: 47
AI questions reviewed: 94 (52 MCQ, 42 text)

By type:
  MCQ:   38 / 52 marked "yes" → 73% would-ship
  Text:  18 / 42 marked "yes" → 43% would-ship

Overall: 56 / 94 → 60% would-ship rate

Most-common rejection notes (text frequency):
  - "answer too vague" (12)
  - "wrong on a fact" (8)
  - "duplicates earlier question" (5)
  - "not testing the main learning" (5)
```

Rejection-note frequencies use simple substring tokenization (lowercase + split on punctuation + count); good-enough heuristic for an N=94 sample. Inter-rater reliability formalism (κ scores, bootstrap CIs) is explicitly out of scope.

## Spike exit criteria

Borrowing the threshold structure from #210's eval framework:

| Outcome | Would-ship rate | Action |
|---|---|---|
| **Graduate** | ≥75% overall (with MCQ ≥80%, text ≥60% as floors) | Propose first-class shipment: keep the flag, document author opt-in in tutorial-authoring guide, add to QA author preview, file follow-ups for the rejection-note patterns. |
| **Iterate** | 50–74% overall | Treat as Approach-1 baseline. Try a stronger prompt (chain-of-thought, more example tutorials) or RAG over related steps for context. Re-run eval. Bump `PROMPT_VERSION` to `v2` to invalidate the cache. |
| **Shelve** | <50% overall | Spike negative; close without graduation. Retain code behind `AI_AUTHOR_ENABLED=false` for future revisit. Document in the spike write-up why the approach didn't land. |

The MCQ-vs-text floors handle the genuine asymmetry — MCQ generation is much easier for an LLM than authoring fair-but-non-trivial free-text questions. If MCQ is great and text is mediocre, **graduate MCQ-only and iterate on text** rather than shelving everything.

## Operator runbook

The runbook section the README/docs gets (copied verbatim into `docs/developers/architecture/ai-authored-quizzes.md`):

1. Merge the feature; env stays default-OFF.
2. Flip `AI_AUTHOR_ENABLED=true` on a local dev shell.
3. Pick 5–10 pilot slugs covering the topic surface (ABAP, CAP, Fiori, etc).
4. Add `[AUTOAUTHOR_*]` directives to those slugs' `-Contribution` `rules.vr` files via PRs to those repos. Mix per-step + tutorial-wide directives across the pilot to cover both syntaxes.
5. Run `npm run seed-ai-quizzes` locally to populate caches. Watch the build summary line for cache misses + cost.
6. Run `npx tsx scripts/evaluate-ai-quizzes.ts --slugs <comma-list> --output verdicts/ai-quiz-eval.csv`.
7. Authors hand-grade the CSV (1 author for fast feedback, 2–3 for inter-rater feel — not formalized).
8. Run `npx tsx scripts/aggregate-ai-quiz-eval.ts <csv-glob>` for the report.
9. Apply the threshold table → graduate / iterate / shelve.

## Cost estimates

### Per-call

- Input: ~1.5 KB system + 4 KB step body + ~300 B request overhead ≈ ~1500 tokens.
- Output: forced tool-call JSON, ~300–800 tokens.
- Per-call: ~0.005–0.012 USD on the SDK's default model.

### Per-build

- Hard cap default 200 calls × 0.012 USD ≈ **2.40 USD per first-time bulk generation**.
- Subsequent builds: cache hits, near-zero cost. A typical step-content edit re-pays one call (one cache miss for that step).

### Per-pilot-tutorial (full tutorial-wide opt-in)

- Average ~5 steps per tutorial × 1 call per step = 5 calls × 0.012 = **~$0.06 per tutorial bulk-seed**.
- A 10-tutorial pilot ≈ **$0.60 first-time cost**, then near-zero on re-runs.

## Test plan

Following the project's TDD discipline + the patterns established by #209:

### Unit tests

- `srv/lib/__tests__/ai-quiz-generator.test.js` — pure module test with mock `callModel`. Cases:
  - Happy MCQ + text mix returns valid `ValidationQuestion[]`.
  - MCQ with `correctAnswer` not in `options` → empty + `errorReason: 'mcq_correct_not_in_options'`.
  - Question text containing literal `correctAnswer` → empty + `errorReason: 'leak_detected'`.
  - `callModel` throws → empty + `errorReason: 'upstream'`.
  - Schema validation failure → empty + `errorReason: 'schema'`.
  - `types: 'mcq-only'` includes `multiple-choice` only in user message.
  - `types: 'text-only'` includes `free-text` only in user message.
  - `aiAuthored: true` set on every emitted question.
  - Text question's emit omits `correctAnswer` and sets `aiGrading: true`.
  - MCQ's emit retains `correctAnswer` and does NOT set `aiGrading`.
- `scripts/__tests__/ai-quiz-cache.test.ts` — cache helpers. Cases:
  - Round-trip: write + read returns equal entry.
  - `loadAiQuizCache` returns empty cache when file missing.
  - Hash key changes when any input changes (step body, directive, types, promptVersion, modelName).
  - Saving handles directory missing (creates `.tutorial-cache/`).
- `scripts/__tests__/expand-ai-authored.test.ts` — placeholder expansion. Cases:
  - Cache hit: no `callModel` invocation; questions swapped from cache.
  - Cache miss: `callModel` called once; new entry written; questions swapped.
  - Hard cap reached: subsequent placeholders dropped; warning logged; not failed.
  - Generator errorReason → placeholder dropped; build continues.
  - `__autoauthor` and `__directiveTypes` sentinel fields stripped from emitted questions.
  - Cache miss count + hit count accumulate correctly.
- `scripts/parsers/__tests__/rules-autoauthor.test.ts` — directive parser. Cases:
  - `[AUTOAUTHOR_3]` → placeholder for step 3 with `types: 'mcq-and-text'`.
  - `[AUTOAUTHOR_3:mcq]` → `types: 'mcq-only'`.
  - `[AUTOAUTHOR_3:text]` → `types: 'text-only'`.
  - `[AUTOAUTHOR_ALL]` → placeholders for every step that has no `[VALIDATE_N]`.
  - `[AUTOAUTHOR_ALL:mcq]` + per-step `[AUTOAUTHOR_3:text]` → step 3 honors `text`, others honor `mcq`.
  - Step has both `[VALIDATE_3]` and `[AUTOAUTHOR_3]` → `[VALIDATE_3]` wins; no placeholder emitted.

### Integration tests

- A single integration test in `test/integration/ai-quiz-flow.test.ts` exercises the full chain:
  - Synthetic `rules.vr` with `[AUTOAUTHOR_ALL]` + 3 steps.
  - Mock `callModel` returns a known fixture.
  - `expandAiAuthoredQuestions` is called with the parsed map.
  - Resulting frontmatter contains 3 steps × ~2 questions each, all `aiAuthored: true`.
  - Cache file is written to a tmp dir.
  - Re-running with the same inputs hits the cache (mock `callModel` not called).

### Hybrid + smoke

No hybrid HANA test needed — generation runs build-time only, no DB writes. The text questions flow through #234's existing `validate-answer-spec-publish` path which is already covered by `test/hybrid/validate-answer.test.js`.

No smoke test needed — `evaluate-ai-quizzes.ts` is a local CLI, not an HTTP endpoint.

## Documentation

- New developer-reference doc: `docs/developers/architecture/ai-authored-quizzes.md` — flow diagram + directive syntax + operator runbook + cost table + spike exit criteria. Sidebar registration in `docs/.vitepress/config.ts`.
- `CLAUDE.md` Gotchas section: one new entry — `AI_AUTHOR_ENABLED` flag + cap + cache invalidation rules.
- `docs/authors/writing-tutorials.md` (if it exists): brief mention of `[AUTOAUTHOR_*]` syntax with a pointer to the developer doc. Audience guidance: "use after the spike graduates; don't ship `[AUTOAUTHOR_*]` to production tutorials until then."

## Risk + roll-forward

**Low risk.** The feature is default-OFF. Even with the flag on, AI-authored content only appears for steps an author explicitly opted into via `[AUTOAUTHOR_*]`. No existing tutorial content changes shape. Roll-forward = revert one PR.

**Privacy:** Step bodies sent to the LLM are public tutorial content (already on `developers.sap.com`). No PII. No author-private rules.vr content is sent — the prompt only sees `stepBody` (parsed markdown), not the surrounding `[VALIDATE_N]` blocks.

**Cost:** Hard-capped at 200 calls / build by default; bumpable via env. Operator runbook documents the bulk-seed pattern. CI builds hit cache after first seed.

## Open questions

None outstanding. All decisions answered during brainstorming:
- Storage: inline `[AUTOAUTHOR_*]` in rules.vr (Q1).
- Question types: MCQ + text mix (Q2).
- Opt-in: per-step + tutorial-wide both supported (Q3).
- Eval: standalone CLI harness (Q4).
- Cost posture: flag-gated default OFF + content-hash cache + hard cap (Q5).
- Architecture: post-parse pipeline step (Q6).

## Acceptance criteria

- [ ] `[AUTOAUTHOR_*]` parser support in `scripts/parsers/rules.ts` + per-step + tutorial-wide + type-suffix variants.
- [ ] `srv/lib/ai-quiz-generator.js` with the schema + 3 anti-leak guards + 10+ unit tests.
- [ ] `scripts/lib/ai-quiz-cache.ts` with content-hash invalidation + 4 unit tests.
- [ ] `scripts/lib/expand-ai-authored.ts` with cap enforcement + 6 unit tests.
- [ ] `fetch-tutorials.ts` wired with `AI_AUTHOR_ENABLED` gate.
- [ ] `npm run seed-ai-quizzes` script.
- [ ] Integration test: synthetic rules.vr → expanded frontmatter → re-run hits cache.
- [ ] `scripts/evaluate-ai-quizzes.ts` emits CSV per the shape in the harness section.
- [ ] `scripts/aggregate-ai-quiz-eval.ts` reads filled CSVs and prints the report.
- [ ] Developer doc shipped + sidebar registered + `predocs:build` passes.
- [ ] `CLAUDE.md` Gotchas updated.
- [ ] No behavior change with the flag off (parser recognizes directives but emits zero questions; existing tutorials unchanged).
- [ ] Build cap default 200, configurable via `AI_AUTHOR_BUILD_CAP` env var.

## Related

- [[project_171_ai_code_check_shipped]] — PR #205, the spike this mirrors.
- [[project_212_validation_widget_shipped]] — PR #226, the validation widget AI-authored questions render in.
- [[project_209_freetext_grader_shipped]] — PR #234, the AI grader AI-authored text questions submit through.
- Issue #210 — Phase 4 evaluation framework for #205 (the threshold-table pattern this spec borrows).
