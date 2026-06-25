// Hybrid tests for Advocates.user link — runs against real HANA via `cds bind --exec`.
// Spec: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md §5
//
// Two assertions the unit suite (SQLite) can't reliably make:
//   1. @assert.unique.user is enforced as a HANA UNIQUE INDEX/CONSTRAINT,
//      not just by CAP-runtime check.
//   2. cascadeNullPersonal actually NULLs Advocates.user_ID end-to-end
//      when a User is anonymized.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const TEST_PREFIX = '__TEST__advocate-link';
const allowWrites = process.env.ALLOW_HYBRID_WRITES === 'true' && isSafeForWrites();

const describeIf = allowWrites ? describe : describe.skip;

describeIf('Advocates.user — HANA UNIQUE + cascade (hybrid)', () => {
  let db;
  let createdAdvIds = [];
  let createdUserIds = [];

  beforeAll(async () => {
    db = await cds.connect.to('db');
  });

  afterAll(async () => {
    // Clean up — advocates first to release FK.
    if (createdAdvIds.length) {
      try {
        await DELETE.from('com.sap.developers.ims.Advocates').where({ ID: { in: createdAdvIds } });
      } catch (err) {
        console.warn('cleanup: advocates DELETE failed:', err.message);
      }
    }
    if (createdUserIds.length) {
      try {
        await DELETE.from('com.sap.developers.ims.Users').where({ ID: { in: createdUserIds } });
      } catch (err) {
        console.warn('cleanup: users DELETE failed:', err.message);
      }
    }
  });

  // TODO(advocate-user-link-unskip-after-deploy): unskip once HDI deploy provisions USER_ID column.
  it.skip('HANA enforces UNIQUE on Advocates.user_ID at the DB level', async () => {
    const { Advocates, Users } = cds.entities('com.sap.developers.ims');

    const uuid = `${TEST_PREFIX}-u-${Date.now()}`;
    await INSERT.into(Users).entries({ uuid, email: `${uuid}@test.example.com` });
    const u = await SELECT.one.from(Users).where({ uuid });
    createdUserIds.push(u.ID);

    const slugA = `${TEST_PREFIX}-a-${Date.now()}`;
    const slugB = `${TEST_PREFIX}-b-${Date.now() + 1}`;
    await INSERT.into(Advocates).entries({ slug: slugA, firstName: 'T', lastName: 'A', user_ID: u.ID });
    const advA = await SELECT.one.from(Advocates).where({ slug: slugA });
    createdAdvIds.push(advA.ID);

    await expect(
      INSERT.into(Advocates).entries({ slug: slugB, firstName: 'T', lastName: 'B', user_ID: u.ID }),
    ).rejects.toThrow(/ASSERT_UNIQUE|UNIQUE|constraint violation/i);
  });

  // TODO(advocate-user-link-unskip-after-deploy): unskip once HDI deploy provisions USER_ID column.
  it.skip('cascadeNullPersonal NULLs Advocates.user_ID when User is anonymized', async () => {
    const { Advocates, Users } = cds.entities('com.sap.developers.ims');
    const { executeAnonymizationCascade } = await import('../../srv/lib/anonymization-cascade.js');

    const uuid = `${TEST_PREFIX}-u-cascade-${Date.now()}`;
    await INSERT.into(Users).entries({ uuid, email: `${uuid}@test.example.com` });
    const u = await SELECT.one.from(Users).where({ uuid });
    createdUserIds.push(u.ID);

    const slug = `${TEST_PREFIX}-cascade-${Date.now()}`;
    await INSERT.into(Advocates).entries({ slug, firstName: 'C', lastName: 'A', user_ID: u.ID });
    const adv = await SELECT.one.from(Advocates).where({ slug });
    createdAdvIds.push(adv.ID);

    expect(adv.user_ID).toBe(u.ID);

    // Signature is (user, db) — pulls definitions from cds.model internally.
    await executeAnonymizationCascade(u, db);

    const after = await SELECT.one.from(Advocates).where({ ID: adv.ID });
    expect(after.user_ID).toBeNull();
  });
});
