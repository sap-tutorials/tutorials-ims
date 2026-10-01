import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('UserIdentities schema', () => {
  let csn;
  beforeAll(async () => { csn = await cds.load(['db/schema.cds']); });

  it('defines UserIdentities with (issuer, subject) unique + user association', () => {
    const d = csn.definitions['com.sap.developers.ims.UserIdentities'];
    expect(d, 'UserIdentities entity exists').toBeTruthy();
    expect(d.elements.issuer.type).toBe('cds.String');
    expect(d.elements.subject.type).toBe('cds.String');
    expect(d.elements.user.type).toBe('cds.Association');
    expect(d.elements.emailVerified.type).toBe('cds.Boolean');
    // (issuer, subject) uniqueness is declared
    const hasUnique = Object.keys(d).some(k => k.startsWith('@assert.unique'));
    expect(hasUnique, '@assert.unique.issuerSubject declared').toBe(true);
  });

  it('adds Users.identities composition', () => {
    const u = csn.definitions['com.sap.developers.ims.Users'];
    expect(u.elements.identities.type).toBe('cds.Composition');
    expect(u.elements.identities.target).toBe('com.sap.developers.ims.UserIdentities');
  });

  it('does NOT add an email uniqueness assertion on Users', () => {
    const u = csn.definitions['com.sap.developers.ims.Users'];
    expect(u['@assert.unique.email']).toBeUndefined();
  });
});
