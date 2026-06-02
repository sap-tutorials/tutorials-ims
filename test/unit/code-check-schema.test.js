import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

describe('CodeCheck CDS schema', () => {
  beforeAll(async () => {
    await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
  });

  it('CodeCheckSpecs accepts insert with required fields', async () => {
    const { Tutorials, CodeCheckSpecs } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries({ ID: '11111111-1111-1111-1111-111111111111', slug: 't1', title: 'T1', status: 'ACTIVE' });
    await INSERT.into(CodeCheckSpecs).entries({
      tutorial_ID: '11111111-1111-1111-1111-111111111111',
      stepNumber: 3,
      goal: 'Add a before-READ handler',
      language: 'javascript',
      hints: '["see srv/cat-service.js"]',
      referenceSolution: 'this.before(...);',
      hasReference: true
    });
    const rows = await SELECT.from(CodeCheckSpecs);
    expect(rows).toHaveLength(1);
    expect(rows[0].goal).toBe('Add a before-READ handler');
  });

  it('CodeCheckSubmissions accepts insert with required fields', async () => {
    const { CodeCheckSubmissions } = cds.entities('com.sap.developers.ims');
    await INSERT.into(CodeCheckSubmissions).entries({
      ID: '22222222-2222-2222-2222-222222222222',
      tutorialSlug: 't1', stepNumber: 3,
      submittedCode: 'console.log(1)',
      verdict: 'pass'
    });
    const rows = await SELECT.from(CodeCheckSubmissions);
    expect(rows).toHaveLength(1);
  });

  it('ChatSettings exposes codeCheckEnabled with default false', async () => {
    const model = cds.db.model;
    const insp = model.definitions['com.sap.developers.ims.ChatSettings'];
    expect(insp.elements.codeCheckEnabled).toBeDefined();
    expect(insp.elements.codeCheckEnabled.type).toBe('cds.Boolean');
    expect(insp.elements.codeCheckEnabled.default?.val).toBe(false);
  });
});
