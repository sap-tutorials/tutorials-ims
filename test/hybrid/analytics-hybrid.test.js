// test/hybrid/analytics-hybrid.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('analytics hybrid (HANA)', () => {
  it('lists exposed entities against real HANA model', async () => {
    const { data } = await project.get('/admin/analytics/listExposedEntities()', adminAuth);
    expect(data.value.length).toBeGreaterThan(5);
  });

  it('runSelectQuery against CompletionAnalytics under LIMIT', async () => {
    const { data } = await project.post(
      '/admin/analytics/runSelectQuery',
      { sql: 'SELECT * FROM CompletionAnalytics' },
      adminAuth,
    );
    expect(data.metadata.rowCount).toBeLessThanOrEqual(5000);
  });

  it('$apply groupby + aggregate on Tasks view returns rows', async () => {
    const { data } = await project.get(
      '/admin/analytics/Tasks?$apply=groupby((taskType),aggregate(ID with countdistinct as count_id))',
      adminAuth,
    );
    expect(data.value).toBeDefined();
    expect(Array.isArray(data.value)).toBe(true);
  });
});
