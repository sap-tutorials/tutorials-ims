// test/backfill-user-profile.test.js
//
// Issue #339: validate the lazy-self-heal backfill that fills firstName /
// lastName / email from JWT claims when a migrated Users row has them blank.
//
// The migrator copies SAP_ID + pre-computed totals only — IMS Java JIT-fetched
// names from SAP IDP and never persisted them. SAP ID Service has no SCIM
// bulk API, so we rely on the user authenticating to populate the row.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { backfillUserProfile } from '../srv/lib/resolve-db-user.js';

cds.test('serve', '--project', '.', '--in-memory');

const SAP_ID = 'I999339';
const USER_UUID = 'eeeeeeee-9339-0000-0000-000000000001';

describe('backfillUserProfile (Issue #339)', () => {
  let Users;

  beforeAll(async () => {
    Users = cds.entities('com.sap.developers.ims').Users;
  });

  afterAll(async () => {
    await DELETE.from(Users).where({ sapId: SAP_ID });
  });

  // Helpers — each test inserts a fresh fixture so they don't depend on order.
  const seedBlankUser = async () => {
    await DELETE.from(Users).where({ sapId: SAP_ID });
    await INSERT.into(Users).entries({
      ID: USER_UUID, uuid: USER_UUID, sapId: SAP_ID,
      firstName: null, lastName: null, email: null,
    });
  };

  const seedPartialUser = async () => {
    await DELETE.from(Users).where({ sapId: SAP_ID });
    await INSERT.into(Users).entries({
      ID: USER_UUID, uuid: USER_UUID, sapId: SAP_ID,
      firstName: 'Existing', lastName: null, email: null,
    });
  };

  const seedFullyPopulatedUser = async () => {
    await DELETE.from(Users).where({ sapId: SAP_ID });
    await INSERT.into(Users).entries({
      ID: USER_UUID, uuid: USER_UUID, sapId: SAP_ID,
      firstName: 'Existing', lastName: 'Person', email: 'old@example.com',
    });
  };

  // The "user object" backfillUserProfile expects matches what CAP request
  // hooks pass: an authInfo.token carries the SAP ID, attr carries claims.
  const buildUser = (claims = {}) => ({
    id: 'someone@example.com',
    authInfo: { token: { userId: SAP_ID } },
    attr: claims,
  });

  it('UPDATEs all 3 fields when row is blank and JWT has all claims', async () => {
    await seedBlankUser();
    const user = buildUser({
      given_name: 'Tom', family_name: 'Jung', email: 'tom@example.com',
    });

    const verdict = await backfillUserProfile(user);
    expect(verdict.backfilled).toBe(true);
    expect(verdict.fields.sort()).toEqual(['email', 'firstName', 'lastName']);

    const row = await SELECT.one.from(Users).where({ sapId: SAP_ID });
    expect(row.firstName).toBe('Tom');
    expect(row.lastName).toBe('Jung');
    expect(row.email).toBe('tom@example.com');
  });

  it('only UPDATEs the blank fields; leaves existing values untouched', async () => {
    await seedPartialUser();
    const user = buildUser({
      given_name: 'Tom',           // would overwrite existing 'Existing' but won't
      family_name: 'Jung',
      email: 'tom@example.com',
    });

    const verdict = await backfillUserProfile(user);
    expect(verdict.backfilled).toBe(true);
    // firstName stays 'Existing' (not blank); only the two NULL fields fill
    expect(verdict.fields.sort()).toEqual(['email', 'lastName']);

    const row = await SELECT.one.from(Users).where({ sapId: SAP_ID });
    expect(row.firstName).toBe('Existing');
    expect(row.lastName).toBe('Jung');
    expect(row.email).toBe('tom@example.com');
  });

  it('no-op when row is fully populated (every field has a value)', async () => {
    await seedFullyPopulatedUser();
    const user = buildUser({
      given_name: 'Different', family_name: 'Name', email: 'new@example.com',
    });

    const verdict = await backfillUserProfile(user);
    expect(verdict.backfilled).toBe(false);
    expect(verdict.reason).toBe('no-blanks');

    const row = await SELECT.one.from(Users).where({ sapId: SAP_ID });
    expect(row.firstName).toBe('Existing');  // not overwritten
    expect(row.email).toBe('old@example.com');
  });

  it('no-op when JWT has no fillable claims (still returns no-blanks/no-claims, never throws)', async () => {
    await seedBlankUser();
    const user = buildUser({});  // empty attr

    const verdict = await backfillUserProfile(user);
    expect(verdict.backfilled).toBe(false);
    // attr={} satisfies "no-claims" guard; row stays blank
    expect(verdict.reason).toBe('no-blanks');
  });

  it('no-op when no Users row exists (auto-provision will fill on INSERT)', async () => {
    await DELETE.from(Users).where({ sapId: SAP_ID });
    const user = buildUser({
      given_name: 'Tom', family_name: 'Jung', email: 'tom@example.com',
    });

    const verdict = await backfillUserProfile(user);
    expect(verdict.backfilled).toBe(false);
    expect(verdict.reason).toBe('no-user');
  });

  it('returns anonymous reason when user is unauthenticated (resolveUserSapId returns null)', async () => {
    const verdict = await backfillUserProfile({ id: 'anonymous' });
    expect(verdict.backfilled).toBe(false);
    expect(verdict.reason).toBe('anonymous');
  });

  it('returns no-claims when user has no attr at all (defensive: malformed user object)', async () => {
    const verdict = await backfillUserProfile({ id: 'x', authInfo: { token: { userId: 'I9' } } });
    expect(verdict.backfilled).toBe(false);
    expect(verdict.reason).toBe('no-claims');
  });

  it('accepts both snake_case (SAP ID Service) and camelCase (some IAS configs)', async () => {
    await seedBlankUser();
    const user = buildUser({
      givenName: 'Tom',           // camelCase — observed on some IAS tenants
      familyName: 'Jung',
      email: 'tom@example.com',
    });

    const verdict = await backfillUserProfile(user);
    expect(verdict.backfilled).toBe(true);

    const row = await SELECT.one.from(Users).where({ sapId: SAP_ID });
    expect(row.firstName).toBe('Tom');
    expect(row.lastName).toBe('Jung');
  });

  it('idempotent: a second call after backfill is a no-op', async () => {
    await seedBlankUser();
    const user = buildUser({
      given_name: 'Tom', family_name: 'Jung', email: 'tom@example.com',
    });

    const first  = await backfillUserProfile(user);
    const second = await backfillUserProfile(user);

    expect(first.backfilled).toBe(true);
    expect(second.backfilled).toBe(false);
    expect(second.reason).toBe('no-blanks');
  });
});
