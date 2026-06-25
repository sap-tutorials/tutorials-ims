// test/hybrid/migration-runbook-order.test.js
//
// Spec: docs/superpowers/specs/2026-06-24-tutorial-authorship-fk-design.md
// Plan: docs/superpowers/plans/2026-06-24-tutorial-authorship-fk.md (task 10)
//
// Pins the migration-runbook ORDER: Users must be populated BEFORE
// the author backfill runs, or every backfill candidate becomes an
// orphan. A future refactor that reorders the runbook will fail this
// test loudly. This is a cheaper proxy for end-to-end "migrate-users
// then migrate-authors" — instead of running migrate-user-progress.js
// (which needs IMS_BASE_URL + IMS_AUTH_TOKEN), we directly seed a Users
// row and then run the author backfill.

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const TEST_PREFIX = '__TEST__';
const NS = 'com.sap.developers.ims';

describe.runIf(isSafeForWrites())('migration runbook order (#authorship) [hybrid]', () => {
  const cleanup = { users: [], tutorials: [], contributors: [] };

  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error('migration-runbook-order.test.js must run against HANA');
    }
  });

  afterAll(async () => {
    const { Tutorials, TutorialContributors, Users } = cds.entities(NS);
    for (const id of cleanup.contributors) await DELETE.from(TutorialContributors).where({ ID: id });
    for (const id of cleanup.tutorials)    await DELETE.from(Tutorials).where({ ID: id });
    for (const id of cleanup.users)        await DELETE.from(Users).where({ ID: id });
  });

  it('Users-first then backfill: matched (correct order)', async () => {
    const { Tutorials, TutorialContributors, Users } = cds.entities(NS);
    const userId  = cds.utils.uuid();
    const tutId   = cds.utils.uuid();
    const contId  = cds.utils.uuid();
    const slug    = TEST_PREFIX + 'order-after-' + Date.now();
    const email   = TEST_PREFIX + 'order-after-' + Date.now() + '@example.com';
    cleanup.users.push(userId);
    cleanup.tutorials.push(tutId);
    cleanup.contributors.push(contId);

    // Step "migrate-user-progress" equivalent: seed Users row first.
    await INSERT.into(Users).entries({
      ID: userId, uuid: userId,
      sapId: TEST_PREFIX + 'sap-' + userId.slice(0, 8),
      email,
      displayName: TEST_PREFIX + 'Order',
    });
    // Step "migrate-reference-data" equivalent: seed Tutorial + Contributor.
    await INSERT.into(Tutorials).entries({
      ID: tutId, slug, title: TEST_PREFIX + slug, status: 'ACTIVE',
    });
    await INSERT.into(TutorialContributors).entries({
      ID: contId, tutorial_ID: tutId, email, role: 'author',
      name: TEST_PREFIX + 'X',
    });

    // Now run the backfill — should match.
    execFileSync('node', ['scripts/backfill-tutorial-authors.cjs', '--commit'], {
      encoding: 'utf8', stdio: 'pipe',
    });

    const t = await SELECT.one.from(Tutorials).where({ ID: tutId });
    expect(t.author_ID).toBe(userId);
  }, 60_000);

  it('Backfill BEFORE Users-population: orphaned (proves the order matters)', async () => {
    const { Tutorials, TutorialContributors, Users } = cds.entities(NS);
    const tutId  = cds.utils.uuid();
    const contId = cds.utils.uuid();
    const slug   = TEST_PREFIX + 'order-before-' + Date.now();
    const email  = TEST_PREFIX + 'order-before-' + Date.now() + '@example.com';
    cleanup.tutorials.push(tutId);
    cleanup.contributors.push(contId);

    // Seed Tutorial + Contributor WITHOUT seeding the corresponding User.
    await INSERT.into(Tutorials).entries({
      ID: tutId, slug, title: TEST_PREFIX + slug, status: 'ACTIVE',
    });
    await INSERT.into(TutorialContributors).entries({
      ID: contId, tutorial_ID: tutId, email, role: 'author',
      name: TEST_PREFIX + 'OrphanCheck',
    });

    // Run backfill — should NOT match (orphan).
    execFileSync('node', ['scripts/backfill-tutorial-authors.cjs', '--commit'], {
      encoding: 'utf8', stdio: 'pipe',
    });

    const t = await SELECT.one.from(Tutorials).where({ ID: tutId });
    expect(t.author_ID).toBeNull();

    // Now simulate the runbook's "migrate-users runs first NEXT TIME"
    // by seeding the User and re-running backfill — should match.
    // This is the resumable-after-Users-arrival case.
    const userId = cds.utils.uuid();
    cleanup.users.push(userId);
    await INSERT.into(Users).entries({
      ID: userId, uuid: userId,
      sapId: TEST_PREFIX + 'sap-' + userId.slice(0, 8),
      email,
      displayName: TEST_PREFIX + 'Later',
    });
    execFileSync('node', ['scripts/backfill-tutorial-authors.cjs', '--commit'], {
      encoding: 'utf8', stdio: 'pipe',
    });

    const tAgain = await SELECT.one.from(Tutorials).where({ ID: tutId });
    expect(tAgain.author_ID).toBe(userId);
  }, 90_000);
});
