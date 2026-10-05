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

  it('after a race, returns the surviving row by email, not a new UUID', async () => {
    // Simulate the racer: pre-INSERT a Users row that the "winner" created.
    const winnerId = cds.utils.uuid();
    await INSERT.into(Users).entries({
      ID: winnerId,
      uuid: cds.utils.uuid(),
      email: 'race@example.com',
      sapId: null,
      legacyId: 900002,
    });

    // The "loser" call: token has iss/sub matching nothing in UserIdentities,
    // but attr.email matches the winner's row. The loser's INSERT will either
    // succeed (creating a duplicate) or be a no-op on uniqueness; the return
    // block must re-resolve by email and give back the WINNING row.
    //
    // We force the "INSERT was a no-op" scenario by having resolveUser (get-path)
    // find the winner via Tier-3 email match — so provisionDbUser returns the
    // winner on the get-path. That covers the Task 1 case. The Task 3 guard also
    // needs to handle when the INSERT went through on newId but the row with that
    // newId is missing (racer committed between SELECT-empty and INSERT in the
    // SAME call). We verify the steady-state: exactly 1 row for the email.
    const user = {
      id: 'race@example.com',
      attr: { email: 'race@example.com' },
      authInfo: { token: { payload: {
        iss: 'https://racer-tenant.accounts.ondemand.com',
        sub: 'racer-sub-unique-xyz',
        // no payload.email — IAS token shape; attr.email is the source
      } } },
    };

    const row = await provisionDbUser(user);

    // Must return the surviving (winner) row.
    expect(row).toBeTruthy();
    expect(row.ID).toBe(winnerId);

    // Exactly 1 row must exist for this email.
    const all = await SELECT.from(Users).where`lower(email) = ${'race@example.com'}`;
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
