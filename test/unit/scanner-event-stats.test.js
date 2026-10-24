// #badge-v2 — ScannerService.getEventStats: per-event aggregate for the badge scanner.
// Scopes on TaskRecords.event_ID (badge/app-space path), has-ever-completed DISTINCT
// semantic, CLAIMED vs EARNED vs Prizes catalog. Cross-event rows must not leak.

import { beforeEach, describe, expect, it } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('ScannerService.getEventStats (#badge-v2)', () => {
  const EVENT_LEGACY = 9921;
  const OTHER_LEGACY = 9922;
  const USER_A = 'uuid-es-a';
  const USER_B = 'uuid-es-b';

  beforeEach(async () => {
    const { Users, Events, Prizes, PrizeRecords, TaskRecords } = cds.entities('com.sap.developers.ims');
    await DELETE.from(PrizeRecords);
    await DELETE.from(TaskRecords);
    await DELETE.from(Prizes);
    await DELETE.from(Events);
    await DELETE.from(Users);

    await INSERT.into(Users).entries([
      { ID: USER_A, uuid: USER_A, sapId: 'sap-a' },
      { ID: USER_B, uuid: USER_B, sapId: 'sap-b' },
    ]);
    await INSERT.into(Events).entries([
      { ID: 'evt-es-main',  legacyId: EVENT_LEGACY, name: 'Stats Event' },
      { ID: 'evt-es-other', legacyId: OTHER_LEGACY, name: 'Other' },
    ]);
    // 3 prizes available on main event.
    await INSERT.into(Prizes).entries([
      { ID: 'pz1', name: 'P1', event_ID: 'evt-es-main' },
      { ID: 'pz2', name: 'P2', event_ID: 'evt-es-main' },
      { ID: 'pz3', name: 'P3', event_ID: 'evt-es-main' },
    ]);
    // main: 2 CLAIMED (A,B) + 1 EARNED (A); other: 1 CLAIMED (must not count).
    await INSERT.into(PrizeRecords).entries([
      { ID: 'prA-c', user_ID: USER_A, event_ID: 'evt-es-main',  prize_ID: 'pz1', status: 'CLAIMED', legacyId: 90001 },
      { ID: 'prB-c', user_ID: USER_B, event_ID: 'evt-es-main',  prize_ID: 'pz2', status: 'CLAIMED', legacyId: 90002 },
      { ID: 'prA-e', user_ID: USER_A, event_ID: 'evt-es-main',  prize_ID: 'pz3', status: 'EARNED',  legacyId: 90003 },
      { ID: 'prB-o', user_ID: USER_B, event_ID: 'evt-es-other', prize_ID: null,  status: 'CLAIMED', legacyId: 90004 },
    ]);
    // Completions on main: A=2 distinct TUTORIAL + 1 GROUP; B=1 TUTORIAL.
    // One TUTORIAL for A on OTHER event — must not count.
    await INSERT.into(TaskRecords).entries([
      { ID: 'trA1', user_ID: USER_A, taskType: 'TUTORIAL', taskLegacyId: 1, status: 'COMPLETED', event_ID: 'evt-es-main' },
      { ID: 'trA2', user_ID: USER_A, taskType: 'TUTORIAL', taskLegacyId: 2, status: 'SUPERSEDED', event_ID: 'evt-es-main' },
      { ID: 'trA3', user_ID: USER_A, taskType: 'GROUP',    taskLegacyId: 3, status: 'COMPLETED', event_ID: 'evt-es-main' },
      { ID: 'trB1', user_ID: USER_B, taskType: 'TUTORIAL', taskLegacyId: 1, status: 'COMPLETED', event_ID: 'evt-es-main' },
      { ID: 'trAx', user_ID: USER_A, taskType: 'TUTORIAL', taskLegacyId: 9, status: 'COMPLETED', event_ID: 'evt-es-other' },
    ]);
  });

  const call = (eventId) =>
    cds.connect.to('ScannerService').then(s =>
      s.tx({ user: new cds.User.Privileged() }, tx => tx.send({ event: 'getEventStats', data: { eventId } }))
    );

  it('aggregates prizes, participation, and completions for the event', async () => {
    const r = await call(EVENT_LEGACY);
    expect(r.eventName).toBe('Stats Event');
    expect(r.prizesClaimed).toBe(2);
    expect(r.prizesAvailable).toBe(3);
    expect(r.earnedAwaitingHandover).toBe(1);
    expect(r.participants).toBe(2);
    expect(r.participantsClaimed).toBe(2);
    expect(r.tutorialsCompleted).toBe(3);
    expect(r.groupsCompleted).toBe(1);
    expect(r.missionsCompleted).toBe(0);
  });

  it('does not leak rows from a different event', async () => {
    const r = await call(OTHER_LEGACY);
    expect(r.prizesClaimed).toBe(1);
    expect(r.prizesAvailable).toBe(0);
    expect(r.tutorialsCompleted).toBe(1);
  });

  it('returns a zeroed shape for an unresolvable event (no throw)', async () => {
    const r = await call(999999);
    expect(r.eventName).toBeNull();
    expect(r.prizesClaimed).toBe(0);
    expect(r.participants).toBe(0);
    expect(r.tutorialsCompleted).toBe(0);
  });
});
