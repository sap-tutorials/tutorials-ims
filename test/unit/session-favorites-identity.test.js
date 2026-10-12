// test/unit/session-favorites-identity.test.js
//
// Regression for #2730: Devtoberfest/TechEd favorites "clear after re-login".
//
// Root cause: write and read paths resolved the user DIFFERENTLY.
//   - toggleSessionFavorite → provisionDbUser → resolveUser (tiered: pin →
//     (iss,sub) identity link → sapId). Robust for social / IAS / GitHub logins
//     whose Users row has sapId = NULL.
//   - getMyFavorites → resolveUserSapId + SELECT where({sapId}) ONLY. For a
//     null-sapId user this short-circuits to [] — the rows exist, keyed to the
//     canonical Users.ID, but the read queries by the wrong (unstable) key.
//
// The existing session-favorites.test.js uses basic-auth with username == sapId,
// which only exercises the Tier-2 sapId path and so NEVER reproduced this. This
// test drives both handlers as a null-sapId identity-link user (the real
// Devtoberfest audience) via srv.tx, mirroring account-merge-request.test.js.
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const NS = 'com.sap.developers.ims';
const ROLES = { 'authenticated-user': true };

// A GitHub/social-style login: NO sapId, identity is the (iss,sub) link only.
const ISS = 'https://test-fake.ondemand.example';
const SUB = 'fav-identity-sub-2730';
const EMAIL = 'fav-identity@x.example';

const USER = { id: EMAIL, roles: ROLES, authInfo: { token: { payload: { iss: ISS, sub: SUB } } } };

const call = (srv, event, data, user = USER) =>
  srv.tx({ user: { id: user.id, roles: ROLES, authInfo: user.authInfo } }, (tx) => tx.send({ event, data }));

describe('#2730 favorites survive re-login (null-sapId identity-link user)', () => {
  let srv;
  let dbUserId;

  beforeAll(async () => {
    srv = await cds.connect.to('DeveloperService');
    const { Users, UserIdentities } = cds.entities(NS);

    // Seed a null-sapId Users row + its (iss,sub) identity link.
    dbUserId = cds.utils.uuid();
    await INSERT.into(Users).entries({
      ID: dbUserId, uuid: cds.utils.uuid(), sapId: null, email: EMAIL,
      legacyId: Math.floor(Math.random() * 1e6) + 800000,
    });
    const link = await SELECT.one.from(UserIdentities).where({ issuer: ISS, subject: SUB });
    if (!link) {
      await INSERT.into(UserIdentities).entries({
        ID: cds.utils.uuid(), user_ID: dbUserId, issuer: ISS, subject: SUB,
        provider: 'ias', emailVerified: true, linkedAt: new Date().toISOString(),
      });
    }
  });

  it('writes against the canonical Users.ID (via the tiered resolver)', async () => {
    const r = await call(srv, 'toggleSessionFavorite', { sourceType: 'DEVTOBERFEST', sessionRef: 'dtf-2730' });
    expect(r.favorited).to.equal(true);

    const { SessionFavorites } = cds.entities(NS);
    const rows = await SELECT.from(SessionFavorites).where({ sessionRef: 'dtf-2730' });
    expect(rows.length).to.equal(1);
    expect(rows[0].user_ID).to.equal(dbUserId); // keyed to the identity-link user
  });

  it('reads the favorite back on a later "login" (SAME iss/sub token)', async () => {
    // This is the re-login: a fresh token, same (iss,sub), still null sapId.
    const res = await call(srv, 'getMyFavorites', {});
    const refs = (res ?? []).map((x) => x.sessionRef);
    // Pre-fix: getMyFavorites short-circuits to [] because resolveUserSapId
    // yields no canonical sapId → the favorite "disappears" after re-login.
    expect(refs).to.include('dtf-2730');
  });
});
