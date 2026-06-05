import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

describe('ValidateAnswer CDS schema', () => {
  beforeAll(async () => {
    await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
  });

  it('ValidateAnswerSpecs accepts insert with required fields', async () => {
    const { Tutorials, ValidateAnswerSpecs } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries({ ID: '11111111-1111-1111-1111-111111111111', slug: 't1', title: 'T1', status: 'ACTIVE' });
    await INSERT.into(ValidateAnswerSpecs).entries({
      tutorial_ID: '11111111-1111-1111-1111-111111111111',
      stepNumber: 3,
      questionId: 'validate-3',
      questionText: 'What is the difference between cds.connect.to and cds.requires?',
      correctAnswer: 'connect.to is runtime; requires is declaration.',
      ruleType: 'exact-match',
      aiGrading: true
    });
    const rows = await SELECT.from(ValidateAnswerSpecs);
    expect(rows).toHaveLength(1);
    expect(rows[0].questionText).toMatch(/connect.to and cds.requires/);
  });

  it('ValidateAnswerSubmissions accepts insert with required fields', async () => {
    const { ValidateAnswerSubmissions } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ValidateAnswerSubmissions).entries({
      ID: '22222222-2222-2222-2222-222222222222',
      tutorialSlug: 't1', stepNumber: 3,
      questionId: 'validate-3',
      submittedAnswer: 'one connects to a service, the other declares it',
      verdict: 'pass'
    });
    const rows = await SELECT.from(ValidateAnswerSubmissions);
    expect(rows).toHaveLength(1);
  });

  it('ChatSettings exposes validateAnswerEnabled with default false', async () => {
    // Use cds.db.model.definitions per project memory [Module Singletons in vitest+CDS]
    const insp = cds.db.model.definitions['com.sap.developers.ims.ChatSettings'];
    expect(insp.elements.validateAnswerEnabled).toBeDefined();
    expect(insp.elements.validateAnswerEnabled.type).toBe('cds.Boolean');
    expect(insp.elements.validateAnswerEnabled.default?.val).toBe(false);
  });
});
