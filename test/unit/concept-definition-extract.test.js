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

  // #2440: fluent LLM refusals ("the concept name was not provided…") are
  // non-null, in-range and clean-termed, so length+terminology checks pass them
  // through. They were bulk-approved and shipped to prod. Reject them explicitly.
  it('rejects refusal signatures as reason="refusal" (#2440)', () => {
    const refusals = [
      'The concept name was not provided, so a precise definition cannot be determined. Based on the available sources, SAP BTP is a platform.',
      'The sources do not contain sufficient information to define a specific SAP developer concept, as the concept name is missing.',
      'The concept name was not provided and the supplied source snippets do not define a single identifiable concept for this entry.',
      'The sources do not contain sufficient information to define the concept "undefined." The sources cover unrelated topics.',
      'A precise definition cannot be determined from the available source snippets provided for this concept entry here.',
    ];
    for (const def of refusals) {
      const r = applyPostValidation(def);
      expect(r.definition, def).toBeNull();
      expect(r.reason, def).toBe('refusal');
    }
  });

  it('does not misclassify a legitimate definition as a refusal (#2440)', () => {
    const def = 'The SAP Destination service lets applications retrieve connection and configuration details for remote systems, so developers avoid hardcoding endpoints and credentials.';
    expect(applyPostValidation(def).reason).toBeNull();
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

  // #2440 root cause: concept.name arrived as undefined (HANA uppercase key
  // read as lowercase), so the prompt said "CONCEPT: undefined" and the model
  // refused. Never send the model a blank/undefined name — fail loud instead.
  it('refuses to generate when concept.name is missing (#2440)', async () => {
    let called = false;
    const callModel = async () => { called = true; return { verdict: { definition: 'x'.repeat(60) } }; };
    for (const bad of [{ slug: 'abap-sql' }, { slug: 'abap-sql', name: '' }, { slug: 'abap-sql', name: '   ' }, { slug: 'abap-sql', name: undefined }]) {
      const r = await generateConceptDefinition({ callModel, concept: bad, grounding });
      expect(r.definition, JSON.stringify(bad)).toBeNull();
      expect(r.reason, JSON.stringify(bad)).toBe('no-name');
    }
    expect(called, 'model must not be called with a missing name').toBe(false);
  });
});
