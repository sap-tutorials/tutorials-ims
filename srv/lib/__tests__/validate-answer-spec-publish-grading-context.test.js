// srv/lib/__tests__/validate-answer-spec-publish-grading-context.test.js
// TDD tests for grading-context extension to validate-answer-specs publish.
// Task 3 of #3090: carry grading context from parse → publish → HANA.
//
// Pattern: ephemeral express server with in-memory SQLite (mirrors
// srv/lib/__tests__/alerts-endpoint.test.js). No supertest — uses Node's
// built-in fetch. Auth is bypassed by wiring publishValidateAnswerSpecs
// directly (no contentAuthMiddleware), mirroring the pattern used in
// other publish-handler unit tests.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { publishValidateAnswerSpecs } from '../validate-answer-spec-publish.js';

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

let db;
let server;
let baseUrl;

// One Tutorials row shared across all tests.
const TEST_SLUG = 'grading-ctx-test-tutorial';
let tutorialID;

beforeAll(async () => {
  cds.env.requires.db = { kind: 'sqlite', credentials: { database: ':memory:' } };
  db = await cds.deploy(schemaPath).to('sqlite::memory:');

  // Insert a Tutorials row so slug resolution succeeds.
  const { Tutorials } = cds.entities('com.sap.developers.ims');
  tutorialID = cds.utils.uuid();
  await INSERT.into(Tutorials).entries({
    ID: tutorialID,
    slug: TEST_SLUG,
    title: 'Grading Context Test Tutorial',
    // Required non-null fields (mirrors other publish tests):
    description: '',
    primaryTag: '',
    experience: 'Beginner',
    time: 10,
    auto_validation: false,
  });

  // Mount handler directly — skip contentAuthMiddleware for unit testing.
  const app = express();
  app.post('/content/validate-answer-specs', express.json({ limit: '5mb' }), publishValidateAnswerSpecs);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await db?.disconnect?.();
});

beforeEach(async () => {
  // Wipe grading context rows between tests.
  const { TutorialGradingContext } = cds.entities('com.sap.developers.ims');
  await DELETE.from(TutorialGradingContext);
});

