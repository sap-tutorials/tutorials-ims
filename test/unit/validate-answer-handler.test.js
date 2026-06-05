// test/unit/validate-answer-handler.test.js
// Unit tests for the POST /api/validate-answer handler factory.
// Mirrors test/unit/code-check-handler.test.js (PR #205) — same mock req/res
// pattern + dependency injection so tests run without HANA or LLM.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import {
  makeValidateAnswerHandler,
  _resetRateLimitForTest,
} from '../../srv/lib/validate-answer-handler.js';

// Single in-memory SQLite DB shared across all tests in this file.
beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedBase() {
  const { ValidateAnswerSubmissions, ChatSettings } =
    cds.entities('com.sap.developers.ims');

  await DELETE.from(ValidateAnswerSubmissions);
  await DELETE.from(ChatSettings);

  await INSERT.into(ChatSettings).entries({
    ID: '00000000-0000-0000-0000-000000000001',
    enabled: true,
    validateAnswerEnabled: true,
  });
}

beforeEach(async () => {
  _resetRateLimitForTest();
  await seedBase();
});

// ── Factories ─────────────────────────────────────────────────────────────────

function mockReq(opts = {}) {
  return {
    user: opts.user ?? { id: 'u1' },
    body: opts.body ?? {
      tutorialSlug: 'sample',
      stepNumber: 2,
      questionId: 'validate-2',
      submittedAnswer: 'four',
    },
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    jsonBody: null,
    status(c) { this.statusCode = c; return this; },
    json(b)   { this.jsonBody = b; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
  return res;
}

/** callModel stub that always returns a 'pass' verdict. */
function passModel() {
  return vi.fn().mockResolvedValue({
    verdict: { verdict: 'pass', summary: 'Looks good', hint: '' },
    promptTokens: 100,
    completionTokens: 50,
    modelName: 'mock-gpt',
  });
}

/** callModel stub that returns a 'partial' verdict with a hint. */
function partialModel() {
  return vi.fn().mockResolvedValue({
    verdict: {
      verdict: 'partial',
      summary: 'Close, but missing detail',
      hint: 'Consider also mentioning Y',
    },
    promptTokens: 80,
    completionTokens: 40,
    modelName: 'mock-gpt',
  });
}

/** A loadQuestion that always returns an AI-graded question. */
const loadQuestion = async () => ({
  questionId: 'validate-2',
  question: 'What is 2+2?',
  correctAnswer: '4',
  aiGrading: true,
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Body validation
// ─────────────────────────────────────────────────────────────────────────────

describe('body validation', () => {
  it('missing tutorialSlug → 400 invalid_body', async () => {
    const handler = makeValidateAnswerHandler({ callModel: passModel(), loadQuestion });
    const req = mockReq({ body: { stepNumber: 2, questionId: 'validate-2', submittedAnswer: 'x' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });

  it('missing submittedAnswer → 400 invalid_body', async () => {
    const handler = makeValidateAnswerHandler({ callModel: passModel(), loadQuestion });
    const req = mockReq({ body: { tutorialSlug: 'sample', stepNumber: 2, questionId: 'validate-2' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });

  it('missing stepNumber → 400 invalid_body', async () => {
    const handler = makeValidateAnswerHandler({ callModel: passModel(), loadQuestion });
    const req = mockReq({
      body: { tutorialSlug: 'sample', questionId: 'validate-2', submittedAnswer: 'x' },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });

  it('missing questionId → 400 invalid_body', async () => {
    const handler = makeValidateAnswerHandler({ callModel: passModel(), loadQuestion });
    const req = mockReq({
      body: { tutorialSlug: 'sample', stepNumber: 2, submittedAnswer: 'x' },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });

  it('submittedAnswer.length > 5000 bytes → 400 too_long', async () => {
    const handler = makeValidateAnswerHandler({ callModel: passModel(), loadQuestion });
    const req = mockReq({
      body: {
        tutorialSlug: 'sample',
        stepNumber: 2,
        questionId: 'validate-2',
        submittedAnswer: 'x'.repeat(5_001),
      },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'too_long' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Anonymous user → 401
// ─────────────────────────────────────────────────────────────────────────────

describe('authentication guard', () => {
  it('anonymous user → 401', async () => {
    const handler = makeValidateAnswerHandler({ callModel: passModel(), loadQuestion });
    const req = mockReq({ user: { id: 'anonymous' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody.error).toBe('unauthenticated');
  });

  it('missing req.user → 401', async () => {
    const handler = makeValidateAnswerHandler({ callModel: passModel(), loadQuestion });
    const req = {
      body: {
        tutorialSlug: 'sample',
        stepNumber: 2,
        questionId: 'validate-2',
        submittedAnswer: 'x',
      },
    };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody.error).toBe('unauthenticated');
  });

  it('401 fires before body is inspected (no tutorialSlug but still 401)', async () => {
    const handler = makeValidateAnswerHandler({ callModel: passModel(), loadQuestion });
    const req = mockReq({ user: { id: 'anonymous' }, body: { stepNumber: 2 } });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Happy path — pass verdict
// ─────────────────────────────────────────────────────────────────────────────

describe('happy path', () => {
  it('pass verdict → 200 + JSON body matches verdict shape', async () => {
    const handler = makeValidateAnswerHandler({ callModel: passModel(), loadQuestion });
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.verdict).toBe('pass');
    expect(res.jsonBody.summary).toBe('Looks good');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Partial verdict → 200 + body has hint
// ─────────────────────────────────────────────────────────────────────────────

describe('partial verdict', () => {
  it('partial verdict → 200 + body has hint field', async () => {
    const handler = makeValidateAnswerHandler({ callModel: partialModel(), loadQuestion });
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.verdict).toBe('partial');
    expect(res.jsonBody.hint).toBe('Consider also mentioning Y');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Per-user rate limit (30 / hour)
// ─────────────────────────────────────────────────────────────────────────────

describe('per-user rate limit', () => {
  it('30 successful → 31st returns 429 with Retry-After header', async () => {
    const handler = makeValidateAnswerHandler({ callModel: passModel(), loadQuestion });

    // 30 successful calls across different steps so per-step never caps
    for (let i = 1; i <= 30; i++) {
      const req = mockReq({
        body: { tutorialSlug: 'sample', stepNumber: i, questionId: `q-${i}`, submittedAnswer: 'x' },
      });
      const res = mockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(200);
    }

    // 31st call — user cap reached
    const req = mockReq({
      body: { tutorialSlug: 'sample', stepNumber: 1, questionId: 'q-1', submittedAnswer: 'x' },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(429);
    expect(res.jsonBody).toMatchObject({ error: 'rate_limited' });
    expect(typeof res.jsonBody.retryAfter).toBe('number');
    expect(res.headers['Retry-After']).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: Per-(user, slug, step) rate limit (5 / 5 min)
// ─────────────────────────────────────────────────────────────────────────────

describe('per-step rate limit', () => {
  it('5 calls for same (user, slug, step) → 6th returns 429', async () => {
    const handler = makeValidateAnswerHandler({ callModel: passModel(), loadQuestion });

    for (let i = 0; i < 5; i++) {
      const req = mockReq();
      const res = mockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(200);
    }

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(429);
    expect(res.jsonBody).toMatchObject({ error: 'rate_limited' });
    expect(res.headers['Retry-After']).toBeDefined();
  });

  it('different step numbers each have their own per-step counter', async () => {
    const handler = makeValidateAnswerHandler({ callModel: passModel(), loadQuestion });
    // 5 calls on step 1 — fills the per-step budget for step 1.
    for (let i = 0; i < 5; i++) {
      const r = mockRes();
      await handler(
        mockReq({ body: { tutorialSlug: 'sample', stepNumber: 1, questionId: 'q', submittedAnswer: 'a' } }),
        r,
      );
      expect(r.statusCode).toBe(200);
    }
    // 6th call on step 1 → 429
    const blocked = mockRes();
    await handler(
      mockReq({ body: { tutorialSlug: 'sample', stepNumber: 1, questionId: 'q', submittedAnswer: 'a' } }),
      blocked,
    );
    expect(blocked.statusCode).toBe(429);
    // But step 2 is independent — first call on step 2 → 200
    const allowed = mockRes();
    await handler(
      mockReq({ body: { tutorialSlug: 'sample', stepNumber: 2, questionId: 'q', submittedAnswer: 'a' } }),
      allowed,
    );
    expect(allowed.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: Upstream errors do NOT count toward rate cap
// ─────────────────────────────────────────────────────────────────────────────

describe('upstream errors are not rate-counted', () => {
  it('dispatch returning verdict:error / errorReason:upstream does not increment counter', async () => {
    // A callModel that always throws → dispatchValidateAnswer returns
    // { verdict: 'error', errorReason: 'upstream' }
    const failModel = vi.fn().mockRejectedValue(new Error('upstream timeout'));
    const handler = makeValidateAnswerHandler({ callModel: failModel, loadQuestion });

    for (let i = 0; i < 5; i++) {
      const req = mockReq();
      const res = mockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(200);
      expect(res.jsonBody.verdict).toBe('error');
      expect(res.jsonBody.errorReason).toBe('upstream');
    }

    // Switch to pass model — step counter should still have full capacity
    const goodHandler = makeValidateAnswerHandler({ callModel: passModel(), loadQuestion });
    for (let i = 0; i < 5; i++) {
      const req = mockReq();
      const res = mockRes();
      await goodHandler(req, res);
      expect(res.statusCode).toBe(200);
      expect(res.jsonBody.verdict).toBe('pass');
    }

    // 6th successful call — step limit kicks in now
    const req = mockReq();
    const res = mockRes();
    await goodHandler(req, res);
    expect(res.statusCode).toBe(429);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: disabled flag → 503
// ─────────────────────────────────────────────────────────────────────────────

describe('disabled flag', () => {
  it('dispatch returns errorReason:disabled → handler returns 503', async () => {
    // Disable validate-answer in DB
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ChatSettings);
    await INSERT.into(ChatSettings).entries({
      ID: '00000000-0000-0000-0000-000000000001',
      enabled: true,
      validateAnswerEnabled: false,
    });

    const handler = makeValidateAnswerHandler({ callModel: passModel(), loadQuestion });
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toEqual({ error: 'disabled' });
  });
});
