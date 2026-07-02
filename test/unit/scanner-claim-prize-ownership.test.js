// #889 — ScannerService.claimPrize must verify PrizeRecords.user_ID matches
// the scanned contestant. Without the fix any caller with MobileApp scope
// could claim any prize by enumerating legacyIds.
//
// This test also protects against regression: if the ownership check is
// accidentally removed during a future refactor (either by pattern-matching
// on 'authenticated-user' as "sufficient", or by extracting the handler
// into a helper that drops the second arg), CI will fail.

import { beforeEach, describe, expect, it } from 'vitest';
import cds from '@sap/cds';

// Boot CAP once at module load with in-memory SQLite so `cds.entities(...)`
// resolves inside beforeEach — same pattern as test/unit/reset-tutorial-progress.test.js.
cds.test('serve', '--project', '.', '--in-memory');

describe('#889 — ScannerService.claimPrize ownership check', () => {
  beforeEach(async () => {
    const { Users, PrizeRecords } = cds.entities('com.sap.developers.ims');
    await DELETE.from(PrizeRecords);
    await DELETE.from(Users);

    // Alice (contestant just scanned) + Bob (someone else on the leaderboard).
    // Prize belongs to Bob.
    await INSERT.into(Users).entries([
      { ID: 'u-alice', uuid: 'u-alice', sapId: 'sap-alice', legacyId: 8001, displayName: 'Alice' },
      { ID: 'u-bob',   uuid: 'u-bob',   sapId: 'sap-bob',   legacyId: 8002, displayName: 'Bob' },
    ]);
    await INSERT.into(PrizeRecords).entries({
      ID: 'pr-bob-1', user_ID: 'u-bob', status: 'EARNED', legacyId: 42001,
    });
  });

  it('rejects when accountNumber is missing', async () => {
    const scanner = await cds.connect.to('ScannerService');
    await expect(
      scanner.tx({ user: new cds.User.Privileged() }, tx =>
        tx.send({ event: 'claimPrize', data: { recordId: '42001' } })
      )
    ).rejects.toThrow(/accountNumber is required/);
  });

  it('rejects with 403 when the prize belongs to a different user', async () => {
    // Operator scanned Alice (8001), but tries to claim Bob's prize (42001 → u-bob).
    const scanner = await cds.connect.to('ScannerService');
    await expect(
      scanner.tx({ user: new cds.User.Privileged() }, tx =>
        tx.send({ event: 'claimPrize', data: { recordId: '42001', accountNumber: '8001' } })
      )
    ).rejects.toThrow(/does not belong to the scanned contestant/);

    // And the row must be untouched.
    const { PrizeRecords } = cds.entities('com.sap.developers.ims');
    const [row] = await SELECT.from(PrizeRecords).where({ ID: 'pr-bob-1' });
    expect(row.status).toBe('EARNED');
  });

  it('accepts and flips status when the prize belongs to the scanned contestant', async () => {
    // Operator scanned Bob (8002); Bob's prize (42001) → happy path.
    const scanner = await cds.connect.to('ScannerService');
    const result = await scanner.tx({ user: new cds.User.Privileged() }, tx =>
      tx.send({ event: 'claimPrize', data: { recordId: '42001', accountNumber: '8002' } })
    );
    expect(result).toMatch(/claimed successfully/);

    const { PrizeRecords } = cds.entities('com.sap.developers.ims');
    const [row] = await SELECT.from(PrizeRecords).where({ ID: 'pr-bob-1' });
    expect(row.status).toBe('CLAIMED');
  });

  it('returns 404 when accountNumber does not match any user', async () => {
    const scanner = await cds.connect.to('ScannerService');
    await expect(
      scanner.tx({ user: new cds.User.Privileged() }, tx =>
        tx.send({ event: 'claimPrize', data: { recordId: '42001', accountNumber: '99999' } })
      )
    ).rejects.toThrow(/User not found/);
  });
});
