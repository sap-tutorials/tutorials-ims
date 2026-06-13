import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { PROFILE_VOCAB } from '../../srv/lib/branch/profile-fields.js';

describe('profile-fields-sync (drift guard)', () => {
  it('schema enum strings match PROFILE_VOCAB constants module exactly', async () => {
    const csn = await cds.load('db/schema.cds');
    const def = csn.definitions['com.sap.developers.ims.UserLearningPreferences'];
    expect(def, 'UserLearningPreferences entity must exist in CSN').toBeDefined();

    for (const field of ['deployment', 'role', 'cloud'] as const) {
      const elementEnum = def.elements?.[field]?.enum;
      expect(elementEnum, `${field} must have enum on element`).toBeDefined();
      const schemaValues = Object.keys(elementEnum).sort();
      const vocabValues = [...PROFILE_VOCAB[field]].sort();
      expect(schemaValues).toEqual(vocabValues);
    }
  });
});
