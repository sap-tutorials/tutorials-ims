// srv/lib/validate-answer-prompt.js
//
// Pure module — no network, no DB.
// Mirrors srv/lib/code-check-prompt.js's shape with a smaller schema
// suited to free-text answer grading (no correctAspects/suggestions
// arrays — just verdict + summary + optional hint).
//
// PROMPT_VERSION is bumped on any prompt-semantics change so telemetry
// in ValidateAnswerSubmissions.promptVersion can be analyzed by vintage.
//
// v2 (2026-06-23) — Reported by Tom Jung: the grader was silently failing
// answers without explaining why, leaving learners with no path forward.
// Two semantic changes:
//   1. hint is REQUIRED on partial AND fail (was: only on partial). On
//      fail, the hint must be no-spoiler — surface the missing concept
//      without revealing the expected answer.
//   2. The verdict scale prefers PARTIAL over FAIL when the learner has
//      addressed PART of a multi-part question. (Was: "When uncertain
//      between partial and fail, prefer fail" — which was too strict for
//      compound questions like "explain X and describe how Y".)
// The redactReferenceLeaks layer downstream still catches accidental
// reference-answer leakage, so the no-spoiler-on-fail relaxation is safe.
//
// v3 (2026-09-16) — Reported by Daniel Wroblewski (#2348): the grader was
// too strict/pedantic. It read the author's expected answer as an exhaustive
// CHECKLIST — a learner who conveyed the core concept but omitted a minor
// supporting detail or illustrative example (the "turkey story", Scrooge's
// parental interest in Tiny Tim) got marked "partial". Semantic changes:
//   1. "pass" broadened: grade the IDEA, not the completeness of the
//      enumeration. Omitting examples/anecdotes/supporting specifics the
//      author merely mentioned is FINE when the core concept is present.
//   2. "partial" narrowed: reserved for missing a DISTINCT thing the
//      question explicitly asked for (a whole sub-question), or a
//      materially wrong/imprecise CORE term — not missing illustrative
//      detail.
// Pairs with a client change (#2348): a "partial" verdict now UNLOCKS step
// progression with an advisory hint rather than blocking + forcing retries
// (which risked exhausting the per-user LLM token/rate-limit budget).

export { redactReferenceLeaks } from './code-check-prompt.js';

export const PROMPT_VERSION = 'v3';

export function buildSystemPrompt() {
  return `You are a patient tutorial grader evaluating a learner's answer to a free-text
question in a software development tutorial. You receive the question, the
author's expected answer, and the learner's answer. Grade based on whether
the learner has demonstrated understanding of the concept the question targets
— not whether their answer is verbatim equal to the author's expected answer.

Verdict scale:
- "pass": the learner's answer captures the main idea(s) the question
  targets. Synonyms, paraphrases, alternate but valid terminology, and minor
  wording differences are FINE if they convey the same idea. Omitting minor
  supporting details, examples, or illustrative specifics that the author
  happened to mention is ALSO fine, as long as the core concept is clearly
  demonstrated. For multi-part questions, pass when the learner addresses the
  substance of each part the question asked for — not every incidental detail.
- "partial": the learner clearly missed one of the DISTINCT things the
  question explicitly asked for (a whole sub-question left unanswered), OR
  has the right general idea but a materially wrong or imprecise CORE term
  that should be tightened. Do NOT use partial merely because the learner
  left out an example, anecdote, or supporting detail — that is a pass.
- "fail": the answer addresses a different concept, is wrong, or is empty.

Grade the idea, not the completeness of the enumeration. Do not penalize for
omitting examples, anecdotes, or supporting details that merely illustrate a
concept the learner already conveyed.

When uncertain between pass and partial, prefer PASS.
When uncertain between partial and fail, prefer PARTIAL if the learner
has any correct material at all — compound questions (e.g. "explain X
AND describe how Y") deserve partial credit when the learner has X but
not Y. Only choose fail when nothing in the learner's answer is correct.

Output JSON: { verdict, summary, hint }
- summary: ONE sentence stating the grade in plain language, naming WHICH
  part of the question was satisfied (for partial) or WHICH concept the
  learner appears to be confused about (for fail).
- hint: ONE sentence of guidance toward the correct answer. REQUIRED on
  partial AND fail. On pass, leave empty or omit. On partial, point at the
  missing-but-required part of the question. On fail, point at the concept
  the question is actually asking about, WITHOUT revealing the expected
  answer's wording.

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
 *
 * NOTE: verdict enum is exactly { pass, partial, fail } — there is NO
 * 'error' value here. 'error' is a server-side outcome injected by the
 * dispatch layer when the upstream LLM call fails, the spec is missing,
 * the feature flag is off, or the schema validation rejects the LLM
 * output. The model itself never emits 'error'.
 *
 * v2 schema note: hint is now expected to be populated on partial AND
 * fail (was: partial only). The schema keeps hint as a non-required
 * optional string — the dispatch layer treats a missing hint on
 * partial/fail as a graceful degradation, not a validation error.
 */
export const VALIDATE_ANSWER_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['pass', 'partial', 'fail'],
      description: 'Overall assessment of the learner\'s answer.'
    },
    summary: {
      type: 'string',
      maxLength: 300,
      description: 'One sentence stating the verdict in plain language, naming which part of the question was satisfied (partial) or which concept the learner is confused about (fail).'
    },
    hint: {
      type: 'string',
      maxLength: 250,
      description: 'One sentence of guidance toward the correct answer. Required on partial AND fail (no-spoiler — point at the missing part or relevant concept). Empty/omitted on pass.'
    }
  }
};
