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
import path from 'node:path';
import { isSafeForWrites } from './_guard.js';

const TEST_PREFIX = '__TEST__advocate-link';
const allowWrites = process.env.ALLOW_HYBRID_WRITES === 'true' && isSafeForWrites();

const describeIf = allowWrites ? describe : describe.skip;

describeIf('Advocates.user — HANA UNIQUE + cascade (hybrid)', () => {
  let db;
  let createdAdvIds = [];
  let createdUserIds = [];

  beforeAll(async () => {
    // Load + activate the CDS model so the cascade module sees the
    // @PersonalData annotations defined in db/audit-logging.cds. We
    // explicitly load the whole `db` directory (which pulls in schema.cds
    // AND audit-logging.cds AND advocates.cds) — not just schema.cds,
    // which doesn't import audit-logging. Without audit-logging in the
    // loaded model, executeAnonymizationCascade has no cascade plan
    // entry for Advocates and silently no-ops.
    //
    // We avoid `cds.test('serve', ...)` because its server-bootstrap hook
    // times out at 10s on Windows (the codebase's
    // feedback_check_scripts_pool_flake_on_windows class of issue).
    cds.model = await cds.load(['db/']);
    db = await cds.connect.to('db');
  }, 60_000);

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

  it('HANA enforces UNIQUE on Advocates.user_ID at the DB level', async () => {
    // Use string entity names (fully qualified) — cds.entities() is a
    // runtime helper that's not available without cds.test('serve'); the
    // string form works in db.run/INSERT/SELECT just as well.
    const Advocates = 'com.sap.developers.ims.Advocates';
    const Users = 'com.sap.developers.ims.Users';

    // Users.uuid is String(36) — must fit a real UUID.
    const uuid = crypto.randomUUID();
    const email = `${TEST_PREFIX}-u-${Date.now()}@test.example.com`;
    await INSERT.into(Users).entries({ uuid, email });
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

  it('cascadeNullPersonal NULLs Advocates.user_ID when User is anonymized', async () => {
    const Advocates = 'com.sap.developers.ims.Advocates';
    const Users = 'com.sap.developers.ims.Users';
    const { executeAnonymizationCascade } = await import('../../srv/lib/anonymization-cascade.js');

    const uuid = crypto.randomUUID();
    const email = `${TEST_PREFIX}-u-cascade-${Date.now()}@test.example.com`;
    await INSERT.into(Users).entries({ uuid, email });
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

  it('emailEdit round-trip — UPDATE propagates to Users.email on HANA', async () => {
    // Verifies the Task 6 emailEdit virtual handler: an UPDATE on
    // AdminService.Advocates with `emailEdit` flows into the linked
    // Users.email column on real HANA.
    //
    // Route through AdminService so the before('UPDATE') handler chain
    // actually fires. cds.connect.to('AdminService') returns a service
    // instance whose .run() processes the request through registered
    // handlers; db.run() would bypass them and turn this test into a
    // tautology.
    //
    // KNOWN CONCERN: Task 6's handler reads emailEdit from
    // req._.req.body (the raw HTTP body) because CAP strips virtuals
    // from req.data on OData PATCH. Programmatic srv.run(UPDATE(...))
    // does NOT carry a raw HTTP body — so this path may not exercise
    // the propagation. If this assertion fails when Tom runs it against
    // HANA, the honest finding is that the handler needs to also read
    // from req.data.emailEdit as a fallback for programmatic callers.
    const Advocates = 'com.sap.developers.ims.Advocates';
    const Users = 'com.sap.developers.ims.Users';

    const uuid = crypto.randomUUID();
    const beforeEmail = `${TEST_PREFIX}-email-before-${Date.now()}@test.example.com`;
    const afterEmail = `${TEST_PREFIX}-email-after-${Date.now()}@test.example.com`;

    await INSERT.into(Users).entries({ uuid, email: beforeEmail });
    const u = await SELECT.one.from(Users).where({ uuid });
    createdUserIds.push(u.ID);

    const slug = `${TEST_PREFIX}-email-rt-${Date.now()}`;
    await INSERT.into(Advocates).entries({
      slug,
      firstName: '__TEST__',
      lastName: 'EmailRT',
      user_ID: u.ID,
    });
    const adv = await SELECT.one.from(Advocates).where({ slug });
    createdAdvIds.push(adv.ID);

    const adminSrv = await cds.connect.to('AdminService');
    await adminSrv.run(
      UPDATE(adminSrv.entities.Advocates, adv.ID).set({ emailEdit: afterEmail }),
    );

    const updated = await SELECT.one.from(Users).columns('email').where({ ID: u.ID });
    expect(updated.email).toBe(afterEmail);
  });
});
