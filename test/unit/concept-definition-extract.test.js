import { describe, it, expect } from 'vitest';
import {
  generateConceptDefinition,
  applyPostValidation,
  KG_CONCEPT_DEFINITION_SCHEMA,
} from '../../srv/lib/concept-definition-extract.js';

describe('applyPostValidation (#2426)', () => {
  it('accepts a clean, adequately-sized definition', () => {
    const def = 'ABAP SQL is the SAP-recommended way to read and change data in the ABAP database layer using embedded statements.';
    const r = applyPostValidation(def);
    expect(r.definition).toBe(def);
    expect(r.reason).toBeNull();
  });

  it('rejects definitions containing deprecated terminology', () => {
    const r = applyPostValidation('Open SQL is used to read data in ABAP programs across the database.');
    expect(r.definition).toBeNull();
    expect(r.reason).toBe('stale-terminology');
    expect(r.violations[0]).toMatchObject({ stale: 'Open SQL', canonical: 'ABAP SQL' });
  });

  it('rejects too-short output (empty/stub tool calls)', () => {
    expect(applyPostValidation('too short').reason).toBe('too-short');
    expect(applyPostValidation('').reason).toBe('too-short');
  });

  it('rejects over-long output', () => {
    expect(applyPostValidation('x'.repeat(1300)).reason).toBe('too-long');
  });
});

describe('generateConceptDefinition (#2426)', () => {
  const concept = { slug: 'abap-sql', name: 'ABAP SQL' };
  const grounding = [{ title: 'ABAP SQL', url: 'https://help.sap.com/x', snippet: 'reads data' }];

  it('calls the model with the bare schema and returns the accepted definition', async () => {
    let seen = null;
    const callModel = async (args) => { seen = args; return { verdict: { definition: 'ABAP SQL reads and changes data in the ABAP database layer using embedded SELECT statements.' }, tokenUsage: { prompt: 10, completion: 5 } }; };
    const r = await generateConceptDefinition({ callModel, concept, grounding });
    expect(seen.schema).toBe(KG_CONCEPT_DEFINITION_SCHEMA);
    expect(seen.user).toContain('ABAP SQL');
    expect(seen.user).toContain('https://help.sap.com/x');
    expect(r.definition).toContain('ABAP SQL reads');
    expect(r.promptTokens).toBe(10);
    expect(r.completionTokens).toBe(5);
  });

  it('hard-rejects a model that emits deprecated terminology', async () => {
    const callModel = async () => ({ verdict: { definition: 'Open SQL is the classic way to read data in ABAP programs from the database.' } });
    const r = await generateConceptDefinition({ callModel, concept, grounding });
    expect(r.definition).toBeNull();
    expect(r.reason).toBe('stale-terminology');
  });
});
