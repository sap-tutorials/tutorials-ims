// test/hybrid/code-check.test.js
// Hybrid test suite for the AI code-check feature (issue #171).
// Runs against real HANA via `cds bind --exec` (npm run test:hybrid).
// LLM is mocked — no live model tokens spent in CI.
//
// Prerequisite: ALLOW_HYBRID_WRITES=true environment variable must be set.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { codeCheckSpecPublishHandler } from '../../srv/lib/code-check-spec-publish.js';
import { dispatchCheckCode } from '../../srv/lib/code-check-tool.js';

// ─── Test data prefix & IDs ──────────────────────────────────────────────────

const TEST_PREFIX = '__TEST__cc-171-';
const SLUG_A = `${TEST_PREFIX}slug-a`;
const SLUG_B = `${TEST_PREFIX}slug-b`;

// UUIDs assigned in beforeAll so afterAll can delete them unambiguously.
let tutAId, tutBId;

// ─── Suite setup ─────────────────────────────────────────────────────────────

cds.test('serve', '--project', '.', '--profile', 'hybrid');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal fake Express req/res pair for testing the handler directly.
 * `res.capture` is set to the last call argument after the suite finishes.
 */
function fakeHttp(body) {
  const captured = { status: null, json: null };
  const res = {
    status(code) { captured.status = code; return res; },
    json(payload) { captured.json = payload; return res; },
    _captured: captured,
  };
  const req = { body };
  return { req, res, captured };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe.runIf(isSafeForWrites())('code-check hybrid — real HANA + mock LLM', () => {

  // ── Seed two Tutorials rows ───────────────────────────────────────────────

  beforeAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
      throw new Error('Set ALLOW_HYBRID_WRITES=true to run the hybrid suite');
    }

    const { Tutorials, ChatSettings } = cds.entities('com.sap.developers.ims');

    tutAId = cds.utils.uuid();
    tutBId = cds.utils.uuid();

    await INSERT.into(Tutorials).entries([
      { ID: tutAId, slug: SLUG_A, title: `${TEST_PREFIX}Tutorial A`, status: 'ACTIVE' },
      { ID: tutBId, slug: SLUG_B, title: `${TEST_PREFIX}Tutorial B`, status: 'ACTIVE' },
    ]);

    // Ensure ChatSettings allows code-check (upsert the singleton row if absent).
    const existing = await SELECT.one.from(ChatSettings);
    if (!existing) {
      await INSERT.into(ChatSettings).entries({
        ID: cds.utils.uuid(),
        enabled: true,
        codeCheckEnabled: true,
      });
    } else if (!existing.codeCheckEnabled) {
      await UPDATE(ChatSettings, existing.ID).set({ codeCheckEnabled: true });
    }
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────

  afterAll(async () => {
    const { CodeCheckSubmissions, CodeCheckSpecs, Tutorials } =
      cds.entities('com.sap.developers.ims');

    // Delete child rows first to avoid FK violations on HANA.
    await DELETE.from(CodeCheckSubmissions).where({ tutorialSlug: { like: `${TEST_PREFIX}%` } });
    await DELETE.from(CodeCheckSpecs).where({ tutorial_ID: { in: [tutAId, tutBId].filter(Boolean) } });
    await DELETE.from(Tutorials).where({ slug: { like: `${TEST_PREFIX}%` } });
  });

  // ─── Test 1: Publish flow ─────────────────────────────────────────────────
  //
  // POST /content/code-check-specs with specs for SLUG_A (step 1) and
  // SLUG_B (step 2). Verify both rows land in CodeCheckSpecs joined to their
  // parent Tutorials rows.

  it('publish: upserts two specs and links them to Tutorials rows', async () => {
    const { req, res, captured } = fakeHttp({
      specs: [
        { slug: SLUG_A, stepNumber: 1, goal: `${TEST_PREFIX}goal A`, language: 'javascript' },
        { slug: SLUG_B, stepNumber: 2, goal: `${TEST_PREFIX}goal B`, language: 'python' },
      ],
    });

    await codeCheckSpecPublishHandler(req, res);

    expect(captured.status).toBe(200);
    expect(captured.json.upserted).toBe(2);
    expect(captured.json.skipped).toHaveLength(0);

    // Verify rows in HANA.
    const { CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
    const specA = await SELECT.one.from(CodeCheckSpecs).where({ tutorial_ID: tutAId, stepNumber: 1 });
    const specB = await SELECT.one.from(CodeCheckSpecs).where({ tutorial_ID: tutBId, stepNumber: 2 });

    expect(specA).toBeTruthy();
    expect(specA.goal).toBe(`${TEST_PREFIX}goal A`);
    expect(specA.language).toBe('javascript');

    expect(specB).toBeTruthy();
    expect(specB.goal).toBe(`${TEST_PREFIX}goal B`);
    expect(specB.language).toBe('python');
  });

  // ─── Test 2: Carry-forward semantics ─────────────────────────────────────
  //
  // Publish only SLUG_A's spec again (with updated goal). SLUG_B's spec must
  // NOT be deleted — the handler has carry-forward semantics.

  it('carry-forward: re-publishing only one spec does not delete the other', async () => {
    const { req, res, captured } = fakeHttp({
      specs: [
        { slug: SLUG_A, stepNumber: 1, goal: `${TEST_PREFIX}goal A updated`, language: 'javascript' },
      ],
    });

    await codeCheckSpecPublishHandler(req, res);

    expect(captured.status).toBe(200);
    expect(captured.json.upserted).toBe(1);

    const { CodeCheckSpecs } = cds.entities('com.sap.developers.ims');

    // SLUG_A's spec is updated.
    const specA = await SELECT.one.from(CodeCheckSpecs).where({ tutorial_ID: tutAId, stepNumber: 1 });
    expect(specA.goal).toBe(`${TEST_PREFIX}goal A updated`);

    // SLUG_B's spec is retained (carry-forward).
    const specB = await SELECT.one.from(CodeCheckSpecs).where({ tutorial_ID: tutBId, stepNumber: 2 });
    expect(specB).toBeTruthy();
    expect(specB.goal).toBe(`${TEST_PREFIX}goal B`);
  });

  // ─── Test 3: dispatchCheckCode against real HANA + mock LLM ─────────────
  //
  // Seed a spec for SLUG_A (step 3), call dispatchCheckCode with a mock
  // callModel, verify a CodeCheckSubmissions row lands in HANA with full
  // telemetry fields populated.

  it('dispatch: persists a submission row in HANA with full telemetry', async () => {
    // Seed a spec for step 3 on SLUG_A.
    const { CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
    await INSERT.into(CodeCheckSpecs).entries({
      tutorial_ID: tutAId,
      stepNumber: 3,
      goal: `${TEST_PREFIX}dispatch goal`,
      language: 'javascript',
      referenceSolution: null,
      hasReference: false,
    });

    const mockCallModel = vi.fn().mockResolvedValue({
      verdict: { verdict: 'pass', summary: 'Looks good', correctAspects: ['logic'], suggestions: [] },
      promptTokens: 1200,
      completionTokens: 150,
      modelName: 'gpt-4o-mock',
    });

    const result = await dispatchCheckCode(
      { tutorialSlug: SLUG_A, stepNumber: 3, submittedCode: 'console.log("hello")' },
      {
        user: { id: `${TEST_PREFIX}user-dispatch` },
        callModel: mockCallModel,
        loadStepText: async () => null,
      },
    );

    expect(result.verdict).toBe('pass');
    expect(result.summary).toBe('Looks good');

    // Verify the row is in HANA.
    const { CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(CodeCheckSubmissions)
      .where({ tutorialSlug: SLUG_A, stepNumber: 3 });

    expect(rows.length).toBeGreaterThanOrEqual(1);

    const row = rows[rows.length - 1]; // most recent
    expect(row.verdict).toBe('pass');
    expect(row.promptTokens).toBe(1200);
    expect(row.completionTokens).toBe(150);
    expect(row.modelName).toBe('gpt-4o-mock');
    expect(row.tutorialSlug).toBe(SLUG_A);
    expect(row.stepNumber).toBe(3);
    expect(row.errorReason).toBeFalsy();
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mockCallModel).toHaveBeenCalledOnce();
  });

  // ─── Test 4: @PersonalData cascade ────────────────────────────────────────
  //
  // SKIPPED — the current _executeAnonymization implementation (admin-service.js:829)
  // only nulls Users fields, deletes UserMetaData, and updates TaskRecords audit
  // fields. It does NOT null CodeCheckSubmissions.user_ID or
  // CodeCheckSubmissions.submittedCode, even though db/audit-logging.cds annotates
  // that entity with @PersonalData: { EntitySemantics: 'Other' } and
  // submittedCode with @PersonalData.IsPotentiallyPersonal.
  //
  // When the anonymization handler is extended to cover CodeCheckSubmissions
  // (a natural follow-up to this PR), this skip should become a real test:
  //
  //   1. Seed a Users row and a CodeCheckSubmissions row linked via user_ID.
  //   2. Call AdminService.anonymizeUser({ sapId }) via srv.send(...).
  //   3. Re-read the submission; assert user_ID is null and submittedCode is null.
  //
  // Tracking: the @PersonalData annotation is already in place on the entity.
  // The gap is purely in the _executeAnonymization method body.

  it('@PersonalData cascade: anonymizeUser nulls user_ID + submittedCode on CodeCheckSubmissions', async () => {
    const { Users, CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    const TEST_USER_ID = '__TEST__cc-211-cascade-user';
    const TEST_SAP_ID = '__TEST__cc-211-cascade-sapid';
    const TEST_SUB_ID = '__TEST__cc-211-cascade-sub';

    // Seed a user + a submission linked via FK
    await INSERT.into(Users).entries({
      ID: TEST_USER_ID,
      sapId: TEST_SAP_ID,
      firstName: '__TEST__cc-211-Alice',
      email: '__TEST__cc-211-alice@example.com'
    });
    await INSERT.into(CodeCheckSubmissions).entries({
      ID: TEST_SUB_ID,
      user_ID: TEST_USER_ID,
      tutorialSlug: '__TEST__cc-211-tutorial',
      stepNumber: 1,
      submittedCode: 'console.log("personal");',
      verdict: 'pass'
    });

    // Sanity: row exists with FK and personal data
    const before = await SELECT.one.from(CodeCheckSubmissions).where({ ID: TEST_SUB_ID });
    expect(before.user_ID).toBe(TEST_USER_ID);
    expect(before.submittedCode).toBe('console.log("personal");');

    // Trigger anonymization via the AdminService action
    const admin = await cds.connect.to('AdminService');
    await admin.send('anonymizeUser', { sapId: TEST_SAP_ID });

    // Assert: FK nulled, personal field nulled, row preserved with telemetry intact
    const after = await SELECT.one.from(CodeCheckSubmissions).where({ ID: TEST_SUB_ID });
    expect(after).toBeDefined();
    expect(after.user_ID).toBeNull();
    expect(after.submittedCode).toBeNull();
    expect(after.verdict).toBe('pass'); // analytical column intact
  });

  // ─── Test 5: @analytics.exposed query works ──────────────────────────────
  //
  // AnalyticsService.runSelectQuery against the physical HANA table
  // COM_SAP_DEVELOPERS_IMS_CODECHECKSUBMISSIONS. Asserts that:
  //   - At least one row is returned (the dispatch test above seeded data).
  //   - The response metadata.rowCount is <= 5000 (LIMIT 5001 cap).
  //   - The response has columns and rows arrays.

  it('@analytics.exposed: runSelectQuery on CodeCheckSubmissions returns rows bounded by LIMIT 5001', async () => {
    const srv = await cds.connect.to('AnalyticsService');

    const result = await srv.send('runSelectQuery', {
      sql: 'SELECT verdict, COUNT(*) AS cnt FROM "COM_SAP_DEVELOPERS_IMS_CODECHECKSUBMISSIONS" GROUP BY verdict',
    });

    // The action returns { columns, rows, metadata, ... }.
    expect(Array.isArray(result.columns)).toBe(true);
    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.metadata.rowCount).toBeGreaterThan(0);
    expect(result.metadata.rowCount).toBeLessThanOrEqual(5000);
    expect(result.metadata.truncated).toBe(false);

    // At least one verdict bucket must be present (the dispatch test above
    // inserted a 'pass' row).
    const verdictValues = result.rows.map(r => r[0]);
    expect(verdictValues.some(v => v !== null)).toBe(true);
  });
});
