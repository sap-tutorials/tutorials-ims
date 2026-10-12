// test/unit/resolve-db-user-scoped.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const ISS = 'https://test-fake.ondemand.example';
const SUB = 'scoped-helper-sub-1';
const EMAIL = 'scoped-helper@x.example';
const ROLES = { 'authenticated-user': true };

describe('resolveDbUserScoped — tiered read resolve for null-sapId users', () => {
  let dbUserId;
  beforeAll(async () => {
    const { Users, UserIdentities } = cds.entities(NS);
    dbUserId = cds.utils.uuid();
    await INSERT.into(Users).entries({ ID: dbUserId, uuid: cds.utils.uuid(), sapId: null, email: EMAIL, legacyId: 811001 });
    await INSERT.into(UserIdentities).entries({ ID: cds.utils.uuid(), user_ID: dbUserId, issuer: ISS, subject: SUB, provider: 'ias', emailVerified: true, linkedAt: new Date().toISOString() });
  });
  it('resolves the identity-link user and does not mint', async () => {
    const { resolveDbUserScoped } = await import('../../packages/core/resolve-db-user.js');
    const { Users } = cds.entities(NS);
    const before = (await SELECT.from(Users)).length;
    const req = { user: { id: EMAIL, roles: ROLES, authInfo: { token: { payload: { iss: ISS, sub: SUB } } } } };
    const row = await resolveDbUserScoped(req, ['ID']);
    expect(row?.ID).to.equal(dbUserId);
    expect((await SELECT.from(Users)).length).to.equal(before); // no new row
  });
  it('returns null for anonymous', async () => {
    const { resolveDbUserScoped } = await import('../../packages/core/resolve-db-user.js');
    expect(await resolveDbUserScoped({ user: { id: 'anonymous' } })).to.equal(null);
  });
});
