// Task 5 — ScannerService.getContestant now resolves by UUID (not legacyId)
// and returns an event-scoped claimed-prize count.
//
// Regression guard: if anyone reverts the UUID-lookup or drops eventId scoping,
// CI will fail.

import { beforeEach, describe, expect, it } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('ScannerService.getContestant — UUID lookup + event-scoped count', () => {
  const USER_UUID    = 'uuid-contestant-1';
  const OTHER_UUID   = 'uuid-contestant-2';
  const EVENT_LEGACY = 9901;
  const OTHER_EVENT  = 9902;

  beforeEach(async () => {
    const { Users, Events, PrizeRecords } = cds.entities('com.sap.developers.ims');
    await DELETE.from(PrizeRecords);
    await DELETE.from(Events);
    await DELETE.from(Users);

    await INSERT.into(Users).entries([
      { ID: USER_UUID,  uuid: USER_UUID,  sapId: 'sap-c1', legacyId: 70001, displayName: 'Contestant One' },
      { ID: OTHER_UUID, uuid: OTHER_UUID, sapId: 'sap-c2', legacyId: 70002, displayName: 'Contestant Two' },
    ]);

    await INSERT.into(Events).entries([
      { ID: 'evt-main',  legacyId: EVENT_LEGACY, name: 'Main Event' },
      { ID: 'evt-other', legacyId: OTHER_EVENT,  name: 'Other Event' },
    ]);

    // 1 CLAIMED prize for USER in the main event only.
    // evt-other has no CLAIMED rows for USER — used to verify main-event rows
    // don't bleed into an other-event query.
    await INSERT.into(PrizeRecords).entries([
      { ID: 'pr-c1-main',  user_ID: USER_UUID,  event_ID: 'evt-main',  status: 'CLAIMED',  legacyId: 88001 },
      // EARNED (not yet claimed) for same user + same event — must NOT count
      { ID: 'pr-c1-earn',  user_ID: USER_UUID,  event_ID: 'evt-main',  status: 'EARNED',   legacyId: 88002 },
      // CLAIMED for OTHER_UUID in evt-other — confirms the user filter works too
      { ID: 'pr-c2-other', user_ID: OTHER_UUID, event_ID: 'evt-other', status: 'CLAIMED',  legacyId: 88003 },
    ]);
  });

  it('returns claimedCount=1 and formatted prizeRecords for the scoped event', async () => {
    const scanner = await cds.connect.to('ScannerService');
    const result = await scanner.tx({ user: new cds.User.Privileged() }, tx =>
      tx.send({ event: 'getContestant', data: { accountNumber: USER_UUID, eventId: EVENT_LEGACY } })
    );

    expect(result.claimedCount).toBe(1);
    expect(result.prizeRecords).toBe('1 of 2 prizes claimed');
  });

  it('does not count prizes from a different event', async () => {
    // The OTHER event has no CLAIMED prizes for USER — expect 0
    const scanner = await cds.connect.to('ScannerService');
    const result = await scanner.tx({ user: new cds.User.Privileged() }, tx =>
      tx.send({ event: 'getContestant', data: { accountNumber: USER_UUID, eventId: OTHER_EVENT } })
    );

    expect(result.claimedCount).toBe(0);
    expect(result.prizeRecords).toBe('0 of 2 prizes claimed');
  });

  it('keeps the completion counts intact', async () => {
    const scanner = await cds.connect.to('ScannerService');
    const result = await scanner.tx({ user: new cds.User.Privileged() }, tx =>
      tx.send({ event: 'getContestant', data: { accountNumber: USER_UUID, eventId: EVENT_LEGACY } })
    );

    expect(result).toHaveProperty('tutorialsCompleted');
    expect(result).toHaveProperty('groupsCompleted');
    expect(result).toHaveProperty('missionsCompleted');
  });

  it('rejects with 404 for an unknown UUID', async () => {
    const scanner = await cds.connect.to('ScannerService');
    await expect(
      scanner.tx({ user: new cds.User.Privileged() }, tx =>
        tx.send({ event: 'getContestant', data: { accountNumber: 'no-such-uuid', eventId: EVENT_LEGACY } })
      )
    ).rejects.toThrow(/User not found/);
  });
});
