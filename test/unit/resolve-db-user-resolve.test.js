// test/unit/resolve-db-user-resolve.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock @sap/cds BEFORE importing the module under test.
let captured;     // records { entity, where } for the last SELECT built
let stub;         // per-test: { identityRow, usersRows }

vi.mock('@sap/cds', () => ({
  default: {
    entities: () => ({
      Users: { name: 'com.sap.developers.ims.Users' },
      UserIdentities: { name: 'com.sap.developers.ims.UserIdentities' },
    }),
    log: () => ({ warn() {}, info() {}, error() {} }),
    utils: { uuid: () => 'generated-uuid' },
    connect: { to: async () => ({}) },
    context: { user: null },
  },
}));

// INSERT stub — records into `captured.insertEntity` and `captured.insertVals`.
function installInsert() {
  globalThis.INSERT = { into: (e) => ({ entries: (vals) => {
    captured = { ...captured, insertEntity: e?.name || e, insertVals: vals };
    return Promise.resolve({});
  } }) };
}

// Chainable SELECT stub. Supports:
//   SELECT.one.from(E).columns(...).where({...})
//   SELECT.one.from(E).columns(...).where`lower(email) = ${v}`
//   SELECT.from(E).columns(...).where`...`   (array result)
// Returns stub values keyed by which entity is queried.
function installSelect() {
  const makeChain = (one) => {
    const chain = {
      _entity: null,
      from(e) { this._entity = e?.name || e; return this; },
      columns() { return this; },
      where(arg, ...vals) {
        captured = { entity: this._entity, where: arg, vals };
        const isUsers = String(this._entity).endsWith('.Users');
        if (isUsers) return Promise.resolve(one ? (stub.usersRows?.[0] ?? null) : (stub.usersRows ?? []));
        // UserIdentities
        return Promise.resolve(one ? (stub.identityRow ?? null) : (stub.identityRows ?? []));
      },
    };
    return chain;
  };
  globalThis.SELECT = Object.assign(() => makeChain(false), {
    one: { from: (e) => makeChain(true).from(e) },
    from: (e) => makeChain(false).from(e),
  });
}

const { resolveUser, issuerSubjectFromUser } = await import('../../packages/core/resolve-db-user.js');

const iasUser = (over = {}) => ({
  id: 'thomas.jung@sap.com',
  authInfo: { token: { payload: {
    iss: 'https://atxgsg7zi.accounts.ondemand.com',
    sub: 'thomas.jung@sap.com',
    ...over,
  } } },
});

describe('issuerSubjectFromUser', () => {
  it('extracts iss + sub from the token payload', () => {
    expect(issuerSubjectFromUser(iasUser())).toEqual({
      issuer: 'https://atxgsg7zi.accounts.ondemand.com',
      subject: 'thomas.jung@sap.com',
    });
  });
  it('returns null when iss or sub is absent', () => {
    expect(issuerSubjectFromUser({ id: 'x', authInfo: { token: { payload: { iss: 'i' } } } })).toBeNull();
    expect(issuerSubjectFromUser(null)).toBeNull();
  });
});

describe('resolveUser — Tier 1 (iss,sub) link', () => {
  beforeEach(() => { captured = undefined; stub = {}; installSelect(); installInsert(); });
  afterEach(() => { delete globalThis.SELECT; delete globalThis.INSERT; });

  it('returns the linked Users row when a UserIdentities link exists', async () => {
    stub.identityRow = { user_ID: 'u-1' };
    stub.usersRows = [{ ID: 'u-1', sapId: 'I809764', email: 'thomas.jung@sap.com' }];
    const row = await resolveUser(iasUser());
    expect(row).toEqual({ ID: 'u-1', sapId: 'I809764', email: 'thomas.jung@sap.com' });
  });

  it('returns null when no link row exists and no other tier matches', async () => {
    stub.identityRow = null;
    stub.usersRows = [];
    expect(await resolveUser(iasUser())).toBeNull();
  });
});

describe('resolveUser — Tier 2 sapId fast-path + self-heal', () => {
  beforeEach(() => { captured = undefined; stub = {}; installSelect(); installInsert(); });
  afterEach(() => { delete globalThis.SELECT; delete globalThis.INSERT; });

  const xsuaaUser = () => ({
    id: 'thomas.jung@sap.com',
    authInfo: { token: {
      userId: 'I809764',
      payload: { iss: 'https://tutorial-system.authentication.eu10-005.hana.ondemand.com', sub: 'thomas.jung@sap.com' },
    } },
  });

  it('resolves by sapId on Tier-1 miss and writes a link row', async () => {
    stub.identityRow = null;                                   // Tier-1 miss
    stub.usersRows = [{ ID: 'u-1', sapId: 'I809764', email: 'thomas.jung@sap.com' }]; // Tier-2 hit
    const row = await resolveUser(xsuaaUser());
    expect(row.ID).toBe('u-1');
    // self-heal: a UserIdentities link row was inserted for (iss,sub)
    expect(captured.insertEntity).toMatch(/UserIdentities$/);
    expect(captured.insertVals.user_ID).toBe('u-1');
    expect(captured.insertVals.issuer).toBe('https://tutorial-system.authentication.eu10-005.hana.ondemand.com');
    expect(captured.insertVals.subject).toBe('thomas.jung@sap.com');
  });

  it('does NOT write a link row when there is no (iss,sub) to link', async () => {
    stub.identityRow = null;
    stub.usersRows = [{ ID: 'u-1', sapId: 'I809764' }];
    const noIsu = { id: 'tech', authInfo: { token: { userId: 'I809764', payload: {} } } };
    const row = await resolveUser(noIsu);
    expect(row.ID).toBe('u-1');          // still resolves by sapId
    expect(captured.insertEntity).toBeUndefined(); // but no link write (no iss/sub)
  });
});

