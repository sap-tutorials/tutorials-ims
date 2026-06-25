// Cascade plan must include Advocates with action: 'null-personal'.
// Spec: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md §1a
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';
import { getCascadePlan, _resetPlanForTest } from '../../srv/lib/anonymization-cascade.js';

describe('Anonymization cascade plan — Advocates inclusion', () => {
  let model;
  beforeAll(async () => {
    _resetPlanForTest();
    model = await cds.load(path.resolve('db'));
  });

  it('includes Advocates entity in cascade plan', () => {
    const plan = getCascadePlan(model.definitions);
    const advEntry = plan.find(p => p.entityName === 'com.sap.developers.ims.Advocates');
    expect(advEntry).toBeDefined();
  });

  it('Advocates cascade action is null-personal', () => {
    const plan = getCascadePlan(model.definitions);
    const advEntry = plan.find(p => p.entityName === 'com.sap.developers.ims.Advocates');
    expect(advEntry.action).toBe('null-personal');
  });

  it('Advocates cascade dataSubjectField is user_ID', () => {
    const plan = getCascadePlan(model.definitions);
    const advEntry = plan.find(p => p.entityName === 'com.sap.developers.ims.Advocates');
    expect(advEntry.dataSubjectField).toBe('user_ID');
  });
});
