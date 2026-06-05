// srv/lib/validate-answer-tool.js
//
// Core dispatch function for the AI free-text grader (issue #209).
// LLM caller and question loader are injected so unit tests run without
// network or HANA — see test/unit/validate-answer-tool.test.js.
//
// Mirrors srv/lib/code-check-tool.js's dispatchCheckCode shape from PR #205,
// with smaller payload (no step-text or tutorial-samples sections — text-
// question grading doesn't need broader tutorial context).

import cds from '@sap/cds';
import {
  PROMPT_VERSION,
  buildSystemPrompt,
  buildUserMessage,
  VALIDATE_ANSWER_OUTPUT_SCHEMA,
  redactReferenceLeaks,
} from './validate-answer-prompt.js';

const LOG = cds.log('validate-answer');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve user_ID FK value from the deps.user object.
 * Returns null for anonymous / missing users.
 */
function resolveUserId(user) {
  if (user && user.id && user.id !== 'anonymous') return user.id;
  return null;
}

/**
 * Persist an error row to ValidateAnswerSubmissions, then return the
 * verdict-shape error response.
 *
 * Called on every non-happy-path so we never lose telemetry.
 */
async function persistError(ctx, errorReason, startedAt, deps, modelResp) {
  const { ValidateAnswerSubmissions } = cds.entities('com.sap.developers.ims');
  try {
    await INSERT.into(ValidateAnswerSubmissions).entries({
      ID: cds.utils.uuid(),
      user_ID: resolveUserId(deps?.user),
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
      latencyMs: Date.now() - startedAt,
    });
  } catch (e) {
    // Persistence failure must not mask the original error path.
    LOG.error('Failed to persist error row', e);
  }
  return { verdict: 'error', errorReason };
}

/**
 * Calls `fn` with the given args; returns `null` on any thrown error.
 * Used so a flaky loadQuestion doesn't abort the dispatch.
 */
async function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return null;
  try {
    return await fn(...args);
  } catch (e) {
    LOG.warn('safeCall swallowed error', e?.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatches an AI free-text answer check for a single tutorial question.
 *
 * @param {object} input
 * @param {string} input.tutorialSlug   - Tutorial slug (will be lowercased).
 * @param {number} input.stepNumber     - 1-based step index.
 * @param {string} input.questionId     - Stable question id from rules.vr.
 * @param {string} input.submittedAnswer - Learner's free-text answer.
 *
 * @param {object}   deps
 * @param {object}  [deps.user]         - Authenticated user `{ id }` or null/undefined.
 *                                        user.id === 'anonymous' → user_ID null.
 * @param {Function} deps.callModel     - `async ({ system, user, schema }) =>
 *                                        { verdict, promptTokens, completionTokens, modelName }`.
 * @param {Function} deps.loadQuestion  - `async (slug, stepNumber, questionId) =>
 *                                        { questionId, question, correctAnswer, aiGrading } | null`.
 *
 * @returns {Promise<object>} Verdict object — either `{ verdict, summary, hint? }`
 *                            on the happy path or `{ verdict: 'error', errorReason }`
 *                            on any failure.
 */
export async function dispatchValidateAnswer(input, deps) {
  const startedAt = Date.now();
  const slug = (input.tutorialSlug || '').toLowerCase();
  const { stepNumber, questionId, submittedAnswer } = input;

  // Base persistence context — reused across all error paths.
  const baseCtx = { slug, stepNumber, questionId, submittedAnswer };

  // 1. Flag check
  const { ChatSettings } = cds.entities('com.sap.developers.ims');
  const settings = await SELECT.one.from(ChatSettings);
  if (!settings?.validateAnswerEnabled) {
    return persistError(baseCtx, 'disabled', startedAt, deps);
  }

  // 2. Load question via injected callback
  const question = await safeCall(deps?.loadQuestion, slug, stepNumber, questionId);
  if (!question) {
    return persistError(baseCtx, 'question_missing', startedAt, deps);
  }
  if (!question.aiGrading) {
    return persistError({ ...baseCtx, question }, 'not_ai_graded', startedAt, deps);
  }

  // 3. Build prompt
  const system = buildSystemPrompt();
  const userMsg = buildUserMessage({
    question: question.question,
    correctAnswer: question.correctAnswer,
    submittedAnswer,
  });

  // 4. Call LLM
  let modelResp;
  try {
    modelResp = await deps.callModel({
      system,
      user: userMsg,
      schema: VALIDATE_ANSWER_OUTPUT_SCHEMA,
    });
  } catch (err) {
    LOG.warn('validate-answer upstream failure', err?.message);
    return persistError({ ...baseCtx, question }, 'upstream', startedAt, deps);
  }

  // 5. Validate verdict shape.
  // modelResp.verdict is the parsed object from the forced-tool-call response;
  // its inner `.verdict` field is the enum string. Local rename for clarity.
  const parsed = modelResp?.verdict;
  const validVerdicts = new Set(['pass', 'partial', 'fail']);
  const isValid =
    parsed &&
    validVerdicts.has(parsed.verdict) &&
    typeof parsed.summary === 'string';

  if (!isValid) {
    LOG.warn('validate-answer LLM returned malformed verdict', {
      slug, stepNumber, questionId,
    });
    // Token telemetry must still be recorded — those tokens were spent.
    return persistError({ ...baseCtx, question }, 'schema', startedAt, deps, modelResp);
  }

  // 6. Reference-leak redaction (applied to BOTH persisted row and response).
  const safe = redactReferenceLeaks(parsed, question.correctAnswer || null);
  if (safe !== parsed) {
    LOG.warn('validate-answer reference leak detected and redacted', {
      slug, stepNumber, questionId,
    });
  }

  // 7. Persist
  const { ValidateAnswerSubmissions } = cds.entities('com.sap.developers.ims');
  await INSERT.into(ValidateAnswerSubmissions).entries({
    ID: cds.utils.uuid(),
    user_ID: resolveUserId(deps?.user),
    tutorialSlug: slug,
    stepNumber,
    questionId,
    questionText: question.question,
    correctAnswer: question.correctAnswer,
    submittedAnswer,
    verdict: safe.verdict,
    summary: safe.summary,
    hint: safe.hint || null,
    modelName: modelResp.modelName ?? null,
    promptVersion: PROMPT_VERSION,
    promptTokens: modelResp.promptTokens ?? null,
    completionTokens: modelResp.completionTokens ?? null,
    latencyMs: Date.now() - startedAt,
    errorReason: null,
  });

  // 8. Return the (possibly redacted) verdict
  return safe;
}