/** POST helper — returns { status, body } */
async function post(payload) {
  const res = await fetch(`${baseUrl}/content/validate-answer-specs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

/** Minimal valid specs array (one spec so DELETE+INSERT path executes). */
function oneSpec(stepNumber = 1) {
  return [{
    stepNumber,
    questionId: `validate-${stepNumber}`,
    questionText: 'What is the answer?',
    correctAnswer: '42',
    ruleType: 'equal',
    aiGrading: true,
  }];
}

// ────────────────────────────────────────────────────────────────────────────
// Case (a): payload with gradingContext → exactly one TutorialGradingContext row
// ────────────────────────────────────────────────────────────────────────────
describe('case (a): gradingContext present → one row persisted', () => {
  it('writes one TutorialGradingContext row with the supplied context', async () => {
    const ctx = 'Domain: SAP ABAP\nGradingCriteria: Check that the code compiles.';
    const { status, body } = await post({
      slug: TEST_SLUG,
      specs: oneSpec(),
      gradingContext: ctx,
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const { TutorialGradingContext } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(TutorialGradingContext).where({ tutorial_ID: tutorialID });
    expect(rows).toHaveLength(1);
    expect(rows[0].context).toBe(ctx);
  });

  it('also works when specs array is empty (no specs but context present)', async () => {
    const ctx = 'Domain: UI5\nCommonMistakes: Forgetting to call sap.ui.require.';
    const { status } = await post({
      slug: TEST_SLUG,
      specs: [],
      gradingContext: ctx,
    });

    expect(status).toBe(200);

    const { TutorialGradingContext } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(TutorialGradingContext).where({ tutorial_ID: tutorialID });
    expect(rows).toHaveLength(1);
    expect(rows[0].context).toBe(ctx);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Case (b): re-publish with new context → row REPLACED not duplicated
// ────────────────────────────────────────────────────────────────────────────
describe('case (b): re-publish replaces existing context row', () => {
  it('replaces the previous row rather than inserting a second', async () => {
    const first = 'Domain: Cloud Foundry\nGradingCriteria: Uses cf push.';
    const second = 'Domain: Kyma\nGradingCriteria: Uses kubectl apply.';

    await post({ slug: TEST_SLUG, specs: oneSpec(), gradingContext: first });
    await post({ slug: TEST_SLUG, specs: oneSpec(), gradingContext: second });

    const { TutorialGradingContext } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(TutorialGradingContext).where({ tutorial_ID: tutorialID });
    expect(rows).toHaveLength(1);
    expect(rows[0].context).toBe(second);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Case (c): re-publish without gradingContext → row removed
// ────────────────────────────────────────────────────────────────────────────
describe('case (c): re-publish without gradingContext → row removed', () => {
  it('deletes the existing row when gradingContext is absent', async () => {
    // Seed a row first.
    await post({ slug: TEST_SLUG, specs: oneSpec(), gradingContext: 'Some context' });

    // Re-publish without gradingContext.
    const { status } = await post({ slug: TEST_SLUG, specs: oneSpec() });
    expect(status).toBe(200);

    const { TutorialGradingContext } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(TutorialGradingContext).where({ tutorial_ID: tutorialID });
    expect(rows).toHaveLength(0);
  });

  it('deletes the existing row when gradingContext is an empty string', async () => {
    await post({ slug: TEST_SLUG, specs: oneSpec(), gradingContext: 'Some context' });

    const { status } = await post({ slug: TEST_SLUG, specs: oneSpec(), gradingContext: '' });
    expect(status).toBe(200);

    const { TutorialGradingContext } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(TutorialGradingContext).where({ tutorial_ID: tutorialID });
    expect(rows).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Case (d): context > 10 000 bytes → rejected, no row written
// ────────────────────────────────────────────────────────────────────────────
describe('case (d): context over byte cap → 400 too_long, no row written', () => {
  it('rejects with 400 too_long when gradingContext exceeds MAX_FIELD_BYTES', async () => {
    // 10 001 bytes of ASCII 'x'.
    const oversize = 'x'.repeat(10_001);
    const { status, body } = await post({
      slug: TEST_SLUG,
      specs: oneSpec(),
      gradingContext: oversize,
    });

    expect(status).toBe(400);
    expect(body.error).toBe('too_long');

    // No row should have been inserted.
    const { TutorialGradingContext } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(TutorialGradingContext).where({ tutorial_ID: tutorialID });
    expect(rows).toHaveLength(0);
  });

  it('accepts context exactly at MAX_FIELD_BYTES (10 000 bytes)', async () => {
    const exactly = 'x'.repeat(10_000);
    const { status } = await post({
      slug: TEST_SLUG,
      specs: [],
      gradingContext: exactly,
    });

    expect(status).toBe(200);

    const { TutorialGradingContext } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(TutorialGradingContext).where({ tutorial_ID: tutorialID });
    expect(rows).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Case (e): unknown slug → reported as failure entry, no throw
// ────────────────────────────────────────────────────────────────────────────
describe('case (e): unknown slug → 404 tutorial_not_found, no unhandled throw', () => {
  it('returns 404 tutorial_not_found for an unknown slug', async () => {
    const { status, body } = await post({
      slug: 'does-not-exist-slug',
      specs: oneSpec(),
      gradingContext: 'Some context',
    });

    expect(status).toBe(404);
    expect(body.error).toBe('tutorial_not_found');
  });

  it('does not write any TutorialGradingContext row for the unknown slug', async () => {
    await post({
      slug: 'another-missing-slug',
      specs: oneSpec(),
      gradingContext: 'Context for ghost tutorial',
    });

    const { TutorialGradingContext } = cds.entities('com.sap.developers.ims');
    // No rows for our known tutorial either.
    const rows = await SELECT.from(TutorialGradingContext);
    expect(rows).toHaveLength(0);
  });
});
