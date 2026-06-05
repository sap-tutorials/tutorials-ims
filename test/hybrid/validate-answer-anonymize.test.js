// test/hybrid/validate-answer-anonymize.test.js
// Hybrid test: @PersonalData cascade for ValidateAnswerSubmissions (#209).
// Runs against real HANA via `cds bind --exec` (npm run test:hybrid).
//
// Verifies that AdminService.anonymizeUser triggers the cascade walker
// (srv/lib/anonymization-cascade.js, shipped in PR #221) and that
// ValidateAnswerSubmissions rows for the anonymized user have:
//   - user_ID nulled (FieldSemantics: 'DataSubjectID')
//   - submittedAnswer nulled (IsPotentiallyPersonal)
// while analytical columns (verdict, latencyMs) survive. This is the
// 'null-personal' default cascade action — see the architecture reference at
// docs/developers/architecture/anonymization-cascade.md.
//
// Prerequisite: ALLOW_HYBRID_WRITES=true environment variable must be set.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const TEST_PREFIX = '__TEST__va-209-';
const TEST_USER_ID = `${TEST_PREFIX}cascade-user`;
const TEST_SAP_ID = `${TEST_PREFIX}cascade-sapid`;
const TEST_SUB_ID = `${TEST_PREFIX}cascade-sub`;
const TEST_SLUG = `${TEST_PREFIX}tutorial`;

describe.runIf(isSafeForWrites())('validate-answer hybrid — @PersonalData cascade (#209)', () => {

  beforeAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
      throw new Error('Set ALLOW_HYBRID_WRITES=true to run the hybrid suite');
    }
  });

  afterAll(async () => {
    const { ValidateAnswerSubmissions, Users } = cds.entities('com.sap.developers.ims');
    // Clean up by stable ID — sapId is nulled by anonymizeUser, so we can't
    // find Users by sapId post-anonymize.
    await DELETE.from(ValidateAnswerSubmissions).where({ tutorialSlug: { like: `${TEST_PREFIX}%` } });
    await DELETE.from(Users).where({ ID: TEST_USER_ID });
  });

  // ─── Test: cascade NULLs user_ID + submittedAnswer ──────────────────────

  it('@PersonalData cascade: anonymizeUser nulls user_ID + submittedAnswer on ValidateAnswerSubmissions', async () => {
    const { Users, ValidateAnswerSubmissions } = cds.entities('com.sap.developers.ims');

    // Seed a user + a submission linked via FK
    await INSERT.into(Users).entries({
      ID: TEST_USER_ID,
      sapId: TEST_SAP_ID,
      firstName: `${TEST_PREFIX}Alice`,
      email: `${TEST_PREFIX}alice@example.invalid`,
    });
    await INSERT.into(ValidateAnswerSubmissions).entries({
      ID: TEST_SUB_ID,
      user_ID: TEST_USER_ID,
      tutorialSlug: TEST_SLUG,
      stepNumber: 1,
      questionId: 'validate-1',
      submittedAnswer: 'personal answer text',
      verdict: 'pass',
      promptVersion: 'v1',
      latencyMs: 1234,
    });

    // Sanity: row exists with FK and personal data
    const before = await SELECT.one.from(ValidateAnswerSubmissions).where({ ID: TEST_SUB_ID });
    expect(before).toBeDefined();
    expect(before.user_ID).toBe(TEST_USER_ID);
    expect(before.submittedAnswer).toBe('personal answer text');

    // Trigger anonymization via the AdminService action (signature: anonymizeUser({ sapId }))
    const admin = await cds.connect.to('AdminService');
    await admin.send('anonymizeUser', { sapId: TEST_SAP_ID });

    // Assert: FK nulled, personal field nulled, row preserved with telemetry intact
    const after = await SELECT.one.from(ValidateAnswerSubmissions).where({ ID: TEST_SUB_ID });
    expect(after).toBeDefined();
    expect(after.user_ID).toBeNull();
    expect(after.submittedAnswer).toBeNull();
    // Analytical / telemetry columns preserved
    expect(after.verdict).toBe('pass');
    expect(after.latencyMs).toBe(1234);
    expect(after.tutorialSlug).toBe(TEST_SLUG);
  });
});
