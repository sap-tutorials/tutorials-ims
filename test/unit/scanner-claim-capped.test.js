// Task 6 — ScannerService.claimPrizeForContestant
// Enforces a HARD CAP of 2 CLAIMED PrizeRecords per (user, event), atomically.
//
// Three scenarios:
//   (a) user with 1 CLAIMED → claim → claimedCount===2, new row exists
//   (b) user with 2 CLAIMED → claim → claimedCount===2, message 'cap reached (2 of 2)', no new row
//   (c) concurrency: two simultaneous claims at count 1 → final count exactly 2, never 3

import { beforeEach, describe, expect, it } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('ScannerService.claimPrizeForContestant — capped atomic handover', () => {
  const USER_UUID    = 'uuid-prize-user-1';
  const OTHER_UUID   = 'uuid-prize-user-2';
  const EVENT_LEGACY = 8801;
  const EVENT_UUID   = 'evt-prize-main';

  async function claim(accountNumber = USER_UUID, eventId = EVENT_LEGACY) {
    const scanner = await cds.connect.to('ScannerService');
    return scanner.tx({ user: new cds.User.Privileged() }, tx =>
      tx.send({ event: 'claimPrizeForContestant', data: { accountNumber, eventId } })
    );
  }

  async function countClaimed() {
    const { PrizeRecords } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(PrizeRecords).where({
      user_ID: USER_UUID, event_ID: EVENT_UUID, status: 'CLAIMED'
    });
    return rows.length;
  }

  beforeEach(async () => {
    const { Users, Events, PrizeRecords } = cds.entities('com.sap.developers.ims');
    await DELETE.from(PrizeRecords);
    await DELETE.from(Events);
    await DELETE.from(Users);

    await INSERT.into(Users).entries([
      { ID: USER_UUID,  uuid: USER_UUID,  sapId: 'sap-p1', legacyId: 91001, displayName: 'Prize User One' },
      { ID: OTHER_UUID, uuid: OTHER_UUID, sapId: 'sap-p2', legacyId: 91002, displayName: 'Prize User Two' },
    ]);

    await INSERT.into(Events).entries([
      { ID: EVENT_UUID, legacyId: EVENT_LEGACY, name: 'Prize Event' },
    ]);
  });

  // ─── (a) user with 1 CLAIMED → claim → claimedCount===2, new row exists ───

  it('(a) adds a second CLAIMED row when user has 1, returns claimedCount 2', async () => {
    const { PrizeRecords } = cds.entities('com.sap.developers.ims');
    // Seed: 1 existing CLAIMED row
    await INSERT.into(PrizeRecords).entries([
      { ID: 'pr-seed-1', user_ID: USER_UUID, event_ID: EVENT_UUID, status: 'CLAIMED', legacyId: 89001 },
    ]);

    const result = await claim();

    expect(result.claimedCount).toBe(2);
    expect(typeof result.message).toBe('string');
    expect(await countClaimed()).toBe(2);
  });

  // ─── (b) user with 2 CLAIMED → cap reached, no new row ───────────────────

  it('(b) does not insert when cap is already reached, returns claimedCount 2 + cap message', async () => {
    const { PrizeRecords } = cds.entities('com.sap.developers.ims');
    // Seed: 2 existing CLAIMED rows
    await INSERT.into(PrizeRecords).entries([
      { ID: 'pr-seed-2a', user_ID: USER_UUID, event_ID: EVENT_UUID, status: 'CLAIMED', legacyId: 89002 },
      { ID: 'pr-seed-2b', user_ID: USER_UUID, event_ID: EVENT_UUID, status: 'CLAIMED', legacyId: 89003 },
    ]);

    const result = await claim();

    expect(result.claimedCount).toBe(2);
    expect(result.message).toBe('cap reached (2 of 2)');
    // Row count must still be exactly 2 — no new row added
    expect(await countClaimed()).toBe(2);
  });

  // ─── (c) concurrency: two simultaneous claims at count 1 → final count 2 ──

  it('(c) simultaneous claims cannot exceed cap of 2', async () => {
    const { PrizeRecords } = cds.entities('com.sap.developers.ims');
    // Seed: 1 CLAIMED row → both concurrent callers race from count 1
    await INSERT.into(PrizeRecords).entries([
      { ID: 'pr-seed-3', user_ID: USER_UUID, event_ID: EVENT_UUID, status: 'CLAIMED', legacyId: 89004 },
    ]);

    // Fire two simultaneous claim calls
    await Promise.allSettled([claim(), claim()]);

    // Final CLAIMED count must be exactly 2, never 3
    const finalCount = await countClaimed();
    expect(finalCount).toBe(2);
  });

  // ─── edge: 404 for unknown user ──────────────────────────────────────────

  it('rejects with 404 for an unknown accountNumber (UUID)', async () => {
    await expect(claim('no-such-uuid', EVENT_LEGACY)).rejects.toThrow(/User not found/);
  });

  // ─── edge: 404 for unknown event ────────────────────────────────────────

  it('rejects with 404 for an unknown eventId', async () => {
    await expect(claim(USER_UUID, 99999)).rejects.toThrow(/Event not found/);
  });
});
