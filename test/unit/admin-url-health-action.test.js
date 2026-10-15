// test/unit/admin-url-health-action.test.js
//
// Regression for #2787: AdminService.runUrlHealthScan() returns { ok, broken, message }.
//
// Auth/connection harness copied from test/admin-service-health.test.js:
//   cds.test('serve','--project','.','--in-memory') + admin.tx(adminCtx, ...).
//
// Mock strategy: vi.mock cannot intercept CDS-runtime-loaded modules (dynamic
// import inside admin-service.js). Uses the established globalThis.__TEST_*
// hook pattern (see admin-service.js lines ~3556, ~3694, ~3735) to inject a
// fake runJobByName without touching the CDS loader.
//
import { describe, it, expect, afterEach } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const adminCtx = { user: { id: 'admin', roles: ['Admin', 'authenticated-user'] } };

afterEach(() => {
  delete globalThis.__TEST_runJobByName;
});

describe('AdminService.runUrlHealthScan (#2787)', () => {
  it('is callable by an Admin and returns ok:true on a clean run', async () => {
    // Stub: outcome='success', result has broken=2 (non-zero but still clean outcome)
    globalThis.__TEST_runJobByName = async () => ({
      skipped: false,
      outcome: 'success',
      result: { ok: 5, slow: 0, broken: 2, skipped: 0 },
      errorMessage: null,
    });

    const admin = await cds.connect.to('AdminService');
    const res = await admin.tx(adminCtx, tx => tx.send('runUrlHealthScan'));

    expect(res).toBeDefined();
    expect(res.ok).toBe(true);
    expect(res.broken).toBe(2);
    expect(typeof res.message).toBe('string');
    expect(res.message).toContain('2 broken');
  });

  it('returns ok:false when the job reports outcome:error', async () => {
    // Stub: outcome='error' with a soft-fail result — must yield ok:false.
    // This case would have been ok:true under the old `outcome !== 'FAILED'` bug.
    globalThis.__TEST_runJobByName = async () => ({
      skipped: false,
      outcome: 'error',
      result: { ok: false, error: 'boom' },
      errorMessage: 'boom',
    });

    const admin = await cds.connect.to('AdminService');
    const res = await admin.tx(adminCtx, tx => tx.send('runUrlHealthScan'));

    expect(res).toBeDefined();
    expect(res.ok).toBe(false);
    expect(typeof res.broken).toBe('number');
    expect(typeof res.message).toBe('string');
  });
});
