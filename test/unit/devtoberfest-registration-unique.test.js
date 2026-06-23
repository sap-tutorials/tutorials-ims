// test/unit/devtoberfest-registration-unique.test.js
// Verifies the @assert.unique.userEvent constraint rejects duplicate
// (user, event) rows. The constraint is the safety net behind the
// idempotent join flow — POST /api/devtoberfest/join can safely retry
// because the DB enforces "one registration per user-event pair".

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('EventRegistrations @assert.unique.userEvent', () => {
  let Users, Events, EventRegistrations;
  const userId = cds.utils.uuid();
  const eventId = cds.utils.uuid();

  beforeAll(() => {
    ({ Users, Events, EventRegistrations } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(EventRegistrations);
    await DELETE.from(Users).where({ ID: userId });
    await DELETE.from(Events).where({ ID: eventId });
    await INSERT.into(Users).entries({ ID: userId, sapId: 'C1234567', email: 'a@b', legacyId: 1234567 });
    await INSERT.into(Events).entries({
      ID: eventId, name: 'Devtoberfest 2026',
      startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-28T00:00:00Z',
      legacyId: 9001,
    });
  });

  it('accepts the first registration for a (user, event) pair', async () => {
    await INSERT.into(EventRegistrations).entries({
      ID: cds.utils.uuid(),
      user_ID: userId, event_ID: eventId,
      joinedAt: new Date().toISOString(),
      termsVersion: 1,
      termsAcceptedAt: new Date().toISOString(),
      legacyId: 1,
    });
    const rows = await SELECT.from(EventRegistrations);
    expect(rows.length).toBe(1);
  });

  it('rejects a second registration for the same (user, event)', async () => {
    await INSERT.into(EventRegistrations).entries({
      ID: cds.utils.uuid(),
      user_ID: userId, event_ID: eventId,
      joinedAt: new Date().toISOString(),
      termsVersion: 1,
      termsAcceptedAt: new Date().toISOString(),
      legacyId: 1,
    });
    await expect(
      INSERT.into(EventRegistrations).entries({
        ID: cds.utils.uuid(),
        user_ID: userId, event_ID: eventId,
        joinedAt: new Date().toISOString(),
        termsVersion: 1,
        termsAcceptedAt: new Date().toISOString(),
        legacyId: 2,
      })
    ).rejects.toThrow(/unique|UNIQUE_CONSTRAINT|userEvent/i);
  });

  it('allows the same user to register for a different event', async () => {
    const otherEventId = cds.utils.uuid();
    // Note: beforeEach cleaned the FIRST event, so insert it here too
    await INSERT.into(Events).entries({
      ID: otherEventId, name: 'Devtoberfest 2027',
      startDate: '2027-10-01T00:00:00Z', endDate: '2027-10-28T00:00:00Z',
      legacyId: 9002,
    });
    await INSERT.into(EventRegistrations).entries({
      ID: cds.utils.uuid(),
      user_ID: userId, event_ID: eventId,
      joinedAt: new Date().toISOString(),
      termsVersion: 1,
      termsAcceptedAt: new Date().toISOString(),
      legacyId: 10,
    });
    await INSERT.into(EventRegistrations).entries({
      ID: cds.utils.uuid(),
      user_ID: userId, event_ID: otherEventId,
      joinedAt: new Date().toISOString(),
      termsVersion: 1,
      termsAcceptedAt: new Date().toISOString(),
      legacyId: 11,
    });
    const rows = await SELECT.from(EventRegistrations);
    expect(rows.length).toBe(2);
    // Cleanup — DELETE the extra event so other tests aren't affected
    await DELETE.from(EventRegistrations).where({ event_ID: otherEventId });
    await DELETE.from(Events).where({ ID: otherEventId });
  });
});
