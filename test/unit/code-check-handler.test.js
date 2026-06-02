// test/unit/code-check-handler.test.js
// Unit tests for the POST /api/codecheck handler factory.
// Uses the same mock-req/res pattern as build-my-progress.test.js.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { makeCodeCheckHandler, _resetRateLimitForTest } from '../../srv/lib/code-check-handler.js';

// Single in-memory SQLite DB shared across all tests in this file.
beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedBase() {
  const { CodeCheckSpecs, CodeCheckSubmissions, ChatSettings, Tutorials } =
    cds.entities('com.sap.developers.ims');

  await DELETE.from(CodeCheckSubmissions);
  await DELETE.from(CodeCheckSpecs);
  await DELETE.from(ChatSettings);
  await DELETE.from(Tutorials);

  await INSERT.into(ChatSettings).entries({
    ID: '00000000-0000-0000-0000-000000000001',
    enabled: true,
    codeCheckEnabled: true,
  });
  await INSERT.into(Tutorials).entries({
    ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    slug: 'sample',
    title: 'Sample Tutorial',
    status: 'ACTIVE',
  });
  await INSERT.into(CodeCheckSpecs).entries({
    tutorial_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    stepNumber: 2,
    goal: 'Log something',
    language: 'javascript',
    referenceSolution: null,
    hasReference: false,
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
      submittedCode: 'console.log(1)',
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
    verdict: { verdict: 'pass', summary: 'Looks good', correctAspects: ['correct'], suggestions: [] },
    promptTokens: 100,
    completionTokens: 50,
    modelName: 'mock-gpt',
  });
}

/** A loadStepText that always returns a non-empty string. */
const loadStepText = async () => 'STEP CONTENT';

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Body validation
// ─────────────────────────────────────────────────────────────────────────────

