// test/unit/kg/chat-settings-community-flag.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';

describe('ChatSettings community columns (#1126)', () => {
  let cs;
  beforeAll(async () => {
    const model = await cds.load(path.join(process.cwd(), 'db'));
    cs = model.definitions['com.sap.developers.ims.ChatSettings'];
  });

  it('adds communityPeersEnabled defaulting false', () => {
    expect(cs.elements.communityPeersEnabled.type).toBe('cds.Boolean');
    expect(cs.elements.communityPeersEnabled.default.val).toBe(false);
  });

  it('adds the LLM budget triplet', () => {
    expect(cs.elements.communityLabelLlmBudgetPerDay.default.val).toBe(50);
    expect(cs.elements.communityLabelLlmCallsToday.default.val).toBe(0);
    expect(cs.elements.communityLabelLlmCallsCountedOn.type).toBe('cds.Date');
  });
});
