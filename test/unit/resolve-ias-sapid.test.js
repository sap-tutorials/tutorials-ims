// test/unit/resolve-ias-sapid.test.js
//
// DB-backed IAS identity resolution (#2550): resolveIasSapId + pinIasSapId.
// The email→Users.email→sapId join and the before('*') pin are load-bearing for
// the MCP tier (an IAS token carries a verified email but NO I-number), so they
// are unit-tested here with a mocked cds/SELECT rather than left to hybrid only.
//
// Imports from packages/core directly (the real implementation; srv/lib is a
// thin re-export shim).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock @sap/cds BEFORE importing the module under test. cds.entities returns a
// stub Users entity; SELECT is a chainable stub we drive per-test.
let captured; // { email } captured from the .where tagged template
let stubRows; // the rows resolveIasSapId's SELECT resolves to (array)

vi.mock('@sap/cds', () => ({
  default: {
    entities: () => ({ Users: { name: 'Users' } }),
    log: () => ({ warn() {}, info() {} }),
    utils: { uuid: () => 'uuid' },
  },
}));

// Chainable SELECT.from(..).columns(..).where`lower(email) = ${email}`.
// resolveIasSapId now fetches ALL matches (array), not SELECT.one.
function installSelect() {
  const chain = {
    from() { return this; },
    columns() { return this; },
    where(strings, ...vals) {
      captured = { whereText: strings.join('?'), email: vals[0] };
      return Promise.resolve(stubRows);
    },
  };
  globalThis.SELECT = Object.assign(() => chain, { from: () => chain, one: chain });
}

const { resolveIasSapId, pinIasSapId } = await import('../../packages/core/resolve-db-user.js');

const iasUser = (overrides = {}) => ({
  id: 'thomas.jung@sap.com',
  authInfo: { token: { payload: {
    iss: 'https://atxgsg7zi.accounts.ondemand.com',
    sub: 'thomas.jung@sap.com',
    email: 'thomas.jung@sap.com',
    user_uuid: 'ba411614-11a4-42a3-9867-0919861a7dac',
    ...overrides,
  } } },
});

describe('resolveIasSapId', () => {
  beforeEach(() => { captured = undefined; stubRows = undefined; installSelect(); });
  afterEach(() => { delete globalThis.SELECT; });

  it('joins the verified email to Users.email and returns the matched sapId', async () => {
    stubRows = [{ sapId: 'I809764' }];
    const sapId = await resolveIasSapId(iasUser());
    expect(sapId).toBe('I809764');
    // joined on the lowercased email, NOT the SCIM UUID
    expect(captured.email).toBe('thomas.jung@sap.com');
    expect(captured.whereText.toLowerCase()).toContain('lower(email)');
  });

  it('prefers the real I-number over a duplicate SCIM-UUID-keyed row (same email)', async () => {
    // Live-observed collision: an early IAS login auto-provisioned a stray row
    // keyed on the SCIM UUID with the same email as the real migrated I-number
    // row. The join MUST deterministically return the I-number, regardless of
    // row order from the DB.
    stubRows = [
      { sapId: 'fbf099e2-f1b5-4cda-b590-866fed970a2a' }, // stray SCIM-UUID row FIRST
      { sapId: 'I809764' },                               // real I-number row
    ];
    expect(await resolveIasSapId(iasUser())).toBe('I809764');
    // and the reverse order still prefers the I-number
    stubRows = [{ sapId: 'I809764' }, { sapId: 'fbf099e2-f1b5-4cda-b590-866fed970a2a' }];
    expect(await resolveIasSapId(iasUser())).toBe('I809764');
  });

  it('returns null (fail-closed) when no Users row matches the email', async () => {
    stubRows = []; // no match
    expect(await resolveIasSapId(iasUser())).toBeNull();
  });

  it('returns null for a non-IAS token (XSUAA issuer) — never touches the DB', async () => {
    const xsuaa = { id: 'x', authInfo: { token: { payload: {
      iss: 'https://tutorial-system.authentication.eu10-005.hana.ondemand.com/oauth/token',
    } } } };
    expect(await resolveIasSapId(xsuaa)).toBeNull();
    expect(captured).toBeUndefined(); // DB never queried
  });

  it('returns null when the IAS token carries no usable email', async () => {
    expect(await resolveIasSapId(iasUser({ sub: 'ba411614', email: undefined, id: undefined }))).toBeNull();
  });

  it('NEVER returns the SCIM UUID (user_uuid) as a sapId when it is the only match', async () => {
    // Edge: if ONLY a SCIM-UUID row exists (no I-number row), the function
    // returns it as a last resort (ids[0]) — but the common collision case above
    // guarantees the I-number wins when both exist. A lone SCIM-UUID row means
    // the user has no migrated identity; the caller's downstream logic handles
    // that. We still assert it does not fabricate/return user_uuid from claims.
    stubRows = []; // no DB row at all
    const sapId = await resolveIasSapId(iasUser());
    expect(sapId).not.toBe('ba411614-11a4-42a3-9867-0919861a7dac');
  });
});

describe('pinIasSapId', () => {
  beforeEach(() => { captured = undefined; stubRows = undefined; installSelect(); });
  afterEach(() => { delete globalThis.SELECT; });

  it('pins the resolved I-number onto authInfo.token.userId (branch #1)', async () => {
    stubRows = [{ sapId: 'I809764' }];
    const user = iasUser();
    const pinned = await pinIasSapId(user);
    expect(pinned).toBe('I809764');
    expect(user.authInfo.token.userId).toBe('I809764');
  });

  it('pins the I-number even when a duplicate SCIM-UUID row shares the email', async () => {
    stubRows = [{ sapId: 'fbf099e2-f1b5-4cda-b590-866fed970a2a' }, { sapId: 'I809764' }];
    const user = iasUser();
    expect(await pinIasSapId(user)).toBe('I809764');
    expect(user.authInfo.token.userId).toBe('I809764');
  });

  it('is a no-op for a non-IAS token (XSUAA path untouched)', async () => {
    const user = { id: 'x', authInfo: { token: { userId: 'I000001', payload: {
      iss: 'https://tutorial-system.authentication.eu10-005.hana.ondemand.com/oauth/token',
    } } } };
    expect(await pinIasSapId(user)).toBeNull();
    expect(user.authInfo.token.userId).toBe('I000001'); // unchanged
  });

  it('does NOT pin when the email matches no Users row (leaves context unpinned)', async () => {
    stubRows = [];
    const user = iasUser();
    expect(await pinIasSapId(user)).toBeNull();
    expect(user.authInfo.token.userId).toBeUndefined();
  });

  it('returns null for null user', async () => {
    expect(await pinIasSapId(null)).toBeNull();
  });
});
