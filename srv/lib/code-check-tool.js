// srv/lib/code-check-tool.js
// Core dispatch function for the AI code-check spike (issue #171).
// LLM caller and step-text loader are injected so unit tests run without
// network or HANA — see test/unit/code-check-tool.test.js.

import cds from '@sap/cds';
import {
  buildSystemPrompt,
  buildUserMessage,
  CHECK_CODE_OUTPUT_SCHEMA,
  redactReferenceLeaks,
} from './code-check-prompt.js';

const LOG = cds.log('code-check');

// Regex to extract fenced code blocks from step markdown.
// Written with bare backticks — no escaping needed in JS source.
// Uses matchAll (NOT exec/match loops) per task spec.
const FENCED = /```([a-z0-9]*)\n([\s\S]*?)```/gi;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Persist an error row to CodeCheckSubmissions.
 * Called on every non-happy-path so we never lose telemetry.
 *
 * @param {object} db          - CDS db handle
 * @param {object} ctx         - { tutorialSlug, stepNumber, submittedCode, language, user, startedAt, extra }
 */
async function persistError(db, ctx) {
  const { CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
  const {
    tutorialSlug, stepNumber, submittedCode, language,
    user, startedAt, extra = {},
  } = ctx;

  const userId = (user && user.id && user.id !== 'anonymous') ? user.id : null;

  try {
    await INSERT.into(CodeCheckSubmissions).entries({
      ID: cds.utils.uuid(),
      user_ID: userId,
      tutorialSlug,
      stepNumber,
      submittedCode,
      language: language || null,
      verdict: 'error',
      latencyMs: Date.now() - startedAt,
      ...extra,
    });
  } catch (e) {
    // Persistence failure must not mask the original error path.
    LOG.error('Failed to persist error row', e);
  }
}

/**
 * Calls `fn` with the given args; returns `null` on any thrown error.
 * Used so a flaky loadStepText doesn't abort the dispatch.
 *
 * @param {Function} fn
 * @param {...*} args
 * @returns {Promise<*>}
 */
async function safeCall(fn, ...args) {
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
 * Dispatches an AI code-check for a single tutorial step submission.
 *
 * @param {object} input
 * @param {string}  input.tutorialSlug   - Tutorial slug (will be lowercased).
 * @param {number}  input.stepNumber     - 1-based step index.
 * @param {string}  input.submittedCode  - Learner's code.
 * @param {string} [input.language]      - Optional language hint override.
 *
 * @param {object}   deps
 * @param {object}  [deps.user]          - Authenticated user object `{ id }`.
 * @param {object}  [deps.db]            - CDS db handle (optional; resolved via cds.connect.to).
 * @param {Function} deps.callModel      - `async ({ system, user, schema, language? }) => { verdict, promptTokens, completionTokens, modelName }`.
 * @param {Function} deps.loadStepText   - `async (slug, stepNumber) => string`.
 *
 * @returns {Promise<object>} Verdict object, always `{ verdict, ... }` or `{ verdict:'error', errorReason }`.
 */
export async function dispatchCheckCode(input, deps) {
  const startedAt = Date.now();

  // 1. Lowercase slug (project canonical convention)
  const tutorialSlug = (input.tutorialSlug || '').toLowerCase();
  const { stepNumber, submittedCode } = input;
  const language = input.language || undefined;

  const { user, callModel, loadStepText } = deps;

  // Base persistence context (reused across all error paths)
  const baseCtx = { tutorialSlug, stepNumber, submittedCode, language, user, startedAt };

  // 2. Resolve db handle
  const db = deps.db || (await cds.connect.to('db'));

  // 3. Read ChatSettings singleton (first row; there should only ever be one)
  const { ChatSettings } = cds.entities('com.sap.developers.ims');
  const settings = await SELECT.one.from(ChatSettings);

  if (!settings?.codeCheckEnabled) {
    await persistError(db, { ...baseCtx, extra: { errorReason: 'disabled' } });
    return { verdict: 'error', errorReason: 'disabled' };
  }

  // 4. Look up Tutorial by slug, then CodeCheckSpecs by (tutorial_ID, stepNumber)
  const { Tutorials, CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
  const tutorial = await SELECT.one.from(Tutorials).where({ slug: tutorialSlug });

  let spec = null;
  if (tutorial) {
    spec = await SELECT.one.from(CodeCheckSpecs).where({
      tutorial_ID: tutorial.ID,
      stepNumber,
    });
  }

  if (!spec) {
    await persistError(db, { ...baseCtx, extra: { errorReason: 'spec_missing' } });
    return { verdict: 'error', errorReason: 'spec_missing' };
  }

  // 5. Load step text (null is acceptable if loader fails)
  const stepText = await safeCall(loadStepText, tutorialSlug, stepNumber);

  // 6. Extract fenced code blocks from step text to use as tutorial samples
  let tutorialSamples;
  if (stepText) {
    const blocks = [];
    for (const m of stepText.matchAll(FENCED)) {
      blocks.push(m[2]); // capture group 2 = code body
    }
    tutorialSamples = blocks.length > 0 ? blocks.join('\n\n') : undefined;
  }

  // 7. Build prompts
  const system = buildSystemPrompt();
  const userMessage = buildUserMessage({
    goal: spec.goal,
    stepText: stepText || undefined,
    tutorialSamples,
    referenceSolution: spec.referenceSolution || undefined,
    language: language || spec.language || undefined,
    submittedCode,
  });

  // 8. Call the LLM
  let llmResult;
  try {
    llmResult = await callModel({
      system,
      user: userMessage,
      schema: CHECK_CODE_OUTPUT_SCHEMA,
      language: language || spec.language || undefined,
    });
  } catch (e) {
    LOG.error('LLM call failed', e?.message);
    await persistError(db, { ...baseCtx, extra: { errorReason: 'upstream' } });
    return { verdict: 'error', errorReason: 'upstream' };
  }

  // 9. Validate verdict shape
  const v = llmResult?.verdict;
  const validVerdicts = new Set(['pass', 'partial', 'fail']);
  const isValid =
    v &&
    validVerdicts.has(v.verdict) &&
    typeof v.summary === 'string' &&
    Array.isArray(v.correctAspects) &&
    Array.isArray(v.suggestions);

  if (!isValid) {
    LOG.warn('LLM returned malformed verdict', { tutorialSlug, stepNumber });
    // Token telemetry must still be recorded — those tokens were spent.
    await persistError(db, {
      ...baseCtx,
      extra: {
        errorReason: 'schema',
        promptTokens: llmResult?.promptTokens ?? null,
        completionTokens: llmResult?.completionTokens ?? null,
        modelName: llmResult?.modelName ?? null,
      },
    });
    return { verdict: 'error', errorReason: 'schema' };
  }

  // 10. Apply reference-leak redaction
  const safe = redactReferenceLeaks(v, spec.referenceSolution || null);
  if (safe !== v) {
    // redactReferenceLeaks returns the same reference when nothing changed;
    // a new object means redaction happened.
    LOG.warn('Reference leak detected and redacted', { slug: tutorialSlug, stepNumber });
  }

  // 11. Persist the full row
  const { CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
  const userId = (user && user.id && user.id !== 'anonymous') ? user.id : null;

  await INSERT.into(CodeCheckSubmissions).entries({
    ID: cds.utils.uuid(),
    user_ID: userId,
    tutorialSlug,
    stepNumber,
    submittedCode,
    language: language || spec.language || null,
    verdict: safe.verdict,
    summary: safe.summary,
    suggestions: JSON.stringify(safe.suggestions),
    correctAspects: JSON.stringify(safe.correctAspects),
    modelName: llmResult.modelName ?? null,
    promptTokens: llmResult.promptTokens ?? null,
    completionTokens: llmResult.completionTokens ?? null,
    latencyMs: Date.now() - startedAt,
    errorReason: null,
  });

  // 12. Return the (possibly redacted) verdict
  return safe;
}
