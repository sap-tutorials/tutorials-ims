// test/unit/code-check-spec-publish.test.js
// Unit tests for POST /content/code-check-specs handler.
// Uses the same SQLite-in-memory + mock req/res pattern as code-check-handler.test.js.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { codeCheckSpecPublishHandler } from '../../srv/lib/code-check-spec-publish.js';

// ── DB Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedTutorials() {
  const { CodeCheckSpecs, Tutorials } = cds.entities('com.sap.developers.ims');
  await DELETE.from(CodeCheckSpecs);
  await DELETE.from(Tutorials);

  await INSERT.into(Tutorials).entries([
    { ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', slug: 'tutorial-alpha', title: 'Alpha', status: 'ACTIVE' },
    { ID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', slug: 'tutorial-beta',  title: 'Beta',  status: 'ACTIVE' },
  ]);
}

beforeEach(async () => {
  await seedTutorials();
});

// ── Mock req/res factory ──────────────────────────────────────────────────────

function mockReq(body) {
  return { body };
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

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Happy path — two specs against two known slugs → both upserted
// ─────────────────────────────────────────────────────────────────────────────

describe('happy path', () => {
  it('two specs against two known slugs → 200, upserted:2, skipped:[]', async () => {
    const req = mockReq({
      specs: [
        { slug: 'tutorial-alpha', stepNumber: 1, goal: 'Print hello', language: 'javascript' },
        { slug: 'tutorial-beta',  stepNumber: 3, goal: 'Add a route',  language: 'javascript' },
      ],
    });
    const res = mockRes();
    await codeCheckSpecPublishHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ upserted: 2, skipped: [] });

    // Verify the rows are actually in the DB
    const { CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(CodeCheckSpecs);
    expect(rows).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Unknown slug → skipped in response
// ─────────────────────────────────────────────────────────────────────────────

describe('slug not found', () => {
  it('unknown slug is skipped; known slug is upserted', async () => {
    const req = mockReq({
      specs: [
        { slug: 'tutorial-alpha', stepNumber: 1, goal: 'Print hello', language: 'javascript' },
        { slug: 'unknown-slug',   stepNumber: 2, goal: 'Should skip', language: 'javascript' },
      ],
    });
    const res = mockRes();
    await codeCheckSpecPublishHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ upserted: 1, skipped: ['unknown-slug'] });

    // Only one row should be in the DB
    const { CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(CodeCheckSpecs);
    expect(rows).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Idempotent — same payload twice → row count unchanged after second call
// Also verifies carry-forward: rows not in 2nd payload remain in DB.
// ─────────────────────────────────────────────────────────────────────────────

describe('idempotent upsert', () => {
  it('second call with same payload leaves row count unchanged', async () => {
    const specs = [
      { slug: 'tutorial-alpha', stepNumber: 1, goal: 'Print hello', language: 'javascript' },
      { slug: 'tutorial-beta',  stepNumber: 2, goal: 'Add a route',  language: 'javascript' },
    ];

    // First call
    const res1 = mockRes();
    await codeCheckSpecPublishHandler(mockReq({ specs }), res1);
    expect(res1.statusCode).toBe(200);
    expect(res1.jsonBody.upserted).toBe(2);

    // Second call — same payload
    const res2 = mockRes();
    await codeCheckSpecPublishHandler(mockReq({ specs }), res2);
    expect(res2.statusCode).toBe(200);
    expect(res2.jsonBody.upserted).toBe(2);

    // Row count should still be 2 (not 4)
    const { CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(CodeCheckSpecs);
    expect(rows).toHaveLength(2);
  });

  it('carry-forward: a row from a previous call not in the second payload stays in DB', async () => {
    // First call: insert alpha-step1
    const res1 = mockRes();
    await codeCheckSpecPublishHandler(mockReq({
      specs: [{ slug: 'tutorial-alpha', stepNumber: 1, goal: 'Print hello', language: 'javascript' }],
    }), res1);
    expect(res1.jsonBody.upserted).toBe(1);

    // Second call: only beta-step3 — alpha-step1 should NOT be deleted
    const res2 = mockRes();
    await codeCheckSpecPublishHandler(mockReq({
      specs: [{ slug: 'tutorial-beta', stepNumber: 3, goal: 'Add route', language: 'javascript' }],
    }), res2);
    expect(res2.jsonBody.upserted).toBe(1);

    // Both rows should exist
    const { CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(CodeCheckSpecs);
    expect(rows).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Hints stored as JSON string
// ─────────────────────────────────────────────────────────────────────────────

describe('hints serialization', () => {
  it('hints array is JSON.stringified before storage', async () => {
    const req = mockReq({
      specs: [
        { slug: 'tutorial-alpha', stepNumber: 5, goal: 'Use hints', language: 'javascript', hints: ['a', 'b'] },
      ],
    });
    const res = mockRes();
    await codeCheckSpecPublishHandler(req, res);
    expect(res.statusCode).toBe(200);

    const { CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(CodeCheckSpecs).where({
      tutorial_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      stepNumber: 5,
    });
    expect(row).toBeTruthy();
    // hints must be a string, not an array
    expect(typeof row.hints).toBe('string');
    expect(row.hints).toBe('["a","b"]');
  });

  it('hints stored as null when not an array (string)', async () => {
    const req = mockReq({
      specs: [
        { slug: 'tutorial-alpha', stepNumber: 6, goal: 'Use hints', language: 'javascript', hints: 'not an array' },
      ],
    });
    const res = mockRes();
    await codeCheckSpecPublishHandler(req, res);
    expect(res.statusCode).toBe(200);

    const { CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(CodeCheckSpecs).where({
      tutorial_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      stepNumber: 6,
    });
    expect(row).toBeTruthy();
    expect(row.hints).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Validation — fail-fast on invalid specs
// ─────────────────────────────────────────────────────────────────────────────

describe('validation', () => {
  it('body missing specs array → 400 invalid_body', async () => {
    const res = mockRes();
    await codeCheckSpecPublishHandler(mockReq({}), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });

  it('body is null → 400 invalid_body', async () => {
    const res = mockRes();
    await codeCheckSpecPublishHandler(mockReq(null), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });

  it('specs is not an array → 400 invalid_body', async () => {
    const res = mockRes();
    await codeCheckSpecPublishHandler(mockReq({ specs: 'oops' }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_body' });
  });

  it('spec missing goal → 400 invalid_spec', async () => {
    const res = mockRes();
    await codeCheckSpecPublishHandler(mockReq({
      specs: [{ slug: 'tutorial-alpha', stepNumber: 1 }],
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_spec' });
  });

  it('spec with empty goal string → 400 invalid_spec', async () => {
    const res = mockRes();
    await codeCheckSpecPublishHandler(mockReq({
      specs: [{ slug: 'tutorial-alpha', stepNumber: 1, goal: '' }],
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_spec' });
  });

  it('spec missing slug → 400 invalid_spec', async () => {
    const res = mockRes();
    await codeCheckSpecPublishHandler(mockReq({
      specs: [{ stepNumber: 1, goal: 'Do something' }],
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_spec' });
  });

  it('spec missing stepNumber → 400 invalid_spec', async () => {
    const res = mockRes();
    await codeCheckSpecPublishHandler(mockReq({
      specs: [{ slug: 'tutorial-alpha', goal: 'Do something' }],
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_spec' });
  });

  it('stepNumber as string (not a number) → 400 invalid_spec', async () => {
    const res = mockRes();
    await codeCheckSpecPublishHandler(mockReq({
      specs: [{ slug: 'tutorial-alpha', stepNumber: '1', goal: 'Do something' }],
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_spec' });
  });

  it('fail-fast: bad spec in position 1 prevents upsert of spec in position 0', async () => {
    // First spec is valid; second is missing goal → whole payload rejected
    const res = mockRes();
    await codeCheckSpecPublishHandler(mockReq({
      specs: [
        { slug: 'tutorial-alpha', stepNumber: 1, goal: 'Valid spec' },
        { slug: 'tutorial-beta',  stepNumber: 2 },  // missing goal
      ],
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'invalid_spec' });

    // No rows should have been written (fail-fast, pre-validation before any DB write)
    const { CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(CodeCheckSpecs);
    expect(rows).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: hasReference is set correctly
// ─────────────────────────────────────────────────────────────────────────────

describe('hasReference flag', () => {
  it('hasReference=true when referenceSolution is non-empty', async () => {
    const res = mockRes();
    await codeCheckSpecPublishHandler(mockReq({
      specs: [{ slug: 'tutorial-alpha', stepNumber: 1, goal: 'Something', referenceSolution: 'console.log(42)' }],
    }), res);
    expect(res.statusCode).toBe(200);

    const { CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(CodeCheckSpecs).where({
      tutorial_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', stepNumber: 1,
    });
    expect(row.hasReference).toBe(true);
    expect(row.referenceSolution).toBe('console.log(42)');
  });

  it('hasReference=false when referenceSolution is omitted', async () => {
    const res = mockRes();
    await codeCheckSpecPublishHandler(mockReq({
      specs: [{ slug: 'tutorial-alpha', stepNumber: 1, goal: 'Something' }],
    }), res);
    expect(res.statusCode).toBe(200);

    const { CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(CodeCheckSpecs).where({
      tutorial_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', stepNumber: 1,
    });
    expect(row.hasReference).toBe(false);
  });
});
