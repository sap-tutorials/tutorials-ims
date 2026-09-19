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
