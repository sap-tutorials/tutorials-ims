// test/unit/devtoberfest-config-schema.test.js
// Verifies the DevtoberfestConfig multi-row + isActive invariant
// (spec 2026-06-24). Replaces the previous singleton tests:
//
//   - Multiple rows can coexist (no implicit auto-create on READ)
//   - The `ensureDevtoberfestActiveFlagInvariant` before-handler
//     deactivates the previously-active row when another row is
//     activated, preserving "at most one active" without a DB-level
//     partial index.
//   - isActive defaults to false on a fresh insert.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const ADMIN = { id: 'admin@test', roles: ['Admin'] };

describe('DevtoberfestConfig schema (multi-row + isActive)', () => {
  let DevtoberfestConfig;

  beforeAll(() => {
    ({ DevtoberfestConfig } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(DevtoberfestConfig);
  });

  it('GET /admin/DevtoberfestConfig returns an empty list when no row exists', async () => {
    // No auto-create / bootstrap — admins explicitly create rows via the FE tile.
    const srv = await cds.connect.to('AdminService');
    const result = await srv.tx({ user: ADMIN }, (tx) => tx.read('DevtoberfestConfig'));
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it('Multiple rows coexist', async () => {
    await INSERT.into(DevtoberfestConfig).entries({
      ID: cds.utils.uuid(), isActive: false, termsVersion: 1,
    });
    await INSERT.into(DevtoberfestConfig).entries({
      ID: cds.utils.uuid(), isActive: false, termsVersion: 2,
    });
    const rows = await SELECT.from(DevtoberfestConfig);
    expect(rows.length).toBe(2);
  });

  it('isActive defaults to false on insert without explicit value', async () => {
    const id = cds.utils.uuid();
    await INSERT.into(DevtoberfestConfig).entries({ ID: id, termsVersion: 1 });
    const row = await SELECT.one.from(DevtoberfestConfig).where({ ID: id });
    // Boolean default false is materialised by the CDS layer
    expect(row.isActive).toBeFalsy();
  });

  it('activating a second row through the admin service deactivates the previously-active row', async () => {
    const firstId = cds.utils.uuid();
    const secondId = cds.utils.uuid();
    // Seed the first row as already active.
    await INSERT.into(DevtoberfestConfig).entries({
      ID: firstId, isActive: true, termsVersion: 1,
    });
    // Now insert a second row via the admin service and flip it active.
    // The before-handler should auto-deactivate the first one.
    const srv = await cds.connect.to('AdminService');
    await srv.tx({ user: ADMIN }, (tx) =>
      tx.create('DevtoberfestConfig').entries({
        ID: secondId, isActive: true, termsVersion: 2,
      })
    );
    const first  = await SELECT.one.from(DevtoberfestConfig).where({ ID: firstId });
    const second = await SELECT.one.from(DevtoberfestConfig).where({ ID: secondId });
    expect(first.isActive).toBeFalsy();
    expect(second.isActive).toBeTruthy();
    // Invariant: at most one row active across the table.
    const activeRows = await SELECT.from(DevtoberfestConfig).where({ isActive: true });
    expect(activeRows.length).toBe(1);
  });

  it('UPDATE that sets isActive=false on the active row leaves zero rows active', async () => {
    const id = cds.utils.uuid();
    await INSERT.into(DevtoberfestConfig).entries({
      ID: id, isActive: true, termsVersion: 1,
    });
    const srv = await cds.connect.to('AdminService');
    await srv.tx({ user: ADMIN }, (tx) =>
      tx.update('DevtoberfestConfig').set({ isActive: false }).where({ ID: id })
    );
    const activeRows = await SELECT.from(DevtoberfestConfig).where({ isActive: true });
    expect(activeRows.length).toBe(0);
  });
});