describe('body validation', () => {
  it('missing tutorialSlug → 400 invalid_body', async () => {
    const handler = makeCodeCheckHandler({ callModel: passModel(), loadStepText });
    const req = mockReq({ body: { stepNumber: 2, submittedCode: 'x' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });

  it('missing submittedCode → 400 invalid_body', async () => {
    const handler = makeCodeCheckHandler({ callModel: passModel(), loadStepText });
    const req = mockReq({ body: { tutorialSlug: 'sample', stepNumber: 2 } });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });

  it('submittedCode.length > 20000 bytes → 400 too_long', async () => {
    const handler = makeCodeCheckHandler({ callModel: passModel(), loadStepText });
    const req = mockReq({
      body: { tutorialSlug: 'sample', stepNumber: 2, submittedCode: 'x'.repeat(20_001) },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'too_long' });
  });

  it('stepNumber not a number → 400 invalid_body', async () => {
    const handler = makeCodeCheckHandler({ callModel: passModel(), loadStepText });
    const req = mockReq({
      body: { tutorialSlug: 'sample', stepNumber: '2', submittedCode: 'x' },
    });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Anonymous user → 401 (fires BEFORE body validation)
// ─────────────────────────────────────────────────────────────────────────────

describe('authentication guard', () => {
  it('anonymous user → 401', async () => {
    const handler = makeCodeCheckHandler({ callModel: passModel(), loadStepText });
    const req = mockReq({ user: { id: 'anonymous' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody.error).toBe('unauthenticated');
  });

  it('missing req.user → 401', async () => {
    const handler = makeCodeCheckHandler({ callModel: passModel(), loadStepText });
    const req = { body: { tutorialSlug: 'sample', stepNumber: 2, submittedCode: 'x' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody.error).toBe('unauthenticated');
  });

  it('401 fires before body is inspected (no tutorialSlug but still 401)', async () => {
    // Body has no tutorialSlug — but we expect 401, not 400, proving auth is checked first.
    const handler = makeCodeCheckHandler({ callModel: passModel(), loadStepText });
    const req = mockReq({ user: { id: 'anonymous' }, body: { stepNumber: 2, submittedCode: 'x' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('happy path', () => {
  it('pass verdict → 200 + JSON body matches verdict shape', async () => {
    const callModel = passModel();
    const handler = makeCodeCheckHandler({ callModel, loadStepText });
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.verdict).toBe('pass');
    expect(res.jsonBody.summary).toBe('Looks good');
    expect(Array.isArray(res.jsonBody.correctAspects)).toBe(true);
    expect(Array.isArray(res.jsonBody.suggestions)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Per-user rate limit (30 / hour)
// ─────────────────────────────────────────────────────────────────────────────

describe('per-user rate limit', () => {
  it('30 successful → 31st returns 429 with Retry-After header', async () => {
    // Use a different user to isolate from the per-step counter (which caps at 5).
    // We need 30 calls to the same user without hitting the per-step limit, so
    // spread them across different step numbers (step 1..30) — each step has its
    // own counter, but the per-user counter accumulates across all steps.
    const callModel = passModel();
    const handler = makeCodeCheckHandler({ callModel, loadStepText });

    // Seed CodeCheckSpecs for steps 1..30 so dispatchCheckCode doesn't bail early
    const { CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
    for (let s = 1; s <= 30; s++) {
      if (s === 2) continue; // already seeded by seedBase()
      await INSERT.into(CodeCheckSpecs).entries({
        tutorial_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        stepNumber: s,
        goal: `Step ${s}`,
        language: 'javascript',
        hasReference: false,
      });
    }

    // 30 successful calls across different steps (so per-step never caps)
    for (let i = 1; i <= 30; i++) {
      const req = mockReq({ body: { tutorialSlug: 'sample', stepNumber: i, submittedCode: 'x' } });
      const res = mockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(200);
    }

    // 31st call — any step, user cap is reached
    const req = mockReq({ body: { tutorialSlug: 'sample', stepNumber: 1, submittedCode: 'x' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(429);
    expect(res.jsonBody).toMatchObject({ error: 'rate_limited' });
    expect(typeof res.jsonBody.retryAfter).toBe('number');
    expect(res.headers['Retry-After']).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Per-step rate limit (5 / 5 min for same user+slug+step)
// ─────────────────────────────────────────────────────────────────────────────

describe('per-step rate limit', () => {
  it('5 calls for same (user, slug, step) → 6th returns 429', async () => {
    const callModel = passModel();
    const handler = makeCodeCheckHandler({ callModel, loadStepText });

    // Same (user, slug, step) 5 times — all succeed
    for (let i = 0; i < 5; i++) {
      const req = mockReq();
      const res = mockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(200);
    }

    // 6th call with same step
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(429);
    expect(res.jsonBody).toMatchObject({ error: 'rate_limited' });
    expect(res.headers['Retry-After']).toBeDefined();
  });

  it('different step numbers each have their own counter', async () => {
    const callModel = passModel();
    const handler = makeCodeCheckHandler({ callModel, loadStepText });

    // Exhaust step 2
    for (let i = 0; i < 5; i++) {
      const req = mockReq();
      const res = mockRes();
      await handler(req, res);
    }

    // Step 3 should still be allowed (need a spec row for it)
    const { CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
    await INSERT.into(CodeCheckSpecs).entries({
      tutorial_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      stepNumber: 3,
      goal: 'Another step',
      language: 'javascript',
      hasReference: false,
    });

    const req = mockReq({ body: { tutorialSlug: 'sample', stepNumber: 3, submittedCode: 'x' } });
    const res = mockRes();
    await handler(req, res);
    // Should get 200 (step 3 is fresh) or at worst 200 from dispatch
    // (dispatch may return spec_missing error verdict — that still yields 200 HTTP)
    expect(res.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: Upstream errors do NOT count toward rate cap
// ─────────────────────────────────────────────────────────────────────────────

describe('upstream errors are not rate-counted', () => {
  it('dispatch returning verdict:error / errorReason:upstream does not increment counter', async () => {
    // A callModel that always throws (upstream error)
    const failModel = vi.fn().mockRejectedValue(new Error('upstream timeout'));
    const handler = makeCodeCheckHandler({ callModel: failModel, loadStepText });

    // Fire 5 "calls" — all yield upstream errors, none should count
    for (let i = 0; i < 5; i++) {
      const req = mockReq();
      const res = mockRes();
      await handler(req, res);
      // These return 200 with verdict:'error' because the handler doesn't
      // distinguish outcome-error from success at the HTTP level for upstream
      expect(res.statusCode).toBe(200);
      expect(res.jsonBody.verdict).toBe('error');
      expect(res.jsonBody.errorReason).toBe('upstream');
    }

    // Now switch to a pass model — the step counter should STILL have capacity
    // since none of the upstream-error calls were recorded.
    const goodModel = passModel();
    const goodHandler = makeCodeCheckHandler({ callModel: goodModel, loadStepText });
    for (let i = 0; i < 5; i++) {
      const req = mockReq();
      const res = mockRes();
      await goodHandler(req, res);
      expect(res.statusCode).toBe(200);
      expect(res.jsonBody.verdict).toBe('pass');
    }

    // NOW the step limit should kick in (5 successful calls exhausted it)
    const req = mockReq();
    const res = mockRes();
    await goodHandler(req, res);
    expect(res.statusCode).toBe(429);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: disabled flag → 503
// ─────────────────────────────────────────────────────────────────────────────

describe('disabled flag', () => {
  it('dispatch returns errorReason:disabled → handler returns 503', async () => {
    // Disable codeCheck in DB
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ChatSettings);
    await INSERT.into(ChatSettings).entries({
      ID: '00000000-0000-0000-0000-000000000001',
      enabled: true,
      codeCheckEnabled: false,  // disabled
    });

    const handler = makeCodeCheckHandler({ callModel: passModel(), loadStepText });
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toEqual({ error: 'disabled' });
  });
});
