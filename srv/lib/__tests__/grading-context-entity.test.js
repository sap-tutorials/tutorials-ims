// srv/lib/__tests__/grading-context-entity.test.js
// TDD test for TutorialGradingContext entity + ChatSettings.gradingContextEnabled flag.
// Task 1 of #3090: tutorial-level AI grading context.

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

describe('TutorialGradingContext entity + gradingContextEnabled flag', () => {
  it('loads the compiled model with TutorialGradingContext entity', async () => {
    // Load the full model from the project root (db/schema.cds is the primary file)
    const model = await cds.load('*');
    const gc = model.definitions['com.sap.developers.ims.TutorialGradingContext'];

    // Assert entity exists
    expect(gc).toBeDefined();

    // Assert key tutorial association exists and points to Tutorials
    expect(gc.elements.tutorial).toBeDefined();
    expect(gc.elements.tutorial.key).toBe(true);
    expect(gc.elements.tutorial.target).toMatch(/Tutorials$/);

    // Assert context LargeString element exists
    expect(gc.elements.context).toBeDefined();
    expect(gc.elements.context.type).toBe('cds.LargeString');

    // Assert it is managed (has createdAt, createdBy, modifiedAt, modifiedBy)
    expect(gc.elements.createdAt).toBeDefined();
    expect(gc.elements.createdBy).toBeDefined();
    expect(gc.elements.modifiedAt).toBeDefined();
    expect(gc.elements.modifiedBy).toBeDefined();
  });

  it('has ChatSettings.gradingContextEnabled flag with default false', async () => {
    const model = await cds.load('*');
    const cs = model.definitions['com.sap.developers.ims.ChatSettings'];

    // Assert ChatSettings exists
    expect(cs).toBeDefined();

    // Assert gradingContextEnabled field exists
    expect(cs.elements.gradingContextEnabled).toBeDefined();

    // Assert it is Boolean type with default false
    expect(cs.elements.gradingContextEnabled.type).toBe('cds.Boolean');
    expect(cs.elements.gradingContextEnabled.default).toBeDefined();
    expect(cs.elements.gradingContextEnabled.default.val).toBe(false);
  });
});
