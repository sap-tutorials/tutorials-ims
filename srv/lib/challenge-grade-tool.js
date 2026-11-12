// srv/lib/challenge-grade-tool.js
//
// Core dispatch for the challenge-widget freeText AI grader (#2441).
// LLM caller and answer loader are injected so unit tests run without network
// or HANA. Mirrors srv/lib/validate-answer-tool.js (the AI-quiz grader) but is
// leaner: challenge freeText nodes are always AI-graded by construction (MCQ is
// client-graded and never reaches this path), and there is no submissions
// telemetry entity, so there is no MCQ-rule rejection or per-submission INSERT.
//
// Anti-leak: reuses validate-answer-prompt.js's prompt, output schema, and
// redactReferenceLeaks verbatim — freeText grading is semantically identical to
// quiz-text grading, so a second prompt module would be duplication.

import cds from '@sap/cds';
import {
  buildSystemPrompt,
  buildUserMessage,
  VALIDATE_ANSWER_OUTPUT_SCHEMA,
  redactReferenceLeaks,
} from './validate-answer-prompt.js';

const LOG = cds.log('challenge-grade');

async function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return null;
  try {
    return await fn(...args);
  } catch (e) {
    LOG.warn('safeCall swallowed error', e?.message);
    return null;
  }
}

/**
 * Read the `flag.challengeWidget` ImsConfig kill switch. Fail-open (#2362:
 * DEV-only, fail-open): on any read error, treat as enabled so a transient DB
 * blip never dark-fails a learner mid-grade. Default when the row is absent is
 * OFF (the flag ships dark), matching the feature-flag registry default.
 */
async function isChallengeGradingEnabled() {
  try {
    const { ImsConfig } = cds.entities('com.sap.developers.ims');
    if (!ImsConfig) return true; // fail-open on model mismatch
    const row = await SELECT.one.from(ImsConfig).where({ key: 'flag.challengeWidget' });
    if (!row) return false; // absent → default OFF
    return String(row.value).toLowerCase() === 'true';
  } catch (err) {
    LOG.warn('isChallengeGradingEnabled read error — failing open', err?.message);
    return true;
  }
}

/**
 * Grade a single challenge freeText node.
 *
 * @param {object} input
 * @param {string} input.tutorialSlug    - Tutorial slug (lowercased internally).
 * @param {number} input.stepNumber      - 1-based step index.
 * @param {string} input.nodeId          - Challenge node id (e.g. 'challenge-3-1').
 * @param {string} input.submittedAnswer - Learner's free-text answer.
 * @param {object}   deps
 * @param {Function} deps.callModel      - async ({ system, user, schema }) => { verdict, ... }.
 * @param {Function} deps.loadAnswer     - async (slug, step, nodeId) => { reference, prompt } | null.
 * @param {Function} [deps.loadGradingContext] - async (slug) => string|null. Never throws (fail-open).
 * @returns {Promise<object>} `{ verdict, summary, hint? }` or `{ verdict:'error', errorReason }`.
 */
export async function dispatchChallengeGrade(input, deps) {
  const slug = (input.tutorialSlug || '').toLowerCase();
  const { stepNumber, nodeId, submittedAnswer } = input;

  // 1. Flag check (ImsConfig kill switch — fail-open on read error)
  if (!(await isChallengeGradingEnabled())) {
    return { verdict: 'error', errorReason: 'disabled' };
  }

  // 1b. Grading-context grounding: read ChatSettings.gradingContextEnabled (fail-open).
  // This is a SEPARATE gate from isChallengeGradingEnabled — it never gates the grade;
  // any read error defaults to no grounding, and the grade still runs.
  const grounding = await (async () => {
    try {
      const { ChatSettings } = cds.entities('com.sap.developers.ims');
      if (!ChatSettings) return null;
      const settings = await SELECT.one.from(ChatSettings);
      if (!settings?.gradingContextEnabled) return null;
      return await safeCall(deps?.loadGradingContext, slug);
    } catch (err) {
      LOG.warn('challenge-grade ChatSettings read error — no grounding', err?.message);
      return null;
    }
  })();

  // 2. Load the reference answer
  const answer = await safeCall(deps?.loadAnswer, slug, stepNumber, nodeId);
  if (!answer) {
    return { verdict: 'error', errorReason: 'question_missing' };
  }

  // 3. Build prompt (reuse the validate-answer prompt — node prompt maps to
  //    `question`, the stored reference to `correctAnswer`).
  const system = buildSystemPrompt();
  const userMsg = buildUserMessage({
    question: answer.prompt || '',
    correctAnswer: answer.reference,
    submittedAnswer,
    // [#3090] Tutorial-level domain guidance; undefined → prompt shape unchanged
    // from v4. grounding is null when flag off, ChatSettings absent, or loader
    // returned nothing.
    gradingContext: grounding || undefined,
  });

  // 4. Call the model
  let modelResp;
  try {
    modelResp = await deps.callModel({
      system,
      user: userMsg,
      schema: VALIDATE_ANSWER_OUTPUT_SCHEMA,
    });
  } catch (err) {
    LOG.warn('challenge-grade upstream failure', err?.message);
    return { verdict: 'error', errorReason: 'upstream' };
  }

  // 5. Validate verdict shape
  const parsed = modelResp?.verdict;
  const validVerdicts = new Set(['pass', 'partial', 'fail']);
  const isValid = parsed && validVerdicts.has(parsed.verdict) && typeof parsed.summary === 'string';
  if (!isValid) {
    LOG.warn('challenge-grade LLM returned malformed verdict', { slug, stepNumber, nodeId });
    return { verdict: 'error', errorReason: 'schema' };
  }

  // 6. Reference-leak redaction
  const safe = redactReferenceLeaks(parsed, answer.reference || null);
  if (safe !== parsed) {
    LOG.warn('challenge-grade reference leak detected and redacted', { slug, stepNumber, nodeId });
  }

  // 7. Return the (possibly redacted) verdict
  return safe;
}
