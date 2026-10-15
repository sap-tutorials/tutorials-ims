import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('link-health columns', () => {
  let model;
  beforeAll(async () => { model = await cds.load(cds.env.folders.db); });
  it.each(['Tutorials', 'Missions', 'Groups'])('%s has linkStatus/lastChecked/linkStatusOverride', (name) => {
    const e = model.definitions[`com.sap.developers.ims.${name}`];
    expect(e.elements.linkStatus).toBeTruthy();
    expect(e.elements.lastChecked).toBeTruthy();
    expect(e.elements.linkStatusOverride).toBeTruthy();
  });
});
