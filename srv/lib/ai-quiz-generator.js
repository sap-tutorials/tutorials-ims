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
import { QUESTION_TYPE_TEXT } from '../../scripts/parsers/types.js';

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
        type: QUESTION_TYPE_TEXT,
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
