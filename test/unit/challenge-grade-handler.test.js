// test/unit/challenge-grade-handler.test.js
// Unit tests for srv/lib/challenge-grade-handler.js (#2441). Mirrors
// test/unit/validate-answer-handler.test.js — auth guard, body validation,
// rate limits, disabled 503. Dispatch is exercised via the real tool with an
// injected callModel/loadAnswer; the flag is set in ImsConfig.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { makeChallengeGradeHandler, _resetRateLimitForTest } from '../../srv/lib/challenge-grade-handler.js';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

async function setFlag(value) {
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  await DELETE.from(ImsConfig).where({ key: 'flag.challengeWidget' });
  await INSERT.into(ImsConfig).entries({ ID: cds.utils.uuid(), key: 'flag.challengeWidget', value });
}

beforeEach(async () => {
  _resetRateLimitForTest();
  await setFlag('true');
});

const okModel = () => vi.fn().mockResolvedValue({
  verdict: { verdict: 'pass', summary: 'ok', hint: '' },
});
const okLoad = () => vi.fn().mockResolvedValue({ nodeId: 'challenge-2-0', prompt: 'Q', reference: 'ref' });

function mockReq(body, user = { id: 'u1' }) {
  return { body, user };
}
function mockRes() {
  return {
    statusCode: 200, jsonBody: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}

describe('makeChallengeGradeHandler factory', () => {
  it('throws when callModel missing', () => {
    expect(() => makeChallengeGradeHandler({ loadAnswer: okLoad() })).toThrow(/callModel/);
  });
  it('throws when loadAnswer missing', () => {
    expect(() => makeChallengeGradeHandler({ callModel: okModel() })).toThrow(/loadAnswer/);
  });
});

describe('auth', () => {
  it('anonymous → 401', async () => {
    const h = makeChallengeGradeHandler({ callModel: okModel(), loadAnswer: okLoad() });
    const res = mockRes();
    await h(mockReq({ tutorialSlug: 's', stepNumber: 1, nodeId: 'n', submittedAnswer: 'a' }, { id: 'anonymous' }), res);
    expect(res.statusCode).toBe(401);
  });
  it('no user → 401', async () => {
    const h = makeChallengeGradeHandler({ callModel: okModel(), loadAnswer: okLoad() });
    const res = mockRes();
    await h(mockReq({ tutorialSlug: 's', stepNumber: 1, nodeId: 'n', submittedAnswer: 'a' }, null), res);
    expect(res.statusCode).toBe(401);
  });
});

describe('body validation', () => {
  const cases = [
    ['missing slug', { stepNumber: 1, nodeId: 'n', submittedAnswer: 'a' }],
    ['missing stepNumber', { tutorialSlug: 's', nodeId: 'n', submittedAnswer: 'a' }],
    ['missing nodeId', { tutorialSlug: 's', stepNumber: 1, submittedAnswer: 'a' }],
    ['missing submittedAnswer', { tutorialSlug: 's', stepNumber: 1, nodeId: 'n' }],
  ];
  for (const [name, body] of cases) {
    it(`${name} → 400 invalid_body`, async () => {
      const h = makeChallengeGradeHandler({ callModel: okModel(), loadAnswer: okLoad() });
      const res = mockRes();
      await h(mockReq(body), res);
      expect(res.statusCode).toBe(400);
      expect(res.jsonBody).toEqual({ error: 'invalid_body' });
    });
  }

  it('submittedAnswer over 5 KB → 400 too_long', async () => {
    const h = makeChallengeGradeHandler({ callModel: okModel(), loadAnswer: okLoad() });
    const res = mockRes();
    await h(mockReq({ tutorialSlug: 's', stepNumber: 1, nodeId: 'n', submittedAnswer: 'a'.repeat(5_001) }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'too_long' });
  });
});

describe('happy path + disabled', () => {
  it('valid request → 200 with verdict', async () => {
    const h = makeChallengeGradeHandler({ callModel: okModel(), loadAnswer: okLoad() });
    const res = mockRes();
    await h(mockReq({ tutorialSlug: 's', stepNumber: 2, nodeId: 'challenge-2-0', submittedAnswer: 'a' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.verdict).toBe('pass');
  });

  it('flag OFF → 503 disabled', async () => {
    await setFlag('false');
    const h = makeChallengeGradeHandler({ callModel: okModel(), loadAnswer: okLoad() });
    const res = mockRes();
    await h(mockReq({ tutorialSlug: 's', stepNumber: 2, nodeId: 'challenge-2-0', submittedAnswer: 'a' }), res);
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toEqual({ error: 'disabled' });
  });
});

describe('rate limiting', () => {
  it('6th call in the per-step window → 429', async () => {
    const h = makeChallengeGradeHandler({ callModel: okModel(), loadAnswer: okLoad() });
    const body = { tutorialSlug: 's', stepNumber: 2, nodeId: 'challenge-2-0', submittedAnswer: 'a' };
    for (let i = 0; i < 5; i++) {
      const res = mockRes();
      await h(mockReq(body), res);
      expect(res.statusCode).toBe(200);
    }
    const res6 = mockRes();
    await h(mockReq(body), res6);
    expect(res6.statusCode).toBe(429);
    expect(res6.jsonBody.error).toBe('rate_limited');
    expect(res6.headers['Retry-After']).toBeDefined();
  });
});