describe('resolveUser — Tier 3 trusted-token-email', () => {
  beforeEach(() => { captured = undefined; stub = {}; installSelect(); installInsert(); });
  afterEach(() => { delete globalThis.SELECT; delete globalThis.INSERT; });

  it('matches token email → Users.email, prefers the non-SCIM-UUID row, writes a link', async () => {
    stub.identityRow = null;    // T1 miss
    // T2: IAS token has no canonical sapId (sub is the email), so T2 is skipped.
    // T3: email match returns TWO rows — a stray SCIM-UUID row and the real I-number row.
    stub.usersRows = [
      { ID: 'u-scim', sapId: 'fbf099e2-f1b5-4cda-b590-866fed970a2a', email: 'thomas.jung@sap.com' },
      { ID: 'u-real', sapId: 'I809764', email: 'thomas.jung@sap.com' },
    ];
    const row = await resolveUser(iasUser({ email: 'thomas.jung@sap.com' }));
    expect(row.ID).toBe('u-real');                 // non-SCIM-UUID preferred
    expect(captured.insertEntity).toMatch(/UserIdentities$/);
    expect(captured.insertVals.user_ID).toBe('u-real');
    expect(captured.insertVals.emailVerified).toBe(true);
  });

  it('skips a stored noreply.github.com row as a match target', async () => {
    stub.identityRow = null;
    stub.usersRows = [{ ID: 'u-gh', sapId: null, email: 'jung-thomas@users.noreply.github.com' }];
    // token email differs from the synthetic stored one → no match → null
    const row = await resolveUser(iasUser({ email: 'thomas.jung@sap.com' }));
    // Our stub returns the row regardless of WHERE, so Tier 3 must FILTER it out:
    expect(row).toBeNull();
  });

  it('returns null when the token carries no usable email', async () => {
    stub.identityRow = null;
    stub.usersRows = [];
    const noEmail = { id: 'u', authInfo: { token: { payload: {
      iss: 'https://atxgsg7zi.accounts.ondemand.com', sub: 'ba411614-uuid-not-email',
    } } } };
    expect(await resolveUser(noEmail)).toBeNull();
  });
});

describe('tokenEmail', () => {
  beforeEach(() => { installSelect(); });
  afterEach(() => { delete globalThis.SELECT; });
  it('prefers the email claim, lowercased', async () => {
    const { tokenEmail } = await import('../../packages/core/resolve-db-user.js');
    expect(tokenEmail(iasUser({ email: 'Thomas.Jung@SAP.com' }))).toBe('thomas.jung@sap.com');
  });
  it('falls back to an email-shaped sub', async () => {
    const { tokenEmail } = await import('../../packages/core/resolve-db-user.js');
    expect(tokenEmail(iasUser({ sub: 'a@b.com', email: undefined }))).toBe('a@b.com');
  });
  it('returns null for a non-email sub with no email claim', async () => {
    const { tokenEmail } = await import('../../packages/core/resolve-db-user.js');
    expect(tokenEmail(iasUser({ sub: 'uuid-not-email', email: undefined }))).toBeNull();
  });
});

describe('pinResolvedUser', () => {
  beforeEach(() => { captured = undefined; stub = {}; installSelect(); installInsert(); });
  afterEach(() => { delete globalThis.SELECT; delete globalThis.INSERT; });

  it('pins sapId → authInfo.token.userId and ID → attr.dbUserId for a SAP user', async () => {
    const { pinResolvedUser } = await import('../../packages/core/resolve-db-user.js');
    stub.identityRow = { user_ID: 'u-1' };
    stub.usersRows = [{ ID: 'u-1', sapId: 'I809764', email: 'x@sap.com' }];
    const user = iasUser();
    const row = await pinResolvedUser(user);
    expect(row.ID).toBe('u-1');
    expect(user.authInfo.token.userId).toBe('I809764');
    expect(user.attr.dbUserId).toBe('u-1');
  });

  it('pins only attr.dbUserId for a no-sapId (social) user', async () => {
    const { pinResolvedUser } = await import('../../packages/core/resolve-db-user.js');
    stub.identityRow = { user_ID: 'u-social' };
    stub.usersRows = [{ ID: 'u-social', sapId: null, email: 'who@gmail.com' }];
    const user = iasUser();
    await pinResolvedUser(user);
    expect(user.attr.dbUserId).toBe('u-social');
    expect(user.authInfo.token.userId).toBeUndefined();
  });

  it('is a no-op (null) on resolution miss', async () => {
    const { pinResolvedUser } = await import('../../packages/core/resolve-db-user.js');
    stub.identityRow = null; stub.usersRows = [];
    const user = iasUser();
    expect(await pinResolvedUser(user)).toBeNull();
    expect(user.attr?.dbUserId).toBeUndefined();
  });
});

describe('removed email-join exports', () => {
  it('no longer exports resolveIasSapId / pinIasSapId', async () => {
    const mod = await import('../../packages/core/resolve-db-user.js');
    expect(mod.resolveIasSapId).toBeUndefined();
    expect(mod.pinIasSapId).toBeUndefined();
  });
});
