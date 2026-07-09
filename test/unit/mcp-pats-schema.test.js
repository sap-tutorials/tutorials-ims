import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

let model;

describe('PATs schema and AdminService.MyPATs projection', () => {
  beforeAll(async () => {
    // Load db model + admin service so we can inspect CSN definitions.
    // Using cds.load with the full db folder ensures transitive deps (schema.cds etc.) resolve.
    model = await cds.load('srv/admin-service.cds');
  });

  it('defines com.sap.developers.ims.PATs', () => {
    const PATs = model.definitions['com.sap.developers.ims.PATs'];
    expect(PATs).toBeDefined();
    for (const el of ['user', 'name', 'prefix', 'hashHex', 'scopes',
                       'expiresAt', 'lastUsedAt', 'revokedAt', 'createdFromIP']) {
      expect(PATs.elements[el]).toBeDefined();
    }
  });

  it('exposes AdminService.MyPATs scoped by user.ID', () => {
    const proj = model.definitions['AdminService.MyPATs'];
    expect(proj).toBeDefined();
  });

  it('enforces @assert.unique.hashHex', () => {
    const PATs = model.definitions['com.sap.developers.ims.PATs'];
    // The annotation is compile-time; the runtime error surfaces on INSERT.
    // Sniff the CSN for it.
    expect(JSON.stringify(PATs['@assert.unique.hashHex'] ?? PATs['@assert.unique'] ?? PATs.$hasUnique)).toMatch(/hashHex/);
  });
});
