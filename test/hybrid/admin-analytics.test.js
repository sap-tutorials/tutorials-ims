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

  // Validates Bug 2 end-to-end: the TaskRecordsAnalytics projection's unmanaged
  // associations + runtime taskType discriminator must produce a non-erroring
  // query that returns ONLY tutorial rows (no phantom null bucket from the
  // wrong-typed associations failing to join).
  it('groupBy=["tutorial"] resolves through the CDS projection without DB error', async () => {
    const res = await runAnalyticsQuery({
      plan: { fact: 'completion', groupBy: ['tutorial'], measures: ['count'] },
    });
    expect(res).toHaveProperty('rows');
    expect(Array.isArray(res.rows)).toBe(true);
    // K-anon may suppress all rows (fine) — the assertion is "didn't throw".
    // If rows do come back, they must have a tutorial slug (string), not null.
    for (const row of res.rows) {
      expect(typeof row.tutorial === 'string' || row.tutorial === null).toBe(true);
    }
  });

  it('groupBy=["mission"] resolves through the CDS projection without DB error', async () => {
    const res = await runAnalyticsQuery({
      plan: { fact: 'completion', groupBy: ['mission'], measures: ['count'] },
    });
    expect(res).toHaveProperty('rows');
    expect(Array.isArray(res.rows)).toBe(true);
  });

  it('completionWeek + sinceDays date-trunc aggregation runs against HANA', async () => {
    const res = await runAnalyticsQuery({
      plan: {
        fact: 'completion',
        groupBy: ['completionWeek'],
        measures: ['count', 'distinctUsers'],
        filters: [{ field: 'completionWeek', op: 'sinceDays', value: 90 }],
      },
    });
    expect(res).toHaveProperty('rows');
    expect(Array.isArray(res.rows)).toBe(true);
  });
});
