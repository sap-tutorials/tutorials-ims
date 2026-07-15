// test/unit/feature-flags-service.test.js
//
// Integration test for AdminService.FeatureFlags READ handler (#feature-flags).
// Verifies the endpoint returns resolved registry rows with the expected shape.
//
// Modelled on: test/unit/admin-kg-community-coverage-read.test.js
// Auth: username='admin', password='admin' (mocked-auth convention confirmed in
//       test/unit/admin-kg-community-coverage-read.test.js line 18).

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const ADMIN_AUTH = { auth: { username: 'admin', password: 'admin' } };

describe('AdminService.FeatureFlags READ handler (#feature-flags)', () => {
  it('returns registry rows with resolved state', async () => {
    const res = await project.get('/admin/FeatureFlags', {
      ...ADMIN_AUTH,
      validateStatus: () => true,
    });
    expect(res.status).toBe(200);
    const rows = res.data.value;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(10);

    const pr = rows.find((r) => r.key === 'KG_PAGERANK_ENABLED');
    expect(pr).toBeTruthy();
    expect(pr).toHaveProperty('winningLayer');
    expect(pr).toHaveProperty('howToChangeText');
  });

  it('rejects unauthenticated requests', async () => {
    const { status } = await project.get('/admin/FeatureFlags', {
      validateStatus: () => true,
    });
    expect(status).toBe(401);
  });
});
