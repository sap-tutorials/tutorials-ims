// test/unit/resolve-db-user-provision.test.js
//
// End-to-end dedup scenario for provisionDbUser — uses a real in-memory SQLite
// db (cds.test()) to verify that the IAS attr.email fallback in tokenEmail
// prevents a second Users row from being minted for the same human (issue #2651).
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Boot CAP with in-memory SQLite once for this file.
// SELECT / INSERT / DELETE become globals via cds.test().
cds.test('serve', '--project', '.', '--in-memory');

const { provisionDbUser } = await import('../../packages/core/resolve-db-user.js');

describe('provisionDbUser — IAS dedup (issue #2651)', () => {
  let db;
  let Users;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    ({ Users } = cds.entities('com.sap.developers.ims'));
  });

  it('IAS login reuses existing row — no duplicate minted', async () => {
    // Pre-seed a Users row that was created under XSUAA (has no sapId / link yet).
    const preId = cds.utils.uuid();
    await INSERT.into(Users).entries({
      ID: preId,
      uuid: cds.utils.uuid(),
      email: 'merge.me@example.com',
      sapId: null,
      legacyId: 900001,
    });

    // IAS token: no payload.email, but attr.email matches the pre-existing row.
    // Before the fix tokenEmail() returned null here → Tier 3 skipped → new row.
    const user = {
      id: 'merge.me@example.com',
      attr: { email: 'merge.me@example.com' },
      authInfo: { token: { payload: {
        iss: 'https://atxgsg7zi.accounts.ondemand.com',
        sub: 'ias-uuid-abc123',
        // no email claim in payload — IAS shape
      } } },
    };

    const row = await provisionDbUser(user);

    // Must reuse the pre-existing row, not mint a second one.
    expect(row).toBeTruthy();
    expect(row.ID).toBe(preId);

    // Exactly one Users row for this email must exist.
    const all = await SELECT.from(Users).where`lower(email) = ${'merge.me@example.com'}`;
    expect(all.length).toBe(1);
  });

  it('no email → still inserts a new row (regression guard)', async () => {
    const before = await SELECT.from(Users);
    const countBefore = before.length;

    // User with a canonical sapId but whose token has no email at all.
    const user = {
      id: 'I999001',
      attr: {},
      authInfo: { token: {
        userId: 'I999001',
        payload: {
          iss: 'https://tutorial-system.authentication.eu10-005.hana.ondemand.com',
          sub: 'I999001',
          // no email, no given_name — but sapId IS canonical so the row is minted
          user_uuid: 'I999001',
        },
      } },
    };

    const row = await provisionDbUser(user);
    expect(row).toBeTruthy();

    const after = await SELECT.from(Users);
    expect(after.length).toBe(countBefore + 1);
  });
});
