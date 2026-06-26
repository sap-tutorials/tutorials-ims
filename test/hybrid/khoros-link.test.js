// test/hybrid/khoros-link.test.js
//
// Hybrid test against real HANA via `cds bind --exec`. Run with `npm run test:hybrid`.
// Memory: [feedback_skip_hybrid_test_costs_two_pr_cycles] — @assert.unique behaves
// differently between SQLite (unit) and HANA (hybrid), so this is mandatory.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const TEST_SAPID_A = '__TEST__khoros_a';
const TEST_SAPID_B = '__TEST__khoros_b';

const allowWrites = process.env.ALLOW_HYBRID_WRITES === 'true' && isSafeForWrites();
const describeIf = allowWrites ? describe : describe.skip;

describeIf('khoros link — HANA', () => {
  let db;
  const Users = 'com.sap.developers.ims.Users';

  beforeAll(async () => {
    // Load the CDS model so entity reflection and @assert.unique annotations
    // are available (same pattern as advocate-user-link.test.js).
    cds.model = await cds.load(['db/']);
    db = await cds.connect.to('db');
    // Clean up any stale test rows first.
    await db.run(DELETE.from(Users).where({ sapId: { in: [TEST_SAPID_A, TEST_SAPID_B] } }));
    await db.run(INSERT.into(Users).entries([
      { uuid: crypto.randomUUID(), sapId: TEST_SAPID_A, email: 'khoros-a@example.com' },
      { uuid: crypto.randomUUID(), sapId: TEST_SAPID_B, email: 'khoros-b@example.com' },
    ]));
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.run(DELETE.from(Users).where({ sapId: { in: [TEST_SAPID_A, TEST_SAPID_B] } }));
    }
  });

  it('persists all 4 columns on link', async () => {
    const now = new Date();
    await db.run(UPDATE(Users)
      .set({ khorosId: '99001', khorosLogin: 'test_a', khorosAvatarUrl: 'https://x/a.png', khorosLinkedAt: now })
      .where({ sapId: TEST_SAPID_A }));
    const row = await db.run(SELECT.one.from(Users).where({ sapId: TEST_SAPID_A }));
    expect(row.khorosId).toBe('99001');
    expect(row.khorosLogin).toBe('test_a');
    expect(row.khorosAvatarUrl).toBe('https://x/a.png');
    expect(row.khorosLinkedAt).toBeTruthy();
  });

  it('@assert.unique.khorosId rejects a second user with the same khorosId', async () => {
    await db.run(UPDATE(Users).set({ khorosId: '99001' }).where({ sapId: TEST_SAPID_A }));
    await expect(
      db.run(UPDATE(Users).set({ khorosId: '99001' }).where({ sapId: TEST_SAPID_B }))
    ).rejects.toThrow(/unique/i);
  });

  it('allows two NULL khorosIds (nullable-aware uniqueness)', async () => {
    await db.run(UPDATE(Users).set({ khorosId: null }).where({ sapId: TEST_SAPID_A }));
    await db.run(UPDATE(Users).set({ khorosId: null }).where({ sapId: TEST_SAPID_B }));
    // No throw — both can coexist with null.
  });

  it('clearing nulls all 4 columns', async () => {
    await db.run(UPDATE(Users)
      .set({ khorosId: '99002', khorosLogin: 'x', khorosAvatarUrl: 'u', khorosLinkedAt: new Date() })
      .where({ sapId: TEST_SAPID_A }));
    await db.run(UPDATE(Users)
      .set({ khorosId: null, khorosLogin: null, khorosAvatarUrl: null, khorosLinkedAt: null })
      .where({ sapId: TEST_SAPID_A }));
    const row = await db.run(SELECT.one.from(Users).where({ sapId: TEST_SAPID_A }));
    expect(row.khorosId).toBeNull();
    expect(row.khorosLogin).toBeNull();
    expect(row.khorosAvatarUrl).toBeNull();
    expect(row.khorosLinkedAt).toBeNull();
  });

  it('admin clearKhorosLink nulls the 4 columns + evicts cache', async () => {
    // Seed a linked user.
    await db.run(UPDATE(Users)
      .set({ khorosId: '99003', khorosLogin: 'adm', khorosAvatarUrl: 'u', khorosLinkedAt: new Date() })
      .where({ sapId: TEST_SAPID_A }));
    const row = await db.run(SELECT.one.from(Users).where({ sapId: TEST_SAPID_A }));

    // Drive the bound action via cds.connect to AdminService.
    const admin = await cds.connect.to('AdminService');
    const result = await admin.send('clearKhorosLink', row.ID, {});
    expect(result?.status).toBe('ok');

    const cleared = await db.run(SELECT.one.from(Users).where({ ID: row.ID }));
    expect(cleared.khorosId).toBeNull();
    expect(cleared.khorosLogin).toBeNull();
    expect(cleared.khorosAvatarUrl).toBeNull();
    expect(cleared.khorosLinkedAt).toBeNull();
  });
});
