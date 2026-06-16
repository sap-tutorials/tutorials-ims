// test/unit/resolve-db-user.test.js
//
// Issue #343: CAP user-resolver fix. Validates that resolveUserSapId reads
// the right field from the request context across the production XSUAA path
// and the test/basic-auth fallback paths.
//
// resolveDbUser is not unit-tested here because it requires CAP runtime
// (`cds.entities`, `SELECT.one`); it's covered by hybrid + smoke tests.

import { describe, it, expect } from 'vitest';
import { resolveUserSapId } from '../../srv/lib/resolve-db-user.js';

describe('resolveUserSapId', () => {
  it('returns null for null/undefined user', () => {
    expect(resolveUserSapId(null)).toBeNull();
    expect(resolveUserSapId(undefined)).toBeNull();
  });

  it('returns null for anonymous user', () => {
    expect(resolveUserSapId({ id: 'anonymous' })).toBeNull();
  });

  it('returns null for user without an id', () => {
    expect(resolveUserSapId({})).toBeNull();
    expect(resolveUserSapId({ id: '' })).toBeNull();
  });

  it('production XSUAA path: reads authInfo.token.userId (= JWT user_uuid claim)', () => {
    // This is the PRIMARY path for migrated users on cutover-day. The XSUAA
    // JWT carries the SAP ID in the `user_uuid` claim; @sap/xssec exposes it
    // as token.userId (Token.js:240 — `get userId() { return this.payload.user_uuid; }`).
    const user = {
      id: 'thomas.jung@sap.com',
      authInfo: { token: { userId: 'I809764' } },
    };
    expect(resolveUserSapId(user)).toBe('I809764');
  });

  it('defensive: reads authInfo.token.payload.user_uuid if userId getter is absent', () => {
    // Guards against future xssec API changes that might drop the `userId`
    // shorthand. The raw payload claim name is canonical.
    const user = {
      id: 'thomas.jung@sap.com',
      authInfo: { token: { payload: { user_uuid: 'I809764' } } },
    };
    expect(resolveUserSapId(user)).toBe('I809764');
  });

  it('test/basic-auth fallback: returns user.id when no JWT info is present', () => {
    // Used by tests that mock cds.context.user with a bare `{ id }` object,
    // and by basic-auth tech users (CONTENT_API_KEY, dev-mode workflows)
    // where there is no JWT.
    expect(resolveUserSapId({ id: 'I809764' })).toBe('I809764');
  });

  it('prefers authInfo.token.userId over user.id when both present', () => {
    // Critical: for a real XSUAA login, user.id is the email and userId is
    // the SAP ID. The JWT claim wins.
    const user = {
      id: 'thomas.jung@sap.com',
      authInfo: { token: { userId: 'I809764' } },
    };
    expect(resolveUserSapId(user)).toBe('I809764');
    expect(resolveUserSapId(user)).not.toBe('thomas.jung@sap.com');
  });

  it('prefers token.userId over token.payload.user_uuid (xssec shorthand wins)', () => {
    const user = {
      id: 'thomas.jung@sap.com',
      authInfo: { token: { userId: 'I809764', payload: { user_uuid: 'STALE-VALUE' } } },
    };
    expect(resolveUserSapId(user)).toBe('I809764');
  });

  it('returns user.id when authInfo.token has neither userId nor payload.user_uuid', () => {
    // This happens for tokens minted by paths other than the SAP ID Service /
    // XSUAA flow (e.g. tech user tokens for system-to-system calls). user.id
    // is the documented fallback.
    const user = {
      id: 'system',
      authInfo: { token: {} },
    };
    expect(resolveUserSapId(user)).toBe('system');
  });
});
