import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

let model;

describe('#1034 UI annotations', () => {
  beforeAll(async () => {
    const csn = await cds.load('*');
    model = cds.compile.for.nodejs(csn);
  });

  it('NewsItems has @UI.LineItem with 10+ columns', () => {
    const ent = model.definitions['com.sap.developers.ims.ContentModerationService.NewsItems']
              ?? model.definitions['ContentModerationService.NewsItems'];
    expect(ent).toBeTruthy();
    const li = ent['@UI.LineItem'];
    expect(Array.isArray(li)).toBe(true);
    expect(li.length).toBeGreaterThanOrEqual(10);
  });

  it('LineItem includes AI verdict and admin verdict', () => {
    const ent = model.definitions['com.sap.developers.ims.ContentModerationService.NewsItems']
              ?? model.definitions['ContentModerationService.NewsItems'];
    const props = ent['@UI.LineItem'].map(c => c.Value?.['='] ?? c.Value);
    expect(props).toContain('title');
    expect(props).toContain('aiVerdict');
    expect(props).toContain('adminVerdict');
  });

  it('LineItem action bindings use EntitySet/action form', () => {
    const ent = model.definitions['com.sap.developers.ims.ContentModerationService.NewsItems']
              ?? model.definitions['ContentModerationService.NewsItems'];
    const actions = ent['@UI.LineItem']
      .filter(c => c.$Type === 'UI.DataFieldForAction')
      .map(c => c.Action);
    for (const a of actions) {
      expect(a).toMatch(/NewsItems\//);
    }
    expect(actions).toHaveLength(4);
  });
});
