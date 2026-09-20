// test/unit/challenge-answer-publish.test.js
// Unit tests for POST /content/challenge-answers handler (#2441).
// Mirrors test/unit/validate-answer-spec-publish.test.js — REPLACE-per-slug
// semantics for ChallengeAnswers. Auth is contentAuthMiddleware's job (there is
// no legacy in-handler auth factory for this endpoint), so these exercise the
// handler directly.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { publishChallengeAnswers } from '../../srv/lib/challenge-answer-publish.js';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

async function seedTutorials() {
  const { ChallengeAnswers, Tutorials } = cds.entities('com.sap.developers.ims');
  await DELETE.from(ChallengeAnswers);
  await DELETE.from(Tutorials);
  await INSERT.into(Tutorials).entries([
    { ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', slug: 'tutorial-alpha', title: 'Alpha', status: 'ACTIVE' },
    { ID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', slug: 'tutorial-beta',  title: 'Beta',  status: 'ACTIVE' },
  ]);
}

beforeEach(async () => { await seedTutorials(); });

function mockReq(body) {
  return { body };
}
function mockRes() {
  return {
    statusCode: 200,
    jsonBody: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.jsonBody = b; return this; },
  };
}

describe('body validation', () => {
  it('missing slug → 400 invalid_body', async () => {
    const res = mockRes();
    await publishChallengeAnswers(mockReq({ answers: [] }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });

  it('answers not an array → 400 invalid_body', async () => {
    const res = mockRes();
    await publishChallengeAnswers(mockReq({ slug: 'tutorial-alpha', answers: 'oops' }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });

  it('answer missing reference → 400 invalid_answer', async () => {
    const res = mockRes();
    await publishChallengeAnswers(mockReq({
      slug: 'tutorial-alpha',
      answers: [{ stepNumber: 1, nodeId: 'challenge-1-0' }],
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_answer' });
  });

  it('reference over 10 KB → 400 too_long', async () => {
    const res = mockRes();
    await publishChallengeAnswers(mockReq({
      slug: 'tutorial-alpha',
      answers: [{ stepNumber: 1, nodeId: 'challenge-1-0', reference: 'a'.repeat(10_001) }],
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'too_long' });
  });
});

describe('tutorial not found', () => {
  it('unknown slug → 404 tutorial_not_found', async () => {
    const res = mockRes();
    await publishChallengeAnswers(mockReq({
      slug: 'no-such-tutorial',
      answers: [{ stepNumber: 1, nodeId: 'challenge-1-0', reference: 'Bar.' }],
    }), res);
    expect(res.statusCode).toBe(404);
    expect(res.jsonBody).toEqual({ error: 'tutorial_not_found' });
  });
});

describe('happy path', () => {
  it('single answer → 200, row visible in DB with correct FK + content', async () => {
    const res = mockRes();
    await publishChallengeAnswers(mockReq({
      slug: 'tutorial-alpha',
      answers: [{ stepNumber: 2, nodeId: 'challenge-2-1', reference: 'The answer.', prompt: 'What?' }],
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ ok: true, count: 1 });

    const { ChallengeAnswers } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(ChallengeAnswers);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.tutorial_ID).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(r.stepNumber).toBe(2);
    expect(r.nodeId).toBe('challenge-2-1');
    expect(r.reference).toBe('The answer.');
    expect(r.prompt).toBe('What?');
  });

  it('prompt is optional → null when absent', async () => {
    const res = mockRes();
    await publishChallengeAnswers(mockReq({
      slug: 'tutorial-alpha',
      answers: [{ stepNumber: 1, nodeId: 'challenge-1-0', reference: 'x' }],
    }), res);
    expect(res.statusCode).toBe(200);
    const { ChallengeAnswers } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(ChallengeAnswers);
    expect(rows[0].prompt).toBe(null);
  });
});

describe('replace semantics', () => {
  it('publish A with 2 → publish A with 1 → only new one remains', async () => {
    const res1 = mockRes();
    await publishChallengeAnswers(mockReq({
      slug: 'tutorial-alpha',
      answers: [
        { stepNumber: 1, nodeId: 'challenge-1-0', reference: 'A1' },
        { stepNumber: 2, nodeId: 'challenge-2-0', reference: 'A2' },
      ],
    }), res1);
    expect(res1.jsonBody).toEqual({ ok: true, count: 2 });

    const res2 = mockRes();
    await publishChallengeAnswers(mockReq({
      slug: 'tutorial-alpha',
      answers: [{ stepNumber: 5, nodeId: 'challenge-5-0', reference: 'A5' }],
    }), res2);
    expect(res2.jsonBody).toEqual({ ok: true, count: 1 });

    const { ChallengeAnswers } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(ChallengeAnswers);
    expect(rows).toHaveLength(1);
    expect(rows[0].stepNumber).toBe(5);
  });
});

describe('other slugs untouched', () => {
  it('publish A → publish B → A rows still present', async () => {
    const resA = mockRes();
    await publishChallengeAnswers(mockReq({
      slug: 'tutorial-alpha',
      answers: [{ stepNumber: 1, nodeId: 'challenge-1-0', reference: 'A-A' }],
    }), resA);
    expect(resA.statusCode).toBe(200);

    const resB = mockRes();
    await publishChallengeAnswers(mockReq({
      slug: 'tutorial-beta',
      answers: [{ stepNumber: 4, nodeId: 'challenge-4-0', reference: 'B-A' }],
    }), resB);
    expect(resB.statusCode).toBe(200);

    const { ChallengeAnswers } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(ChallengeAnswers);
    expect(rows).toHaveLength(2);
  });
});

describe('slug lowercased on lookup', () => {
  it('mixed-case slug resolves to the lowercase tutorial row', async () => {
    const res = mockRes();
    await publishChallengeAnswers(mockReq({
      slug: 'Tutorial-ALPHA',
      answers: [{ stepNumber: 1, nodeId: 'challenge-1-0', reference: 'Y' }],
    }), res);
    expect(res.statusCode).toBe(200);
    const { ChallengeAnswers } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(ChallengeAnswers);
    expect(rows[0].tutorial_ID).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });
});

describe('duplicate composite-key guard', () => {
  it('two answers with same (stepNumber, nodeId) → 400 duplicate_answer_key', async () => {
    const res = mockRes();
    await publishChallengeAnswers(mockReq({
      slug: 'tutorial-alpha',
      answers: [
        { stepNumber: 3, nodeId: 'challenge-3-0', reference: 'x' },
        { stepNumber: 3, nodeId: 'challenge-3-0', reference: 'y' },
      ],
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'duplicate_answer_key', stepNumber: 3, nodeId: 'challenge-3-0' });
  });

  it('duplicate guard fires BEFORE any DB write (no partial rows)', async () => {
    const res = mockRes();
    await publishChallengeAnswers(mockReq({
      slug: 'tutorial-alpha',
      answers: [
        { stepNumber: 7, nodeId: 'dup', reference: 'x' },
        { stepNumber: 7, nodeId: 'dup', reference: 'y' },
      ],
    }), res);
    expect(res.statusCode).toBe(400);
    const { ChallengeAnswers } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(ChallengeAnswers);
    expect(rows).toHaveLength(0);
  });
});

describe('coarse 500 reason', () => {
  it('500 body carries a { error:internal, reason } shape', async () => {
    const res = mockRes();
    const originalTx = cds.tx;
    cds.tx = async () => { const e = new Error('boom'); e.code = 'FORCED_TEST_ERROR'; throw e; };
    try {
      await publishChallengeAnswers(mockReq({
        slug: 'tutorial-alpha',
        answers: [{ stepNumber: 1, nodeId: 'challenge-1-0', reference: 'A' }],
      }), res);
    } finally {
      cds.tx = originalTx;
    }
    expect(res.statusCode).toBe(500);
    expect(res.jsonBody).toEqual({ error: 'internal', reason: 'FORCED_TEST_ERROR' });
  });
});
