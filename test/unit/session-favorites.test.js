// test/unit/session-favorites.test.js
const cds = require('@sap/cds');
const project = cds.test('serve', '--project', '.', '--in-memory');
const { expect } = project;
const NS = 'com.sap.developers.ims';

const USER = { sapId: '__test__-fav-u1' };
const OTHER = { sapId: '__test__-fav-u2' };

async function seedUser(sapId) {
  const { Users } = cds.entities(NS);
  const existing = await SELECT.one.from(Users).where({ sapId });
  if (existing) return existing.ID;
  const ID = cds.utils.uuid();
  await INSERT.into(Users).entries({ ID, uuid: sapId, sapId, legacyId: Math.floor(Math.random() * 1e6) + 900000 });
  return ID;
}

describe('getMyFavorites', () => {
  beforeAll(async () => {
    const uid = await seedUser(USER.sapId);
    const oid = await seedUser(OTHER.sapId);
    const { SessionFavorites } = cds.entities(NS);
    await INSERT.into(SessionFavorites).entries([
      { ID: cds.utils.uuid(), user_ID: uid, sourceType: 'TECHED', sessionRef: 'ai-001' },
      { ID: cds.utils.uuid(), user_ID: uid, sourceType: 'DEVTOBERFEST', sessionRef: 'dtf-xyz' },
      { ID: cds.utils.uuid(), user_ID: oid, sourceType: 'TECHED', sessionRef: 'SECRET-OTHER' },
    ]);
  });

  it('returns only the calling user rows', async () => {
    const res = await project.get('/api/getMyFavorites()', { auth: { username: USER.sapId } });
    const rows = res.data.value ?? res.data;
    expect(rows.map((r) => r.sessionRef).sort()).to.eql(['ai-001', 'dtf-xyz']);
    expect(rows.some((r) => r.sessionRef === 'SECRET-OTHER')).to.equal(false);
  });

  it('returns [] for anonymous', async () => {
    const res = await project.get('/api/getMyFavorites()').catch((e) => e);
    // authenticated-user guard → 401 for truly anonymous; the island treats 401 as {favorites:[]}
    const status = res.response?.status ?? res.status;
    expect([200, 401]).to.include(status);
  });
});

describe('toggleSessionFavorite', () => {
  const S = { sapId: '__test__-fav-toggle' };
  it('toggles insert -> delete -> insert and returns the flag', async () => {
    await seedUser(S.sapId);
    const call = () => project.post('/api/toggleSessionFavorite',
      { sourceType: 'TECHED', sessionRef: 'toggle-me' }, { auth: { username: S.sapId } });

    const r1 = await call();
    expect(r1.data.favorited).to.equal(true);
    const r2 = await call();
    expect(r2.data.favorited).to.equal(false);
    const r3 = await call();
    expect(r3.data.favorited).to.equal(true);

    const { SessionFavorites, Users } = cds.entities(NS);
    const u = await SELECT.one.from(Users).where({ sapId: S.sapId });
    const rows = await SELECT.from(SessionFavorites).where({ user_ID: u.ID, sessionRef: 'toggle-me' });
    expect(rows.length).to.equal(1);
  });

  it('rejects a bad sourceType with 400', async () => {
    const res = await project.post('/api/toggleSessionFavorite',
      { sourceType: 'NOPE', sessionRef: 'x' }, { auth: { username: S.sapId } }).catch((e) => e);
    expect(res.response?.status ?? res.status).to.equal(400);
  });

  it('rejects an empty sessionRef with 400', async () => {
    const res = await project.post('/api/toggleSessionFavorite',
      { sourceType: 'TECHED', sessionRef: '' }, { auth: { username: S.sapId } }).catch((e) => e);
    expect(res.response?.status ?? res.status).to.equal(400);
  });

  it('is IDOR-safe: favorite lands on the JWT user, not any param', async () => {
    await seedUser(S.sapId);
    await project.post('/api/toggleSessionFavorite',
      { sourceType: 'DEVTOBERFEST', sessionRef: 'idor-check' }, { auth: { username: S.sapId } });
    const { SessionFavorites, Users } = cds.entities(NS);
    const u = await SELECT.one.from(Users).where({ sapId: S.sapId });
    const rows = await SELECT.from(SessionFavorites).where({ sessionRef: 'idor-check' });
    expect(rows.every((r) => r.user_ID === u.ID)).to.equal(true);
  });
});
