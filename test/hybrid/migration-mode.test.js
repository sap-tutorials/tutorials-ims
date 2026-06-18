import { describe, it, expect, afterAll, vi } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

// Override the hybrid profile's xsuaa auth so basic auth (admin:admin) works
// against the cds.test('serve') HTTP listener. The hybrid profile is only
// needed for the HANA db binding; xsuaa auth is irrelevant for in-process
// tests that exercise the migration-mode handler. Same pattern used by
// scripts/backfill-tutorial-meta.js and other hybrid harness callers.
process.env.cds_requires_auth_kind = 'mocked';

// Raise hookTimeout above the 10s default so `cds.test('serve')` has room to
// boot the full project (28+ CDS files, ngds destination resolve, change-
// tracking plugin) on a cold worktree before vitest aborts the beforeAll hook.
vi.setConfig({ hookTimeout: 60_000 });

const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');

const adminAuth = { auth: { username: 'admin', password: 'admin' } };

const TEST_PREFIX = '__TEST__ migration-mode ';

/**
 * Hybrid coverage for #394: verifies that the migration-mode handler suppresses
 * @cap-js/change-tracking on real HANA when an admin REST request carries
 * `x-migration-mode: true`. This is the only end-to-end pin for the
 * SESSION_CONTEXT('ct.skip') contract — unit tests run on in-memory SQLite,
 * which doesn't fire the HANA change-tracking triggers, and would not catch
 * a regression where the header fails to propagate or the session variable
 * is not set on the actual DB transaction.
 *
 * Target entity: AdminService.ImsConfig.
 *
 * AdminService.Missions (the original target in the plan) has element-level
 * @changelog on title/description/slug/etc., but it is also @odata.draft.enabled
 * AND guarded by a SAVE-time validator that rejects rows without at least one
 * Tag. Driving Missions over plain HTTP from a hybrid test would either need
 * draft-then-activate plumbing or have to bypass the Tag validator — both
 * unrelated to what this test is meant to pin.
 *
 * AdminService.ImsConfig has element-level @changelog on `key` and `value`,
 * is NOT draft-enabled (so a vanilla POST creates the active row directly),
 * and has no extra business validators. That makes it the cleanest end-to-end
 * exerciser of the `db.before(['INSERT', 'UPDATE'])` migration-mode hook.
 *
 * The control test (no header) then proves that change-tracking IS firing on
 * the same HANA table when migration mode is not requested — without that
 * row, "0 changes recorded" by the suppressed test would be a false positive.
 */
describe.runIf(isSafeForWrites())('migration-mode handler — HANA Changes-row suppression (#394)', () => {
  const createdConfigIds = [];

  afterAll(async () => {
    if (!createdConfigIds.length) return;
    const db = await cds.connect.to('db');
    const { ImsConfig } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(ImsConfig).where({ ID: { in: createdConfigIds } }));
  });

  /**
   * Counts Changes rows scoped to the underlying ImsConfig entity so concurrent
   * admin UI activity in DEV doesn't pollute the assertion. The trigger writes
   * the underlying entity FQN (`com.sap.developers.ims.ImsConfig`), not the
   * AdminService projection name.
   */
  async function countConfigChanges() {
    const db = await cds.connect.to('db');
    const { Changes } = cds.entities('sap.changelog');
    const row = await db.run(
      SELECT.one`count(*) as n`.from(Changes).where({ entity: 'com.sap.developers.ims.ImsConfig' })
    );
    return Number(row?.n ?? 0);
  }

  // Use a Number-safe modular timestamp so legacyId fits the Integer column,
  // matching the pattern in test/hybrid/admin-crud.test.js for ImsConfig.
  function nextLegacyId() {
    return Math.floor(Date.now() / 1000) % 1000000 + Math.floor(Math.random() * 1000);
  }

  it('with x-migration-mode header → 0 new Changes rows for an admin INSERT (tracked field set)', async () => {
    const before = await countConfigChanges();

    const payload = {
      key: `${TEST_PREFIX}with-header-${Date.now()}`,
      value: `${TEST_PREFIX}value-with-header`,
      legacyId: nextLegacyId(),
    };

    const { status, data } = await project.post(
      '/admin/ImsConfig',
      payload,
      { ...adminAuth, headers: { 'x-migration-mode': 'true' } }
    );
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);
    expect(data?.ID).toBeTruthy();
    createdConfigIds.push(data.ID);

    const after = await countConfigChanges();
    expect(after - before).toBe(0);
  });

  it('without header → at least one new Changes row for an admin INSERT (control)', async () => {
    const before = await countConfigChanges();

    const payload = {
      key: `${TEST_PREFIX}no-header-${Date.now()}`,
      value: `${TEST_PREFIX}value-no-header`,
      legacyId: nextLegacyId(),
    };

    const { status, data } = await project.post(
      '/admin/ImsConfig',
      payload,
      adminAuth
    );
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);
    expect(data?.ID).toBeTruthy();
    createdConfigIds.push(data.ID);

    const after = await countConfigChanges();
    expect(after).toBeGreaterThan(before);
  });
});
