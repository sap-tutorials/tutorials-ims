// srv/lib/__tests__/grading-context-loader.test.js
// TDD tests for defaultLoadGradingContext (Task 5 of #3090).
// Pattern mirrors validate-answer-question-loader tests:
//   cds.deploy(schema).to(sqlite::memory:), seed Tutorials + TutorialGradingContext rows.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { defaultLoadGradingContext } from '../grading-context-loader.js';

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

const TEST_SLUG = 'grading-context-loader-test';
let tutorialID;

beforeAll(async () => {
  await cds.deploy(schemaPath).to('sqlite::memory:');

  const { Tutorials } = cds.entities('com.sap.developers.ims');
  tutorialID = cds.utils.uuid();
  await INSERT.into(Tutorials).entries({
    ID: tutorialID,
    slug: TEST_SLUG,
    title: 'Grading Context Loader Test Tutorial',
    description: '',
    primaryTag: '',
    experience: 'Beginner',
    time: 10,
    auto_validation: false,
  });
});

beforeEach(async () => {
  const { TutorialGradingContext } = cds.entities('com.sap.developers.ims');
  await DELETE.from(TutorialGradingContext);
});

describe('defaultLoadGradingContext', () => {
  it('returns stored context string for a known slug', async () => {
    const { TutorialGradingContext } = cds.entities('com.sap.developers.ims');
    const ctx = 'Domain: SAP ABAP\nCommonMistakes: Forgetting to activate.';
    await INSERT.into(TutorialGradingContext).entries({
      tutorial_ID: tutorialID,
      context: ctx,
    });

    const result = await defaultLoadGradingContext(TEST_SLUG);
    expect(result).toBe(ctx);
  });

  it('returns null for an unknown slug (no Tutorials row)', async () => {
    const result = await defaultLoadGradingContext('slug-that-does-not-exist');
    expect(result).toBeNull();
  });

  it('returns null when TutorialGradingContext row is absent for a known slug', async () => {
    // Tutorials row exists but no TutorialGradingContext row.
    const result = await defaultLoadGradingContext(TEST_SLUG);
    expect(result).toBeNull();
  });

  it('lowercases the slug before lookup', async () => {
    const { TutorialGradingContext } = cds.entities('com.sap.developers.ims');
    const ctx = 'Domain: BTP\nCommonMistakes: Skipping entitlement checks.';
    await INSERT.into(TutorialGradingContext).entries({
      tutorial_ID: tutorialID,
      context: ctx,
    });

    // Pass upper-cased slug — should still resolve.
    const result = await defaultLoadGradingContext(TEST_SLUG.toUpperCase());
    expect(result).toBe(ctx);
  });

  it('returns null (no throw) when slug is empty string', async () => {
    const result = await defaultLoadGradingContext('');
    expect(result).toBeNull();
  });

  it('returns null (no throw) when slug is not a string', async () => {
    const result = await defaultLoadGradingContext(null);
    expect(result).toBeNull();
  });
});
