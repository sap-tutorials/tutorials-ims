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
 *
 * NOTE: verdict enum is exactly { pass, partial, fail } — there is NO
 * 'error' value here. 'error' is a server-side outcome injected by the
 * dispatch layer when the upstream LLM call fails, the spec is missing,
 * the feature flag is off, or the schema validation rejects the LLM
 * output. The model itself never emits 'error'.
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
      description: 'One sentence stating the verdict in plain language.'
    },
    hint: {
      type: 'string',
      maxLength: 250,
      description: 'One sentence of guidance toward the correct answer. Populate ONLY for partial.'
    }
  }
};
