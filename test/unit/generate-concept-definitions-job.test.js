import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { runGenerateConceptDefinitions } from '../../srv/jobs/generate-concept-definitions-job.js';

// #2426 concept-definition generator job. Uses an in-memory sqlite deploy and
// a mocked generateFn so no LLM is called. Feature flag is bypassed via
// manualTrigger; the flag-gate path is asserted separately.
describe('runGenerateConceptDefinitions (#2426)', () => {
  let db;

  beforeAll(async () => {
    const schemaRoots = [path.join(process.cwd(), 'db'), path.join(process.cwd(), 'srv')];
    db = await cds.deploy(schemaRoots).to('sqlite::memory:');
    const { Concepts, TutorialConceptLinks, Tutorials } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Concepts).entries([
      { slug: 'grounded', name: 'Grounded Concept', status: 'ACTIVE', descriptionStatus: null },
      { slug: 'ungrounded', name: 'Ungrounded Concept', status: 'ACTIVE', descriptionStatus: null },
      { slug: 'already-approved', name: 'Approved', status: 'ACTIVE',
        description: 'human text', descriptionStatus: 'APPROVED' },
      { slug: 'inactive', name: 'Inactive', status: 'RETIRED', descriptionStatus: null },
    ]);
    await INSERT.into(Tutorials).entries({ slug: 't1', title: 'Teaches Grounded', status: 'ACTIVE' });

    const groundedId = (await SELECT.one.from(Concepts).columns('ID').where({ slug: 'grounded' })).ID;
    const tutId = (await SELECT.one.from(Tutorials).columns('ID').where({ slug: 't1' })).ID;
    // Grounding for 'grounded' via a teaching tutorial link.
    await INSERT.into(TutorialConceptLinks).entries({
      tutorial_ID: tutId, concept_ID: groundedId, predicate: 'teaches',
    });
  });

  afterAll(async () => { await cds.disconnect(); });

  // A generateFn that echoes a fixed, clean definition — no LLM.
  const goodGenerate = async ({ concept }) => ({
    definition: `${concept.name} is a well-defined SAP concept used across the developer platform.`,
    reason: null, violations: [], promptTokens: 1, completionTokens: 1,
  });

  it('is a no-op when the flag is OFF and manualTrigger is absent', async () => {
    const summary = await runGenerateConceptDefinitions(null, { db, generateFn: goodGenerate });
    expect(summary.generated).toBe(0);
    expect(summary.candidates).toBe(0);
  });

  it('writes DRAFT definitions only for grounded, non-approved, ACTIVE concepts', async () => {
    const summary = await runGenerateConceptDefinitions(null, {
      db, manualTrigger: true, generateFn: goodGenerate,
    });
    // Candidates = ACTIVE + descriptionStatus null = grounded + ungrounded (NOT approved, NOT inactive)
    expect(summary.candidates).toBe(2);
    expect(summary.generated).toBe(1);          // only 'grounded' has sources
    expect(summary.skippedNoGrounding).toBe(1); // 'ungrounded' skipped

    const { Concepts } = cds.entities('com.sap.developers.ims');
    const grounded = await SELECT.one.from(Concepts).columns('description', 'descriptionStatus').where({ slug: 'grounded' });
    expect(grounded.descriptionStatus).toBe('DRAFT');
    expect(grounded.description).toContain('Grounded Concept');

    // Approved concept is never touched.
    const approved = await SELECT.one.from(Concepts).columns('description', 'descriptionStatus').where({ slug: 'already-approved' });
    expect(approved.descriptionStatus).toBe('APPROVED');
    expect(approved.description).toBe('human text');

    // Inactive concept is never a candidate.
    const inactive = await SELECT.one.from(Concepts).columns('descriptionStatus').where({ slug: 'inactive' });
    expect(inactive.descriptionStatus).toBeNull();
  });

  it('counts a terminology rejection without writing', async () => {
    // Reset 'grounded' back to null so it is a candidate again.
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await UPDATE(Concepts).set({ description: null, descriptionStatus: null }).where({ slug: 'grounded' });

    const rejectGenerate = async () => ({ definition: null, reason: 'stale-terminology', violations: [{ stale: 'Open SQL', canonical: 'ABAP SQL' }], promptTokens: 1, completionTokens: 1 });
    const summary = await runGenerateConceptDefinitions(null, {
      db, manualTrigger: true, generateFn: rejectGenerate,
    });
    expect(summary.rejectedTerminology).toBe(1);
    expect(summary.generated).toBe(0);
    const grounded = await SELECT.one.from(Concepts).columns('descriptionStatus').where({ slug: 'grounded' });
    expect(grounded.descriptionStatus).toBeNull(); // unchanged — nothing written
  });
});
