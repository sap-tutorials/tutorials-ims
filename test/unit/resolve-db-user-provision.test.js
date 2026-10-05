// test/unit/resolve-db-user-provision.test.js
//
// Tests for the eager verified-email merge in provisionDbUser (#2651).
// When a token asserts an email that already belongs to a Users row,
// provisionDbUser must reuse that row instead of minting a duplicate.
//
// Bootstrap: module-level cds.test() deploys schema + seeds to in-memory
// SQLite (same pattern as author-service.test.js / content-moderation-service.test.js).
// SELECT/INSERT/DELETE are CAP globals — no explicit import needed.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Boot CAP with in-memory SQLite before any test runs.
cds.test('serve', '--project', '.', '--in-memory');

// A minimal IAS-style user whose token payload carries an email.
function makeUserWithEmail(email, overrides = {}) {
  return {
    id: email,
    attr: { email },
    authInfo: {
      token: {
        payload: {
          iss: 'https://test-tenant.accounts.ondemand.com',
          sub: `sub-for-${email}`,
          email,
          email_verified: true,
          given_name: 'Test',
          family_name: 'User',
          ...overrides,
        },
      },
    },
  };
}

describe('provisionDbUser — eager verified-email merge (#2651)', () => {
  let db;
  let Users;
  let existingId;
  const MERGE_EMAIL = 'merge.me@example.com';

  beforeAll(async () => {
    db = await cds.connect.to('db');
    ({ Users } = cds.entities('com.sap.developers.ims'));

    // Clean slate: remove any Users rows that might collide with our test email.
    const existing = await SELECT.from(Users).where`lower(email) = ${MERGE_EMAIL}`;
    for (const r of existing) {
      await db.run(DELETE.from(Users).where({ ID: r.ID }));
    }
  });

  it('case 1: reuses existing row when token email matches — no duplicate minted', async () => {
    // Pre-insert a Users row with the target email (no sapId, known legacyId).
    existingId = cds.utils.uuid();
    await INSERT.into(Users).entries({
      ID: existingId,
      uuid: cds.utils.uuid(),
      sapId: null,
      legacyId: 900001,
      email: MERGE_EMAIL,
    });

    // Confirm the row is there.
    const before = await SELECT.from(Users).where`lower(email) = ${MERGE_EMAIL}`;
    expect(before).toHaveLength(1);
    expect(before[0].ID).toBe(existingId);

    // Import here so cds.test() has already booted (avoids the compat getter warning).
    const { provisionDbUser } = await import('../../packages/core/resolve-db-user.js');

    // A user whose token carries the same email but a DIFFERENT (iss,sub) —
    // so the existing-identity Tier-1/2/3 resolveUser path returns null.
    const user = makeUserWithEmail(MERGE_EMAIL, {
      iss: 'https://brand-new-tenant.accounts.ondemand.com',
      sub: 'brand-new-sub-99',
    });

    const result = await provisionDbUser(user);

    // Should return the pre-existing row's ID, not mint a new one.
    expect(result).not.toBeNull();
    expect(result.ID).toBe(existingId);

    // Crucially: only ONE Users row for that email (no duplicate).
    const after = await SELECT.from(Users).where`lower(email) = ${MERGE_EMAIL}`;
    expect(after).toHaveLength(1);
    expect(after[0].ID).toBe(existingId);
  });

  it('case 2: no-match email → inserts a new row (regression guard)', async () => {
    const { provisionDbUser } = await import('../../packages/core/resolve-db-user.js');

    const UNIQUE_EMAIL = `new-user-${Date.now()}@example.com`;
    const beforeCount = (await SELECT.from(Users)).length;

    // User with email that matches no existing row.
    const user = makeUserWithEmail(UNIQUE_EMAIL);
    const result = await provisionDbUser(user);

    expect(result).not.toBeNull();

    const afterRows = await SELECT.from(Users);
    expect(afterRows.length).toBe(beforeCount + 1);

    // The returned row should have the email we provided.
    const inserted = afterRows.find((r) => r.ID === result.ID);
    expect(inserted).toBeDefined();
    expect(inserted.email?.toLowerCase()).toBe(UNIQUE_EMAIL.toLowerCase());
  });
});
