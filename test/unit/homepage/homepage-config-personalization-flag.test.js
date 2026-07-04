import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('HomepageConfig.personalizationEnabled', () => {
  let model;
  beforeAll(async () => {
    model = await cds.load(['db/schema.cds', 'db/homepage.cds']);
  });

  it('exists as a Boolean default false', () => {
    const cfg = model.definitions['com.sap.developers.ims.HomepageConfig'];
    const el = cfg.elements.personalizationEnabled;
    expect(el).toBeDefined();
    expect(el.type).toBe('cds.Boolean');
    expect(el.default?.val).toBe(false);
  });
});
