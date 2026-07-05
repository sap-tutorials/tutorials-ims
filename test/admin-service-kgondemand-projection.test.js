import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';

describe('AdminService.KgOnDemandRequests projection (#948)', () => {
  let model;

  beforeAll(async () => {
    await cds.deploy(cds.env.roots).to('sqlite::memory:');
    // cds.deploy connects db; the compiled model is on the db service
    model = cds.services['db']?.model;
  });

  it('exposes KgOnDemandRequests via AdminService with @readonly', () => {
    expect(model).toBeDefined();
    const projection = model.definitions['AdminService.KgOnDemandRequests'];
    expect(projection).toBeDefined();
    expect(projection['@readonly']).toBe(true);
  });

  it('KgOnDemandRequests has expected fields', () => {
    const entities = cds.entities(NS);
    const base = entities.KgOnDemandRequests;
    expect(base).toBeDefined();
    const elements = Object.keys(base.elements || {});
    for (const name of [
      'query', 'normalizedKey', 'status', 'requestedByKind', 'attempts',
      'tutorialsExtracted', 'conceptsCreated', 'conceptsMerged',
      'latencyMs', 'requestedAt', 'completedAt', 'lastError',
    ]) {
      expect(elements, `missing field: ${name}`).toContain(name);
    }
  });
});
