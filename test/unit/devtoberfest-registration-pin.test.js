import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { isJoinedCurrentEvent } from '../../srv/lib/devtoberfest-registration.js';

// Regression for the "P-user + S-user, points show 0" incident (#2651 follow-up):
// isJoinedCurrentEvent must resolve the Users row via resolveDbUser — honouring
// the before('*') identity pin (attr.dbUserId) — NOT a bare where({ sapId }).
// After an account merge leaves a stale secondary row, a human's second login
// presents a different sapId; a sapId-only lookup lands on the empty husk and
// reports joined=false even though their canonical row IS registered.

const project = cds.test('serve', '--project', '.', '--in-memory');

const PRIMARY = 'aaaaaaaa-0000-0000-0000-000000000001';
const HUSK_SAPID = 'ssssssss-0000-0000-0000-00000000dead';   // a stale/other login's sapId
const EVENT = 'eeeeeeee-0000-0000-0000-0000000000ev';

describe('isJoinedCurrentEvent resolves via the identity pin, not raw sapId', () => {
  beforeAll(async () => {
    const { Users, DevtoberfestConfig, EventRegistrations } =
      cds.entities('com.sap.developers.ims');
    // Canonical row carries a DIFFERENT sapId than the login token will present.
    await INSERT.into(Users).entries({ ID: PRIMARY, uuid: 'pin-user@example.com', email: 'pin-user@example.com', sapId: 'pppppppp-0000-0000-0000-00000000prim' });
    await INSERT.into(DevtoberfestConfig).entries({ ID: 'cfg-pin', isActive: true, currentEvent_ID: EVENT });
    await INSERT.into(EventRegistrations).entries({ ID: 'reg-pin', user_ID: PRIMARY, event_ID: EVENT });
  });

  it('returns true when the pin (attr.dbUserId) points at the registered row, even if sapId mismatches', async () => {
    // Simulates the before('*') pin having resolved the canonical row, while the
    // token's own user_uuid (sapId) belongs to a stale/other login.
    const user = { id: 'login@example.com', attr: { dbUserId: PRIMARY },
      authInfo: { token: { userId: HUSK_SAPID } } };
    expect(await isJoinedCurrentEvent(user)).toBe(true);
  });

  it('returns false for a sapId with no row and no pin (husk scenario)', async () => {
    const user = { id: 'login@example.com', authInfo: { token: { userId: HUSK_SAPID } } };
    expect(await isJoinedCurrentEvent(user)).toBe(false);
  });

  it('returns false for anonymous', async () => {
    expect(await isJoinedCurrentEvent({ id: 'anonymous' })).toBe(false);
  });
});
