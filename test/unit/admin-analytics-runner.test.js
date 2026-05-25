import { describe, it, expect, vi } from 'vitest';
import { runAnalyticsQuery, _validatePlanOnly } from '../../srv/lib/admin-analytics-runner.js';

describe('admin-analytics-runner — validation', () => {
  it('rejects unknown fact', () => {
    expect(() => _validatePlanOnly({ fact: 'orders', groupBy: [], measures: ['count'] }))
      .toThrow(/unknown_field|unknown fact/i);
  });
  it('rejects unknown dimension', () => {
    expect(() => _validatePlanOnly({ fact: 'completion', groupBy: ['userId'], measures: ['count'] }))
      .toThrow(/unknown_field|unknown dimension/i);
  });
  it('rejects PII field in groupBy', () => {
    expect(() => _validatePlanOnly({ fact: 'completion', groupBy: ['user_ID'], measures: ['count'] }))
      .toThrow(/pii_denied/i);
  });
  it('rejects PII field in filters', () => {
    expect(() => _validatePlanOnly({ fact: 'completion', groupBy: [], measures: ['count'], filters: [{ field: 'email', op: 'equals', value: 'x@y.z' }] }))
      .toThrow(/pii_denied/i);
  });
  it('rejects sinceDays out of range', () => {
    expect(() => _validatePlanOnly({ fact: 'completion', groupBy: [], measures: ['count'], filters: [{ field: 'completionMonth', op: 'sinceDays', value: 99999 }] }))
      .toThrow(/invalid_value/i);
  });
  it('caps limit silently to MAX_LIMIT', () => {
    const v = _validatePlanOnly({ fact: 'completion', groupBy: ['taskType'], measures: ['count'], limit: 9999 });
    expect(v.limit).toBeLessThanOrEqual(100);
  });
});

describe('admin-analytics-runner — k-anon', () => {
  it('grouped: suppresses rows where distinctUsers < 5', async () => {
    const fakeRows = [
      { taskType: 'TUTORIAL', count: 100, distinctUsers: 12 },
      { taskType: 'MISSION',  count: 4,   distinctUsers: 2  },
      { taskType: 'GROUP',    count: 8,   distinctUsers: 7  },
    ];
    const fakeDb = { run: vi.fn().mockResolvedValue(fakeRows) };
    const result = await runAnalyticsQuery({
      plan: { fact: 'completion', groupBy: ['taskType'], measures: ['count','distinctUsers'] },
      db: fakeDb, user: { id: 'tom@example.com' },
    });
    expect(result.rows).toHaveLength(2);
    expect(result.suppressedCount).toBe(1);
    expect(result.rows.find(r => r.taskType === 'MISSION')).toBeUndefined();
  });
  it('ungrouped: returns empty rows when single aggregate distinctUsers < 5', async () => {
    const fakeDb = { run: vi.fn().mockResolvedValue([{ count: 4, distinctUsers: 3 }]) };
    const result = await runAnalyticsQuery({
      plan: { fact: 'completion', groupBy: [], measures: ['count'] },
      db: fakeDb, user: { id: 't' },
    });
    expect(result.rows).toEqual([]);
    expect(result.suppressedCount).toBe(1);
    expect(result.totalRows).toBe(1);
  });
  it('strips distinctUsers from rows when not requested', async () => {
    const fakeDb = { run: vi.fn().mockResolvedValue([{ taskType: 'TUTORIAL', count: 100, distinctUsers: 12 }]) };
    const result = await runAnalyticsQuery({
      plan: { fact: 'completion', groupBy: ['taskType'], measures: ['count'] },
      db: fakeDb, user: { id: 't' },
    });
    expect(result.rows[0]).not.toHaveProperty('distinctUsers');
  });
});

describe('admin-analytics-runner — audit', () => {
  it('logs sha256(user.id) not raw user.id, and never logs filter values', async () => {
    const entries = [];
    const fakeLog = { info: (msg, payload) => entries.push({ msg, payload }) };
    const fakeDb = { run: vi.fn().mockResolvedValue([{ taskType: 'X', count: 50, distinctUsers: 10 }]) };
    await runAnalyticsQuery({
      plan: { fact: 'completion', groupBy: ['taskType'], measures: ['count'], filters: [{ field: 'taskType', op: 'equals', value: 'TUTORIAL' }] },
      db: fakeDb, user: { id: 'tom@example.com' }, log: fakeLog,
    });
    const e = entries[0];
    expect(JSON.stringify(e)).not.toContain('tom@example.com');
    expect(JSON.stringify(e)).not.toContain('TUTORIAL');
    expect(e.payload.userHash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.payload.totalRows).toBe(1);
  });
});

