import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import crypto from 'node:crypto';

// Module-scope boot (pattern from author-service.test.js / admin-bulk-last-chance.test.js).
const project = cds.test('serve', '--project', '.', '--in-memory');

// alice@example.com is used as sapId (resolveUserSapId falls back to user.id in unit/basic-auth contexts).
const ALICE_ID = 'alice@example.com';
const aliceUser = { id: ALICE_ID };
// PatService is @requires:'authenticated-user' at service level; unit tests must pass that role.
const ALICE_ROLES = { 'authenticated-user': true };

/** Call an unbound PatService action as the given user. */
async function callAction(srv, event, data, user = aliceUser) {
  return srv.tx(
    { user: { id: user.id, roles: ALICE_ROLES } },
    (tx) => tx.send({ event, data })
  );
}

/** Call a bound PatService action (e.g. revokePAT on MyPATs) as the given user. */
async function callBoundAction(srv, event, entity, params, user = aliceUser) {
  return srv.tx(
    { user: { id: user.id, roles: ALICE_ROLES } },
    (tx) => tx.send({ event, entity, params, data: {} })
  );
}

describe('PatService.mintPAT + revokePAT', () => {
  let srv;

  beforeAll(async () => {
    srv = await cds.connect.to('PatService');
    const { Users } = cds.entities('com.sap.developers.ims');
    // Upsert — idempotent if test suite restarts.
    const existing = await SELECT.one.from(Users).where({ sapId: ALICE_ID });
    if (!existing) {
      await INSERT.into(Users).entries({
        ID: cds.utils.uuid(),
        sapId: ALICE_ID,
        email: ALICE_ID,
        displayName: 'Alice'
      });
    }
  });

  it('mints a token, returns plaintext exactly once, stores only the hash', async () => {
    const result = await callAction(srv, 'mintPAT', {
      name: 'my-claude-desktop',
      scopes: ['read'],
      ttlDays: 90
    });
    expect(result.token).toMatch(/^pat_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{40,}$/);
    expect(result.prefix).toMatch(/^pat_[A-Za-z0-9]{8}$/);
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now() + 89 * 24 * 3600 * 1000);

    const { PATs } = cds.entities('com.sap.developers.ims');
    const [row] = await SELECT.from(PATs).where({ ID: result.ID });
    const expectedHash = crypto.createHash('sha256').update(result.token).digest('hex');
    expect(row.hashHex).toBe(expectedHash);
    expect(row.hashHex).not.toBe(result.token);
    expect(row.name).toBe('my-claude-desktop');
  });

  it('clamps ttlDays into [1, 365]', async () => {
    const overshoot = await callAction(srv, 'mintPAT', {
      name: 'too-long',
      scopes: ['read'],
      ttlDays: 9999
    });
    const daysFromNow = (new Date(overshoot.expiresAt) - Date.now()) / (24 * 3600 * 1000);
    expect(daysFromNow).toBeLessThanOrEqual(366);
  });

  it('rejects unknown scopes', async () => {
    await expect(
      callAction(srv, 'mintPAT', {
        name: 'bad-scope',
        scopes: ['nuke-the-world'],
        ttlDays: 30
      })
    ).rejects.toThrow(/scope/i);
  });

  it('revokes a token — subsequent reads see revokedAt set', async () => {
    const minted = await callAction(srv, 'mintPAT', {
      name: 'to-revoke',
      scopes: ['read'],
      ttlDays: 30
    });
    // #1132: revokePAT is now a BOUND action on MyPATs — invoke with the row
    // key via `params` rather than passing ID in the action data.
    await callBoundAction(srv, 'revokePAT', 'MyPATs', [{ ID: minted.ID }]);

    const { PATs } = cds.entities('com.sap.developers.ims');
    const [row] = await SELECT.from(PATs).where({ ID: minted.ID });
    expect(row.revokedAt).toBeTruthy();
  });
});
