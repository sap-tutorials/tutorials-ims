import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { defaultLoadQuestion } from '../../srv/lib/validate-answer-question-loader.js';

describe('defaultLoadQuestion', () => {
  beforeAll(async () => {
    await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
  });

  beforeEach(async () => {
    const { ValidateAnswerSpecs, Tutorials } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ValidateAnswerSpecs);
    await DELETE.from(Tutorials);
    await INSERT.into(Tutorials).entries({
      ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      slug: 'sample',
      title: 'Sample',
      status: 'ACTIVE'
    });
    await INSERT.into(ValidateAnswerSpecs).entries({
      tutorial_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      stepNumber: 3,
      questionId: 'validate-3',
      questionText: 'What is X?',
      correctAnswer: 'X is Y.',
      ruleType: 'exact-match',
      aiGrading: true
    });
  });

  it('returns the spec when found', async () => {
    const result = await defaultLoadQuestion('sample', 3, 'validate-3');
    expect(result).toEqual({
      questionId: 'validate-3',
      question: 'What is X?',
      correctAnswer: 'X is Y.',
      aiGrading: true
    });
  });

  it('lowercases the slug for lookup', async () => {
    const result = await defaultLoadQuestion('SAMPLE', 3, 'validate-3');
    expect(result?.questionId).toBe('validate-3');
  });

  it('returns null when slug not found', async () => {
    expect(await defaultLoadQuestion('nonexistent', 3, 'validate-3')).toBeNull();
  });

  it('returns null when step+questionId not found in that tutorial', async () => {
    expect(await defaultLoadQuestion('sample', 99, 'validate-99')).toBeNull();
  });

  it('returns null gracefully on any error', async () => {
    // Pass a bogus arg to provoke an internal error path
    expect(await defaultLoadQuestion(null, 3, 'validate-3')).toBeNull();
  });

  it('coerces aiGrading=false to boolean false (not 0/null/undefined)', async () => {
    const { ValidateAnswerSpecs } = cds.entities('com.sap.developers.ims');
    // Update the seeded fixture to aiGrading=false
    await UPDATE(ValidateAnswerSpecs).set({ aiGrading: false });
    const result = await defaultLoadQuestion('sample', 3, 'validate-3');
    expect(result?.aiGrading).toBe(false);
    expect(typeof result?.aiGrading).toBe('boolean');
  });
});