describe('admin-analytics-runner — I-1: tag fanout filter rejection', () => {
  it('rejects a plan with tag in groupBy and non-empty filters', () => {
    expect(() => _validatePlanOnly({
      fact: 'completion',
      groupBy: ['tag'],
      measures: ['count'],
      filters: [{ field: 'completionMonth', op: 'sinceDays', value: 30 }],
    })).toThrow(/unknown_field|tag dimension does not support filters/i);
  });
  it('accepts a plan with tag in groupBy and no filters', () => {
    expect(() => _validatePlanOnly({
      fact: 'completion',
      groupBy: ['tag'],
      measures: ['count'],
      filters: [],
    })).not.toThrow();
  });
});

describe('admin-analytics-runner — I-2: task-lookup CQN column ref shape', () => {
  it('produces multi-segment ref for mission groupBy', async () => {
    const capturedCqn = [];
    const fakeDb = {
      run: vi.fn(cqn => { capturedCqn.push(cqn); return Promise.resolve([]); }),
    };
    await runAnalyticsQuery({
      plan: { fact: 'completion', groupBy: ['mission'], measures: ['count'] },
      db: fakeDb, user: { id: 't' },
    });
    const col = capturedCqn[0].SELECT.columns.find(c => c.as === 'mission');
    expect(col.ref).toEqual(['mission', 'slug']);
  });
});

describe('admin-analytics-runner — I-3: assoc equals filter uses full path', () => {
  it('builds CQN where clause with multi-segment ref for assoc equals filter', async () => {
    const capturedCqn = [];
    const fakeDb = {
      run: vi.fn(cqn => { capturedCqn.push(cqn); return Promise.resolve([]); }),
    };
    await runAnalyticsQuery({
      plan: { fact: 'completion', groupBy: ['taskType'], measures: ['count'], filters: [{ field: 'event', op: 'equals', value: 'TechEd' }] },
      db: fakeDb, user: { id: 't' },
    });
    const where = capturedCqn[0].SELECT.where;
    // The first ref in where is the baseFilter (status='COMPLETED'); find the one with a multi-segment ref.
    const refNode = where.filter(n => n && typeof n === 'object' && Array.isArray(n.ref))
      .find(n => n.ref.length > 1);
    expect(refNode.ref).toEqual(['event', 'name']);
  });
});

describe('admin-analytics-runner — I-4: task-lookup discriminator filter', () => {
  it('adds taskType=TUTORIAL to where clause when groupBy=["tutorial"]', async () => {
    const capturedCqn = [];
    const fakeDb = {
      run: vi.fn(cqn => { capturedCqn.push(cqn); return Promise.resolve([]); }),
    };
    await runAnalyticsQuery({
      plan: { fact: 'completion', groupBy: ['tutorial'], measures: ['count'] },
      db: fakeDb, user: { id: 't' },
    });
    const where = capturedCqn[0].SELECT.where;
    const idx = where.findIndex(n => n && typeof n === 'object' && Array.isArray(n.ref) && n.ref[0] === 'taskType' && n.ref.length === 1);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(where[idx + 1]).toBe('=');
    expect(where[idx + 2]).toEqual({ val: 'TUTORIAL' });
  });
  it('adds taskType=GROUP when filtering by group dimension (no group in groupBy)', async () => {
    const capturedCqn = [];
    const fakeDb = {
      run: vi.fn(cqn => { capturedCqn.push(cqn); return Promise.resolve([]); }),
    };
    await runAnalyticsQuery({
      plan: { fact: 'completion', groupBy: ['taskType'], measures: ['count'], filters: [{ field: 'group', op: 'equals', value: 'Some Group' }] },
      db: fakeDb, user: { id: 't' },
    });
    const where = capturedCqn[0].SELECT.where;
    const idx = where.findIndex(n => n && typeof n === 'object' && Array.isArray(n.ref) && n.ref[0] === 'taskType' && n.ref.length === 1);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(where[idx + 2]).toEqual({ val: 'GROUP' });
  });
  it('omits discriminator when no task-lookup dim is referenced', async () => {
    const capturedCqn = [];
    const fakeDb = {
      run: vi.fn(cqn => { capturedCqn.push(cqn); return Promise.resolve([]); }),
    };
    await runAnalyticsQuery({
      plan: { fact: 'completion', groupBy: ['taskType'], measures: ['count'] },
      db: fakeDb, user: { id: 't' },
    });
    const where = capturedCqn[0].SELECT.where;
    const taskTypeRefs = where.filter(n => n && typeof n === 'object' && Array.isArray(n.ref) && n.ref[0] === 'taskType' && n.ref.length === 1);
    expect(taskTypeRefs).toHaveLength(0);
  });
});
