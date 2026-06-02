// srv/lib/code-check-handler.js
// Express handler factory for POST /api/codecheck.
// Rate-limits per user (30/hour) and per (user, slug, step) (5/5 min).
// LLM caller and step-loader are injected at the call site (srv/server.js)
// so unit tests run without network or HANA, and the closure can never
// capture a stale null from a module-level variable.

import { dispatchCheckCode } from './code-check-tool.js';

// ---------------------------------------------------------------------------
// Rate-limit configuration + state
// ---------------------------------------------------------------------------

const PER_USER_LIMIT = { count: 30, windowMs: 60 * 60 * 1000 };   // 30 / hour
const PER_STEP_LIMIT = { count: 5,  windowMs: 5  * 60 * 1000 };   // 5  / 5 min

const MAX_CODE_BYTES = 20_000;

// Maps: key → sorted array of timestamps (oldest first)
const userCalls = new Map();
const stepCalls = new Map();

/**
 * Clear in-memory rate-limit state. Called by tests in beforeEach.
 */
export function _resetRateLimitForTest() {
  userCalls.clear();
  stepCalls.clear();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Trim expired timestamps from the window, then check whether the bucket is
 * already at or over the limit.  Does NOT record a new call.
 */
function overLimit(map, key, now, limit) {
  const arr = map.get(key) || [];
  // Evict timestamps outside the window
  while (arr.length && now - arr[0] > limit.windowMs) arr.shift();
  map.set(key, arr);
  return arr.length >= limit.count;
}

/**
 * Record a successful call for rate-limit accounting.
 */
function record(map, key, now, windowMs) {
  const arr = map.get(key) || [];
  arr.push(now);
  // Keep the array tidy so it doesn't grow forever
  while (arr.length > 1 && now - arr[0] > windowMs) arr.shift();
  map.set(key, arr);
}

/**
 * Build the 429 response with Retry-After header.
 */
function rateLimitResponse(res, arr, now, limit) {
  const oldest = arr[0] ?? now;
  const retryAfterSec = Math.ceil((limit.windowMs - (now - oldest)) / 1000);
  const safe = Math.max(1, retryAfterSec);
  res.setHeader('Retry-After', String(safe));
  return res.status(429).json({ error: 'rate_limited', retryAfter: safe });
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create the POST /api/codecheck Express handler.
 *
 * Both deps MUST be provided — there are no module-level defaults.
 * Production wires real implementations at the call site (srv/server.js);
 * tests inject mocks.  Passing neither throws at factory time so the
 * misconfiguration is caught at boot rather than on first request.
 *
 * @param {object} deps
 * @param {Function} deps.callModel     - LLM caller.
 * @param {Function} deps.loadStepText  - Step-text loader.
 * @returns {import('express').RequestHandler}
 */
export function makeCodeCheckHandler(deps = {}) {
  const { callModel, loadStepText } = deps;
  if (typeof callModel !== 'function') {
    throw new Error('makeCodeCheckHandler requires deps.callModel to be a function');
  }
  if (typeof loadStepText !== 'function') {
    throw new Error('makeCodeCheckHandler requires deps.loadStepText to be a function');
  }

  return async function codeCheckHandler(req, res) {
    // ── 1. Auth guard (BEFORE body validation: don't reveal field names) ──
    if (!req.user || req.user.id === 'anonymous') {
      return res.status(401).json({ error: 'unauthenticated' });
    }

    // ── 2. Body validation ────────────────────────────────────────────────
    const { tutorialSlug, stepNumber, submittedCode, language } = req.body || {};

    if (typeof tutorialSlug !== 'string' || !tutorialSlug) {
      return res.status(400).json({ error: 'invalid_body' });
    }
    if (typeof stepNumber !== 'number') {
      return res.status(400).json({ error: 'invalid_body' });
    }
    if (typeof submittedCode !== 'string' || !submittedCode) {
      return res.status(400).json({ error: 'invalid_body' });
    }
    if (Buffer.byteLength(submittedCode, 'utf8') > MAX_CODE_BYTES) {
      return res.status(400).json({ error: 'too_long' });
    }

    // ── 3. Rate-limit checks ──────────────────────────────────────────────
    const now      = Date.now();
    const uid      = req.user.id;
    const stepKey  = `${uid}|${tutorialSlug.toLowerCase()}|${stepNumber}`;

    if (overLimit(userCalls, uid, now, PER_USER_LIMIT)) {
      return rateLimitResponse(res, userCalls.get(uid), now, PER_USER_LIMIT);
    }
    if (overLimit(stepCalls, stepKey, now, PER_STEP_LIMIT)) {
      return rateLimitResponse(res, stepCalls.get(stepKey), now, PER_STEP_LIMIT);
    }

    // ── 4. Dispatch to core tool ─────────────────────────────────────────
    let verdict;
    try {
      verdict = await dispatchCheckCode(
        { tutorialSlug, stepNumber, submittedCode, language },
        { user: req.user, callModel, loadStepText }
      );
    } catch (err) {
      return res.status(500).json({ error: 'internal' });
    }

    // ── 5. Special error outcomes ─────────────────────────────────────────
    if (verdict.errorReason === 'disabled') {
      return res.status(503).json({ error: 'disabled' });
    }

    // ── 6. Rate-limit accounting: only on non-error outcomes ──────────────
    // Transient upstream errors do NOT count against the user's quota.
    if (verdict.verdict !== 'error') {
      record(userCalls, uid, now, PER_USER_LIMIT.windowMs);
      record(stepCalls, stepKey, now, PER_STEP_LIMIT.windowMs);
    }

    // ── 7. Success ────────────────────────────────────────────────────────
    return res.status(200).json(verdict);
  };
}
