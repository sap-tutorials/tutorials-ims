// Phase A2 (#809) — Regression guard. ScannerService was `@requires:
// 'authenticated-user'`, which allowed any authenticated JWT direct-srv
// access to `getContestant` / `claimPrize`. The approuter enforces the
// MobileApp scope at ingress, but the srv layer did not -- so a leaked
// srv URL or a hybrid-dev bypass could enumerate contestants.
//
// A2 tightens the CDS gate to `MobileApp`. This test asserts BOTH the
// static CDS annotation AND the runtime behavior (authenticated-user
// -only callers are rejected 403, MobileApp callers succeed).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('ScannerService — @requires: MobileApp (A2)', () => {
  it('CDS file annotates @requires: MobileApp', () => {
    const src = readFileSync(
      join(process.cwd(), 'srv/scanner-service.cds'),
      'utf8'
    );
    expect(src).toMatch(/@requires:\s*'MobileApp'/);
    expect(src).not.toMatch(/@requires:\s*'authenticated-user'/);
  });

  it('rejects anonymous callers with 403', async () => {
    const srv = await cds.connect.to('ScannerService');
    await expect(
      srv.tx({ user: { id: 'anonymous', roles: {} } }, (tx) =>
        tx.send({ event: 'getContestant', data: { accountNumber: '8001' } })
      )
    ).rejects.toMatchObject({ code: 403 });
  });

  it('rejects a bare authenticated-user (no MobileApp scope) with 403', async () => {
    const srv = await cds.connect.to('ScannerService');
    // A bare JWT without MobileApp scope -- previously allowed, now denied.
    await expect(
      srv.tx(
        { user: { id: 'jwt-user', roles: { 'authenticated-user': true } } },
        (tx) =>
          tx.send({ event: 'getContestant', data: { accountNumber: '8001' } })
      )
    ).rejects.toMatchObject({ code: 403 });
  });

  it('permits callers holding MobileApp scope', async () => {
    const { Users } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Users);
    await INSERT.into(Users).entries({
      ID: 'u-alice', uuid: 'u-alice', sapId: 'sap-alice',
      legacyId: 8001, displayName: 'Alice'
    });

    const srv = await cds.connect.to('ScannerService');
    // getContestant currently returns an object shape even when the
    // contestant has zero completions; the point of this test is the
    // scope check, not the response shape. Do not assert on fields.
    const result = await srv.tx(
      { user: { id: 'scanner-op', roles: { MobileApp: true } } },
      (tx) =>
        tx.send({ event: 'getContestant', data: { accountNumber: '8001' } })
    );
    expect(result).toBeDefined();
  });
});
