// srv/lib/challenge-grade-handler.js
// Express handler factory for POST /api/challenge-grade (#2441).
// Rate-limits per user (30/hour) and per (user, slug, step) (5/5 min).
// LLM caller and answer-loader are injected at the call site (srv/server.js)
// so unit tests run without network or HANA.
//
// Mirrors srv/lib/validate-answer-handler.js — same rate-limit windows and
// in-memory Map mechanism. Differences: a `nodeId` body field (vs questionId)
// and the leaner challenge dispatch (no submissions telemetry).
//
// Auth: authenticated only (reject anonymous), same as /api/validate-answer.

import cds from '@sap/cds';
import { dispatchChallengeGrade } from './challenge-grade-tool.js';

const PER_USER_LIMIT = { count: 30, windowMs: 60 * 60 * 1000 };   // 30 / hour
const PER_STEP_LIMIT = { count: 5,  windowMs: 5  * 60 * 1000 };   // 5  / 5 min
const MAX_ANSWER_BYTES = 5_000;

const userCalls = new Map();
const stepCalls = new Map();

/** Clear in-memory rate-limit state. Called by tests in beforeEach. */
export function _resetRateLimitForTest() {
  userCalls.clear();
  stepCalls.clear();
}

function overLimit(map, key, now, limit) {
  const arr = map.get(key) || [];
  while (arr.length && now - arr[0] > limit.windowMs) arr.shift();
  map.set(key, arr);
  return arr.length >= limit.count;
}

function record(map, key, now, windowMs) {
  const arr = map.get(key) || [];
  arr.push(now);
  while (arr.length > 1 && now - arr[0] > windowMs) arr.shift();
  map.set(key, arr);
}

function rateLimitResponse(res, arr, now, limit) {
  const oldest = arr[0] ?? now;
  const retryAfterSec = Math.ceil((limit.windowMs - (now - oldest)) / 1000);
  const safe = Math.max(1, retryAfterSec);
  res.setHeader('Retry-After', String(safe));
  return res.status(429).json({ error: 'rate_limited', retryAfter: safe });
}

/**
 * Create the POST /api/challenge-grade Express handler.
 * Both deps MUST be provided — no module-level defaults.
 *
 * @param {object} deps
 * @param {Function} deps.callModel  - LLM caller.
 * @param {Function} deps.loadAnswer - Answer loader: (slug, step, nodeId) → row|null.
 * @returns {import('express').RequestHandler}
 */
export function makeChallengeGradeHandler(deps = {}) {
  const { callModel, loadAnswer } = deps;
  if (typeof callModel !== 'function') {
    throw new Error('makeChallengeGradeHandler requires deps.callModel to be a function');
  }
  if (typeof loadAnswer !== 'function') {
    throw new Error('makeChallengeGradeHandler requires deps.loadAnswer to be a function');
  }

  return async function challengeGradeHandler(req, res) {
    // 1. Auth guard (before body validation: don't reveal field names)
    const user = cds.context?.user || req.user;
    if (!user || !user.id || user.id === 'anonymous') {
      return res.status(401).json({ error: 'unauthenticated' });
    }

    // 2. Body validation
    const { tutorialSlug, stepNumber, nodeId, submittedAnswer } = req.body || {};
    if (typeof tutorialSlug !== 'string' || !tutorialSlug) {
      return res.status(400).json({ error: 'invalid_body' });
    }
    if (typeof stepNumber !== 'number') {
      return res.status(400).json({ error: 'invalid_body' });
    }
    if (typeof nodeId !== 'string' || !nodeId) {
      return res.status(400).json({ error: 'invalid_body' });
    }
    if (typeof submittedAnswer !== 'string' || !submittedAnswer) {
      return res.status(400).json({ error: 'invalid_body' });
    }
    if (Buffer.byteLength(submittedAnswer, 'utf8') > MAX_ANSWER_BYTES) {
      return res.status(400).json({ error: 'too_long' });
    }

    // 3. Rate-limit checks
    const now = Date.now();
    const uid = user.id;
    const stepKey = `${uid}|${tutorialSlug.toLowerCase()}|${stepNumber}`;
    if (overLimit(userCalls, uid, now, PER_USER_LIMIT)) {
      return rateLimitResponse(res, userCalls.get(uid), now, PER_USER_LIMIT);
    }
    if (overLimit(stepCalls, stepKey, now, PER_STEP_LIMIT)) {
      return rateLimitResponse(res, stepCalls.get(stepKey), now, PER_STEP_LIMIT);
    }

    // 4. Dispatch to core tool
    let verdict;
    try {
      verdict = await dispatchChallengeGrade(
        { tutorialSlug, stepNumber, nodeId, submittedAnswer },
        { callModel, loadAnswer }
      );
    } catch (err) {
      return res.status(500).json({ error: 'internal' });
    }

    // 5. Special error outcomes
    if (verdict.errorReason === 'disabled') {
      return res.status(503).json({ error: 'disabled' });
    }

    // 6. Rate-limit accounting: only on non-error outcomes
    if (verdict.verdict !== 'error') {
      record(userCalls, uid, now, PER_USER_LIMIT.windowMs);
      record(stepCalls, stepKey, now, PER_STEP_LIMIT.windowMs);
    }

    // 7. Success
    return res.status(200).json(verdict);
  };
}
