// test/unit/validate-answer-spec-publish.test.js
// Unit tests for POST /content/validate-answer-specs handler.
// Mirrors test/unit/code-check-spec-publish.test.js but covers the
// REPLACE-per-slug semantics and bearer-auth-in-handler shape.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { makeValidateAnswerSpecPublishHandler } from '../../srv/lib/validate-answer-spec-publish.js';

const API_KEY = 'test-content-api-key';

// ── DB Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedTutorials() {
  const { ValidateAnswerSpecs, Tutorials } = cds.entities('com.sap.developers.ims');
  await DELETE.from(ValidateAnswerSpecs);
  await DELETE.from(Tutorials);

  await INSERT.into(Tutorials).entries([
    { ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', slug: 'tutorial-alpha', title: 'Alpha', status: 'ACTIVE' },
    { ID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', slug: 'tutorial-beta',  title: 'Beta',  status: 'ACTIVE' },
  ]);
}

beforeEach(async () => {
  await seedTutorials();
});

// ── Mock req/res factories ────────────────────────────────────────────────────

function mockReq(body, headers = {}) {
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  return {
    body,
    get(name) { return lower[String(name).toLowerCase()]; },
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    jsonBody: null,
    status(c) { this.statusCode = c; return this; },
    json(b)   { this.jsonBody = b; return this; },
  };
  return res;
}

function authHeaders(key = API_KEY) {
  return { authorization: `Bearer ${key}` };
}

// ── Sanity: factory shape ─────────────────────────────────────────────────────

describe('factory', () => {
  it('throws when apiKey is missing', () => {
    expect(() => makeValidateAnswerSpecPublishHandler({})).toThrow(/apiKey/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Auth — missing/wrong bearer → 401
// ─────────────────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('missing Authorization header → 401 unauthenticated', async () => {
    const handler = makeValidateAnswerSpecPublishHandler({ apiKey: API_KEY });
    const res = mockRes();
    await handler(mockReq({ slug: 'tutorial-alpha', specs: [] }), res);
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: 'unauthenticated' });
  });

  it('wrong bearer token → 401 unauthenticated', async () => {
    const handler = makeValidateAnswerSpecPublishHandler({ apiKey: API_KEY });
    const res = mockRes();
    await handler(
      mockReq({ slug: 'tutorial-alpha', specs: [] }, authHeaders('wrong-key')),
      res
    );
    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({ error: 'unauthenticated' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Body validation
// ─────────────────────────────────────────────────────────────────────────────

describe('body validation', () => {
  it('missing slug → 400 invalid_body', async () => {
    const handler = makeValidateAnswerSpecPublishHandler({ apiKey: API_KEY });
    const res = mockRes();
    await handler(mockReq({ specs: [] }, authHeaders()), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });

  it('specs not an array → 400 invalid_body', async () => {
    const handler = makeValidateAnswerSpecPublishHandler({ apiKey: API_KEY });
    const res = mockRes();
    await handler(mockReq({ slug: 'tutorial-alpha', specs: 'oops' }, authHeaders()), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });

  it('spec missing stepNumber → 400 invalid_spec', async () => {
    const handler = makeValidateAnswerSpecPublishHandler({ apiKey: API_KEY });
    const res = mockRes();
    await handler(mockReq({
      slug: 'tutorial-alpha',
      specs: [{ questionId: 'q1', questionText: 'Hi?', correctAnswer: 'Yes', ruleType: 'exact-match' }],
    }, authHeaders()), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_spec' });
  });

  it('correctAnswer over 10 KB → 400 too_long', async () => {
    const handler = makeValidateAnswerSpecPublishHandler({ apiKey: API_KEY });
    const res = mockRes();
    const long = 'a'.repeat(10_001);
    await handler(mockReq({
      slug: 'tutorial-alpha',
      specs: [{
        stepNumber: 1, questionId: 'q1', questionText: 'Hi?',
        correctAnswer: long, ruleType: 'exact-match',
      }],
    }, authHeaders()), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'too_long' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Tutorial not found → 404
// ─────────────────────────────────────────────────────────────────────────────

describe('tutorial not found', () => {
  it('unknown slug → 404 tutorial_not_found', async () => {
    const handler = makeValidateAnswerSpecPublishHandler({ apiKey: API_KEY });
    const res = mockRes();
    await handler(mockReq({
      slug: 'no-such-tutorial',
      specs: [{
        stepNumber: 1, questionId: 'q1', questionText: 'Hi?',
        correctAnswer: 'Yes', ruleType: 'exact-match',
      }],
    }, authHeaders()), res);
    expect(res.statusCode).toBe(404);
    expect(res.jsonBody).toEqual({ error: 'tutorial_not_found' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Happy path — single spec inserted
// ─────────────────────────────────────────────────────────────────────────────

describe('happy path', () => {
  it('single spec → 200, row visible in DB with correct FK + content', async () => {
    const handler = makeValidateAnswerSpecPublishHandler({ apiKey: API_KEY });
    const res = mockRes();
    await handler(mockReq({
      slug: 'tutorial-alpha',
      specs: [{
        stepNumber: 2, questionId: 'validate-2', questionText: 'What is foo?',
        correctAnswer: 'Bar.', ruleType: 'regex', aiGrading: true,
      }],
    }, authHeaders()), res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ ok: true, count: 1 });

    const { ValidateAnswerSpecs } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(ValidateAnswerSpecs);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.tutorial_ID).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(r.stepNumber).toBe(2);
    expect(r.questionId).toBe('validate-2');
    expect(r.questionText).toBe('What is foo?');
    expect(r.correctAnswer).toBe('Bar.');
    expect(r.ruleType).toBe('regex');
    expect(r.aiGrading).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: REPLACE semantics — re-publish slug A drops slug A's old specs
// ─────────────────────────────────────────────────────────────────────────────

describe('replace semantics', () => {
  it('publish A with 2 specs → publish A with 1 spec → only the new one remains', async () => {
    const handler = makeValidateAnswerSpecPublishHandler({ apiKey: API_KEY });

    // First publish — 2 specs
    const res1 = mockRes();
    await handler(mockReq({
      slug: 'tutorial-alpha',
      specs: [
        { stepNumber: 1, questionId: 'q1', questionText: 'Q1?', correctAnswer: 'A1', ruleType: 'exact-match' },
        { stepNumber: 2, questionId: 'q2', questionText: 'Q2?', correctAnswer: 'A2', ruleType: 'regex' },
      ],
    }, authHeaders()), res1);
    expect(res1.statusCode).toBe(200);
    expect(res1.jsonBody).toEqual({ ok: true, count: 2 });

    // Second publish — 1 spec only
    const res2 = mockRes();
    await handler(mockReq({
      slug: 'tutorial-alpha',
      specs: [
        { stepNumber: 5, questionId: 'q5', questionText: 'Q5?', correctAnswer: 'A5', ruleType: 'regex-begins-with' },
      ],
    }, authHeaders()), res2);
    expect(res2.statusCode).toBe(200);
    expect(res2.jsonBody).toEqual({ ok: true, count: 1 });

    // Only the new spec remains for slug A
    const { ValidateAnswerSpecs } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(ValidateAnswerSpecs);
    expect(rows).toHaveLength(1);
    expect(rows[0].stepNumber).toBe(5);
    expect(rows[0].questionId).toBe('q5');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: Other slugs untouched
// ─────────────────────────────────────────────────────────────────────────────

describe('other slugs untouched', () => {
  it('publish A → publish B → A specs still present', async () => {
    const handler = makeValidateAnswerSpecPublishHandler({ apiKey: API_KEY });

    // Publish A
    const resA = mockRes();
    await handler(mockReq({
      slug: 'tutorial-alpha',
      specs: [
        { stepNumber: 1, questionId: 'qa', questionText: 'A-Q?', correctAnswer: 'A-A', ruleType: 'exact-match' },
      ],
    }, authHeaders()), resA);
    expect(resA.statusCode).toBe(200);

    // Publish B (different slug)
    const resB = mockRes();
    await handler(mockReq({
      slug: 'tutorial-beta',
      specs: [
        { stepNumber: 4, questionId: 'qb', questionText: 'B-Q?', correctAnswer: 'B-A', ruleType: 'regex' },
      ],
    }, authHeaders()), resB);
    expect(resB.statusCode).toBe(200);

    // Both should be present; A's row was not deleted by publishing B
    const { ValidateAnswerSpecs } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(ValidateAnswerSpecs);
    expect(rows).toHaveLength(2);

    const alphaRows = rows.filter(r => r.tutorial_ID === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    const betaRows  = rows.filter(r => r.tutorial_ID === 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(alphaRows).toHaveLength(1);
    expect(betaRows).toHaveLength(1);
    expect(alphaRows[0].questionId).toBe('qa');
    expect(betaRows[0].questionId).toBe('qb');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: Slug lowercased on lookup
// ─────────────────────────────────────────────────────────────────────────────

describe('slug lowercased on lookup', () => {
  it('mixed-case slug resolves to the lowercase tutorial row', async () => {
    const handler = makeValidateAnswerSpecPublishHandler({ apiKey: API_KEY });
    const res = mockRes();
    await handler(mockReq({
      slug: 'Tutorial-ALPHA',
      specs: [
        { stepNumber: 1, questionId: 'qx', questionText: 'X?', correctAnswer: 'Y', ruleType: 'exact-match' },
      ],
    }, authHeaders()), res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ ok: true, count: 1 });

    const { ValidateAnswerSpecs } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(ValidateAnswerSpecs);
    expect(rows).toHaveLength(1);
    expect(rows[0].tutorial_ID).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: Canonical (post-#242) export shape
// ─────────────────────────────────────────────────────────────────────────────
// The deprecated factory wrapper inlines a 401 auth check for back-compat;
// the canonical handler delegates auth to contentAuthMiddleware in
// srv/server.js. These tests exercise the unauth'd handler directly to
// confirm the body-validation + DB logic is identical.

import { publishValidateAnswerSpecs } from '../../srv/lib/validate-answer-spec-publish.js';

describe('publishValidateAnswerSpecs direct export (#242)', () => {
  it('writes specs successfully when auth has already passed (no auth check inside)', async () => {
    const res = mockRes();
    // Note: NO authHeaders — auth is contentAuthMiddleware's job, not the handler's
    await publishValidateAnswerSpecs(mockReq({
      slug: 'tutorial-alpha',
      specs: [
        { stepNumber: 1, questionId: 'q1', questionText: 'Q1?', correctAnswer: 'A1', ruleType: 'exact-match' },
      ],
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ ok: true, count: 1 });
  });

  it('returns 400 invalid_body on missing slug regardless of auth state', async () => {
    const res = mockRes();
    await publishValidateAnswerSpecs(mockReq({ specs: [] }), res);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });

  it('returns 404 tutorial_not_found for unknown slug regardless of auth state', async () => {
    const res = mockRes();
    await publishValidateAnswerSpecs(mockReq({
      slug: 'nonexistent-slug',
      specs: [
        { stepNumber: 1, questionId: 'q1', questionText: 'Q?', correctAnswer: 'A', ruleType: 'exact-match' },
      ],
    }), res);

    expect(res.statusCode).toBe(404);
    expect(res.jsonBody).toEqual({ error: 'tutorial_not_found' });
  });
});
