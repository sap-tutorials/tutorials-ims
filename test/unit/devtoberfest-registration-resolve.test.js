import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { isJoinedCurrentEvent } from '../../srv/lib/devtoberfest-registration.js';

// Regression for the "shows Join, but Join returns 409 ALREADY_JOINED" paradox.
// Root cause: the READ path (isJoinedCurrentEvent) resolved via resolveDbUser,
// whose unpinned fallback is a bare where({ sapId }). A human on one universal
// SAP ID presents a token user_uuid (the XSUAA sapId claim) that is NOT the
// stored Users.sapId — so the bare lookup missed and reported "not joined",
// while the WRITE path (joinHandler → provisionDbUser → resolveUser) matched the
// row via its UserIdentities (iss,sub) link and returned 409. Fix: the read path
// now uses the SAME tiered resolver (resolveUser), so read agrees with write.

const project = cds.test('serve', '--project', '.', '--in-memory');

const CANON = 'aaaaaaaa-0000-0000-0000-000000000001';
const EVENT = 'eeeeeeee-0000-0000-0000-0000000000ev';
const ISS = 'https://tenant.authentication.eu10.hana.ondemand.com/oauth/token';
const SUB = 'ffffffff-aaaa-bbbb-cccc-000000000sub';   // token (iss,sub) subject
const TOKEN_UUID = 'uuuuuuuu-0000-0000-0000-0000token';   // token user_uuid ≠ stored sapId

describe('isJoinedCurrentEvent resolves via the tiered resolver (read agrees with write)', () => {
  beforeAll(async () => {
    const { Users, UserIdentities, DevtoberfestConfig, EventRegistrations } =
      cds.entities('com.sap.developers.ims');
    // Canonical row: stored sapId is DIFFERENT from the token's user_uuid; the
    // durable link to the login is the (iss,sub) UserIdentities row.
    await INSERT.into(Users).entries({ ID: CANON, uuid: 'u@example.com', email: 'u@example.com', sapId: 'STORED-SAPID-d8d43cf4' });
    await INSERT.into(UserIdentities).entries({ ID: 'ui-1', user_ID: CANON, issuer: ISS, subject: SUB, provider: 'sap-id', email: 'u@example.com', emailVerified: true });
    await INSERT.into(DevtoberfestConfig).entries({ ID: 'cfg-1', isActive: true, currentEvent_ID: EVENT });
    await INSERT.into(EventRegistrations).entries({ ID: 'reg-1', user_ID: CANON, event_ID: EVENT });
  });

  it('joined=true when the token (iss,sub) link matches, even though token sapId ≠ stored sapId', async () => {
    // This is the Tim case: user_uuid is not the stored sapId; resolution must
    // succeed via the (iss,sub) UserIdentities link (Tier 1).
    const user = { id: 'u@example.com', authInfo: { token: {
      userId: TOKEN_UUID,
      payload: { iss: ISS, sub: SUB, email: 'u@example.com' },
    } } };
    expect(await isJoinedCurrentEvent(user)).toBe(true);
  });

  it('joined=true via trusted email (Tier 3) when no (iss,sub) link and sapId mismatches', async () => {
    const user = { id: 'u@example.com', authInfo: { token: {
      userId: 'no-match-uuid',
      payload: { email: 'u@example.com' },
    } } };
    expect(await isJoinedCurrentEvent(user)).toBe(true);
  });

  it('joined=false when nothing resolves (unknown sub, no email, non-matching sapId)', async () => {
    const user = { id: 'stranger', authInfo: { token: { userId: 'no-match-uuid', payload: {} } } };
    expect(await isJoinedCurrentEvent(user)).toBe(false);
  });

  it('returns false for anonymous', async () => {
    expect(await isJoinedCurrentEvent({ id: 'anonymous' })).toBe(false);
  });
});
