// test/unit/admin-url-health-action.test.js
//
// Regression for #2787: AdminService.runUrlHealthScan() returns { ok, broken, message }.
//
// Auth/connection harness copied from test/admin-service-health.test.js:
//   cds.test('serve','--project','.','--in-memory') + admin.tx(adminCtx, ...).
//
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const adminCtx = { user: { id: 'admin', roles: ['Admin', 'authenticated-user'] } };

describe('AdminService.runUrlHealthScan (#2787)', () => {
  it('is callable by an Admin and returns the expected response shape', async () => {
    const admin = await cds.connect.to('AdminService');
    const res = await admin.tx(adminCtx, tx => tx.send('runUrlHealthScan'));

    // Shape: { ok: Boolean, broken: Integer, message: String }
    expect(res).toBeDefined();
    expect(typeof res.ok).toBe('boolean');
    expect(typeof res.broken).toBe('number');
    expect(typeof res.message).toBe('string');
    expect(res.message.length).toBeGreaterThan(0);
  });
});
