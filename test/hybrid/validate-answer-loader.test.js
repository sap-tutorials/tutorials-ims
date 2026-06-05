// test/hybrid/validate-answer-loader.test.js
// Hybrid test: defaultLoadQuestion HANA quirks (#209).
// Runs against real HANA via `cds bind --exec` (npm run test:hybrid).
//
// Defends against two HANA-vs-SQLite divergences that unit tests (in-memory
// SQLite) cannot catch:
//
//   1. Boolean coercion — HANA may surface BOOLEAN columns as 0/1 integers
//      depending on the driver path. The loader's `Boolean(spec.aiGrading)`
//      must produce a real JS boolean (typeof === 'boolean'), not a number.
//
//   2. Slug case sensitivity — Tutorials.slug is stored lowercase canonical
//      ([feedback_audit_all_callers_of_buggy_primitive] / PR #132). The
//      loader's `slug.toLowerCase()` must find the lowercase-stored row even
//      when given a mixed-case slug input.
//
// Prerequisite: ALLOW_HYBRID_WRITES=true environment variable must be set.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { defaultLoadQuestion } from '../../srv/lib/validate-answer-question-loader.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const TEST_PREFIX = '__TEST__va-209-loader-';
const SLUG_TRUE = `${TEST_PREFIX}slug-aigrading-true`;
const SLUG_FALSE = `${TEST_PREFIX}slug-aigrading-false`;

let tutTrueId;
let tutFalseId;

describe.runIf(isSafeForWrites())('validate-answer hybrid — defaultLoadQuestion HANA quirks (#209)', () => {

  beforeAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
      throw new Error('Set ALLOW_HYBRID_WRITES=true to run the hybrid suite');
    }

    const { Tutorials, ValidateAnswerSpecs } = cds.entities('com.sap.developers.ims');

    tutTrueId = cds.utils.uuid();
    tutFalseId = cds.utils.uuid();

    await INSERT.into(Tutorials).entries([
      { ID: tutTrueId, slug: SLUG_TRUE, title: `${TEST_PREFIX}Tutorial T`, status: 'ACTIVE' },
      { ID: tutFalseId, slug: SLUG_FALSE, title: `${TEST_PREFIX}Tutorial F`, status: 'ACTIVE' },
    ]);

    await INSERT.into(ValidateAnswerSpecs).entries([
      {
        tutorial_ID: tutTrueId,
        stepNumber: 1,
        questionId: 'validate-1',
        questionText: 'AI-graded question?',
        correctAnswer: 'AI-graded reference answer.',
        ruleType: 'exact-match',
        aiGrading: true,
      },
      {
        tutorial_ID: tutFalseId,
        stepNumber: 2,
        questionId: 'validate-2',
        questionText: 'Plain-graded question?',
        correctAnswer: 'Plain reference.',
        ruleType: 'exact-match',
        aiGrading: false,
      },
    ]);
  });

  afterAll(async () => {
    const { ValidateAnswerSpecs, Tutorials } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ValidateAnswerSpecs).where({ tutorial_ID: { in: [tutTrueId, tutFalseId].filter(Boolean) } });
    await DELETE.from(Tutorials).where({ slug: { like: `${TEST_PREFIX}%` } });
  });

  // ─── Test 1: HANA boolean → JS boolean coercion (true) ────────────────────

  it('returns aiGrading === true (typeof boolean) for HANA-stored true value', async () => {
    const result = await defaultLoadQuestion(SLUG_TRUE, 1, 'validate-1');
    expect(result).not.toBeNull();
    expect(result.aiGrading).toBe(true);
    expect(typeof result.aiGrading).toBe('boolean'); // defends against HANA returning 0/1 ints
    expect(result.questionId).toBe('validate-1');
    expect(result.question).toBe('AI-graded question?');
    expect(result.correctAnswer).toBe('AI-graded reference answer.');
  });

  // ─── Test 2: HANA boolean → JS boolean coercion (false) ───────────────────

  it('returns aiGrading === false (typeof boolean) for HANA-stored false value', async () => {
    const result = await defaultLoadQuestion(SLUG_FALSE, 2, 'validate-2');
    expect(result).not.toBeNull();
    expect(result.aiGrading).toBe(false);
    expect(typeof result.aiGrading).toBe('boolean'); // defends against HANA returning 0/1 ints
    expect(result.questionId).toBe('validate-2');
  });

  // ─── Test 3: mixed-case slug input finds lowercase-stored row ─────────────

  it('finds lowercase-stored row when called with mixed-case slug input', async () => {
    // Build a mixed-case variant of SLUG_TRUE (uppercase every other char of
    // the trailing segment so the slug is unambiguously not lowercase).
    const mixedCase = SLUG_TRUE.toUpperCase();
    expect(mixedCase).not.toBe(SLUG_TRUE); // sanity: slug actually differs in case

    const result = await defaultLoadQuestion(mixedCase, 1, 'validate-1');
    expect(result).not.toBeNull();
    expect(result.questionId).toBe('validate-1');
    expect(result.aiGrading).toBe(true);
  });
});
