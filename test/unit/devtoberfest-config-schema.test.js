// test/unit/devtoberfest-config-schema.test.js
// Verifies the DevtoberfestConfig singleton invariant:
//   - First READ auto-creates the row (defensive init)
//   - Default termsVersion = 1 on a fresh row
//   - Subsequent READs reuse the same row (no duplicate)

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const ADMIN = { id: 'admin@test', roles: ['Admin'] };

describe('DevtoberfestConfig singleton', () => {
  let DevtoberfestConfig;

  beforeAll(() => {
    ({ DevtoberfestConfig } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(DevtoberfestConfig);
  });

  it('GET /admin/DevtoberfestConfig auto-creates the singleton on first read', async () => {
    const srv = await cds.connect.to('AdminService');
    const rowBefore = await SELECT.one.from(DevtoberfestConfig);
    expect(rowBefore).toBeFalsy();

    const result = await srv.tx({ user: ADMIN }, (tx) => tx.read('DevtoberfestConfig'));
    expect(result).toBeTruthy();
    const rowAfter = await SELECT.one.from(DevtoberfestConfig);
    expect(rowAfter).toBeTruthy();
    expect(rowAfter.termsVersion).toBe(1);
  });

  it('subsequent reads reuse the same row', async () => {
    const srv = await cds.connect.to('AdminService');
    await srv.tx({ user: ADMIN }, (tx) => tx.read('DevtoberfestConfig'));
    await srv.tx({ user: ADMIN }, (tx) => tx.read('DevtoberfestConfig'));
    const rows = await SELECT.from(DevtoberfestConfig);
    expect(rows.length).toBe(1);
  });
});
