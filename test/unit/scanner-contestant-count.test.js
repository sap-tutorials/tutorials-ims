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

describe('ScannerService.getContestant — identity + claimed prize names (#badge-v2)', () => {
  const USER_UUID    = 'uuid-id-1';
  const BLANK_UUID   = 'uuid-id-blank';
  const EVENT_LEGACY = 9911;

  beforeEach(async () => {
    const { Users, Events, Prizes, PrizeRecords, TaskRecords } = cds.entities('com.sap.developers.ims');
    await DELETE.from(PrizeRecords);
    await DELETE.from(TaskRecords);
    await DELETE.from(Prizes);
    await DELETE.from(Events);
    await DELETE.from(Users);

    await INSERT.into(Users).entries([
      { ID: USER_UUID,  uuid: USER_UUID,  sapId: 'sap-i1', firstName: 'Thomas', lastName: 'Jung' },
      { ID: BLANK_UUID, uuid: BLANK_UUID, sapId: 'sap-i2', firstName: '',       lastName: 'Solo' },
    ]);

    await INSERT.into(Events).entries([
      { ID: 'evt-id-main',  legacyId: EVENT_LEGACY, name: 'Identity Event' },
      { ID: 'evt-id-other', legacyId: 9912,         name: 'Other Event' },
    ]);

    await INSERT.into(Prizes).entries([
      { ID: 'prize-sticker', name: 'Sticker Pack', event_ID: 'evt-id-main' },
    ]);

    // 1 CLAIMED prize with a real prize association → name must resolve.
    await INSERT.into(PrizeRecords).entries([
      { ID: 'pr-id-1', user_ID: USER_UUID, event_ID: 'evt-id-main', prize_ID: 'prize-sticker', status: 'CLAIMED', legacyId: 89001 },
    ]);

    // 2 TUTORIAL completions on the scanned event, 1 on a DIFFERENT event.
    // Card counts must be event-scoped → the other-event row must NOT count.
    await INSERT.into(TaskRecords).entries([
      { ID: 'tr-id-1', user_ID: USER_UUID, taskType: 'TUTORIAL', taskLegacyId: 11, status: 'COMPLETED', event_ID: 'evt-id-main' },
      { ID: 'tr-id-2', user_ID: USER_UUID, taskType: 'TUTORIAL', taskLegacyId: 12, status: 'COMPLETED', event_ID: 'evt-id-main' },
      { ID: 'tr-id-x', user_ID: USER_UUID, taskType: 'TUTORIAL', taskLegacyId: 99, status: 'COMPLETED', event_ID: 'evt-id-other' },
    ]);
  });

  it('returns lastName and a single first initial', async () => {
    const scanner = await cds.connect.to('ScannerService');
    const result = await scanner.tx({ user: new cds.User.Privileged() }, tx =>
      tx.send({ event: 'getContestant', data: { accountNumber: USER_UUID, eventId: EVENT_LEGACY } })
    );
    expect(result.lastName).toBe('Jung');
    expect(result.firstInitial).toBe('T');
  });

  it('returns an empty firstInitial when firstName is blank (no throw)', async () => {
    const scanner = await cds.connect.to('ScannerService');
    const result = await scanner.tx({ user: new cds.User.Privileged() }, tx =>
      tx.send({ event: 'getContestant', data: { accountNumber: BLANK_UUID, eventId: EVENT_LEGACY } })
    );
    expect(result.lastName).toBe('Solo');
    expect(result.firstInitial).toBe('');
  });

  it('resolves claimed prize names for the scoped event', async () => {
    const scanner = await cds.connect.to('ScannerService');
    const result = await scanner.tx({ user: new cds.User.Privileged() }, tx =>
      tx.send({ event: 'getContestant', data: { accountNumber: USER_UUID, eventId: EVENT_LEGACY } })
    );
    expect(result.claimedPrizeNames).toEqual(['Sticker Pack']);
  });

  it('scopes completion counts to the scanned event (#badge-v2)', async () => {
    // 2 TUTORIAL on this event + 1 on another event → card shows 2, not 3.
    const scanner = await cds.connect.to('ScannerService');
    const result = await scanner.tx({ user: new cds.User.Privileged() }, tx =>
      tx.send({ event: 'getContestant', data: { accountNumber: USER_UUID, eventId: EVENT_LEGACY } })
    );
    expect(result.tutorialsCompleted).toBe(2);
  });
});
