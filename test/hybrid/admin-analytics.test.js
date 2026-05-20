import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { runAnalyticsQuery } from '../../srv/lib/admin-analytics-runner.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('admin-analytics on real HANA', () => {
  it('never returns user_ID, email, or givenName columns when grouping by taskType', async () => {
    const res = await runAnalyticsQuery({
      plan: { fact: 'completion', groupBy: ['taskType'], measures: ['count', 'distinctUsers'] },
    });
    expect(res).toHaveProperty('rows');
    expect(Array.isArray(res.rows)).toBe(true);
    for (const row of res.rows) {
      const keys = Object.keys(row).map(k => k.toLowerCase());
      expect(keys).not.toContain('user_id');
      expect(keys).not.toContain('email');
      expect(keys).not.toContain('givenname');
      expect(keys).not.toContain('familyname');
      expect(keys).not.toContain('accountnumber');
    }
  });
});
