import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { getCascadePlan } from '../../srv/lib/anonymization-cascade.js';

describe('anonymization-cascade pickup of UserLearningPreferences (PR 6)', () => {
  it('UserLearningPreferences appears in the cascade plan with action: delete', async () => {
    // Per recon item 4: each plan entry has shape
    //   { entityName, action, dataSubjectField, personalFields }
    // (NOT `name`, NOT `cascade` — the cascade value is encoded in `action`).
    // Loading via cds.load + getCascadePlan(csn.definitions) walks @PersonalData
    // annotations against the live CSN; the assertion is the drift guard for the
    // db/audit-logging.cds annotation in Task 2.
    const csn = await cds.load(['db/schema.cds', 'db/audit-logging.cds']);
    const plan = getCascadePlan(csn.definitions);
    const entry = plan.find((p: any) => p.entityName === 'com.sap.developers.ims.UserLearningPreferences');
    expect(entry, 'UserLearningPreferences must appear in cascade plan').toBeDefined();
    expect(entry?.action).toBe('delete');
    // Note: loading BOTH schema.cds AND audit-logging.cds is required — cds.load()
    // does not auto-discover sibling .cds files. The @PersonalData annotation under
    // test lives in audit-logging.cds; without it the CSN has the entity but no
    // annotation, and the walker returns no entry (silent regression-by-incomplete-fix
    // discovered in round-2 plan review B-NEW-1).
  });
});
