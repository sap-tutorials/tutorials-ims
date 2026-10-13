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

// #2738: a PAT req.user pins the exact attr.dbUserId (mcp-pat-middleware.js) but
// has NO iss/sub and, for a migrated user, a NULL sapId. Both helpers must honor
// the pin FIRST — resolving the Users row by its PK — before the tiered/sapId
// path, which would otherwise miss (reads) or mint a spurious sapId=<email> row
// (writes). Mirrors resolveDbUser's existing attr.dbUserId fast-path.
describe('#2738 PAT-shaped req.user (pinned dbUserId, null sapId, no iss/sub)', () => {
  const PAT_EMAIL = 'pat-migrated@x.example';
  let patDbUserId;
  // The PAT req.user shape: email-shaped id, pinned dbUserId, no token payload.
  const patReq = () => ({
    user: { id: PAT_EMAIL, roles: ROLES, attr: { dbUserId: patDbUserId } },
  });
  beforeAll(async () => {
    const { Users } = cds.entities(NS);
    patDbUserId = cds.utils.uuid();
    // Migrated user: NULL sapId, resolvable only by the pinned PK.
    await INSERT.into(Users).entries({ ID: patDbUserId, uuid: cds.utils.uuid(), sapId: null, email: PAT_EMAIL, legacyId: 811002 });
  });

  it('resolveDbUserScoped resolves the pinned row and does not mint', async () => {
    const { resolveDbUserScoped } = await import('../../packages/core/resolve-db-user.js');
    const { Users } = cds.entities(NS);
    const before = (await SELECT.from(Users)).length;
    const row = await resolveDbUserScoped(patReq(), ['ID']);
    expect(row?.ID).to.equal(patDbUserId);
    expect((await SELECT.from(Users)).length).to.equal(before); // no new row
  });

  it('getOrProvisionDbUser resolves the pinned row and mints NO spurious sapId=<email> row', async () => {
    const { getOrProvisionDbUser } = await import('../../packages/core/resolve-db-user.js');
    const { Users } = cds.entities(NS);
    const before = (await SELECT.from(Users)).length;
    const row = await getOrProvisionDbUser(patReq(), {}, ['ID']);
    expect(row?.ID).to.equal(patDbUserId);
    expect((await SELECT.from(Users)).length).to.equal(before); // no new row
    // The pre-#2738 bug minted a row with sapId equal to the email-shaped user.id.
    expect(await SELECT.one.from(Users).where({ sapId: PAT_EMAIL })).to.not.be.ok;
  });
});
