// test/unit/session-favorites-model.test.js
const cds = require('@sap/cds');
const { expect } = cds.test('serve', '--project', '.', '--in-memory');

describe('SessionFavorites model', () => {
  it('persists a per-user favorite and enforces the unique triple', async () => {
    const db = await cds.connect.to('db');
    const { Users, SessionFavorites } = cds.entities('com.sap.developers.ims');
    const uid = cds.utils.uuid();
    await INSERT.into(Users).entries({ ID: uid, uuid: 't-fav-1', sapId: 't-fav-1', legacyId: 990001 });
    await INSERT.into(SessionFavorites).entries({
      ID: cds.utils.uuid(), user_ID: uid, sourceType: 'TECHED', sessionRef: 'ai-001',
    });
    const rows = await SELECT.from(SessionFavorites).where({ user_ID: uid });
    expect(rows.length).to.equal(1);
    expect(rows[0].sourceType).to.equal('TECHED');
    expect(rows[0].sessionRef).to.equal('ai-001');

    // duplicate triple must be rejected by @assert.unique
    let failed = false;
    try {
      await INSERT.into(SessionFavorites).entries({
        ID: cds.utils.uuid(), user_ID: uid, sourceType: 'TECHED', sessionRef: 'ai-001',
      });
    } catch { failed = true; }
    expect(failed).to.equal(true);
  });
});
