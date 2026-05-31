import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const { dispatchTool } = await import('../lib/chat-orchestrator.js');

describe('generateAnalyticsQuery (Phase 5)', () => {
  it('validates LLM-emitted spec and returns sql + preview on success', async () => {
    const user = new cds.User.Privileged();
    const llmSpec = {
      version: 1,
      from: { entity: 'TaskRecords', alias: 'tr' },
      joins: [],
      filterTree: null,
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 'tr', column: 'ID' } }],
      orderBy: [],
      limit: 5,
    };
    const result = await dispatchTool('generateAnalyticsQuery', { spec: llmSpec }, user);
    expect(result.errors).toEqual([]);
    expect(result.spec).toEqual(llmSpec);
    expect(result.sql).toMatch(/SELECT\s+tr\.ID\s+FROM/i);
    expect(Array.isArray(result.preview?.rows)).toBe(true);
  });

  it('returns errors on invalid spec', async () => {
    const user = new cds.User.Privileged();
    const badSpec = {
      version: 1,
      from: { entity: 'NopeEntity', alias: 'n' },
      joins: [],
      filterTree: null,
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 'n', column: 'whatever' } }],
      orderBy: [],
      limit: null,
    };
    const result = await dispatchTool('generateAnalyticsQuery', { spec: badSpec }, user);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.sql).toBeUndefined();
  });

  it('returns errors (not throws) when spec.select[].ref is undefined', async () => {
    const user = new cds.User.Privileged();
    // Real-world malformed spec emitted by the LLM on Joule's first turn —
    // before the fix this threw "Cannot read properties of undefined (reading
    // 'alias')" inside checkColumnRef and crashed the chat stream.
    const malformed = {
      version: 1,
      from: { entity: 'TaskRecords', alias: 'tr' },
      joins: [], filterTree: null, groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: undefined }],
      orderBy: [], limit: null,
    };
    const result = await dispatchTool('generateAnalyticsQuery', { spec: malformed }, user);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toMatch(/ref/i);
    expect(result.sql).toBeUndefined();
  });

  it('returns friendly error when spec missing', async () => {
    const user = new cds.User.Privileged();
    const result = await dispatchTool('generateAnalyticsQuery', {}, user);
    expect(result.error).toMatch(/spec.*required/i);
  });
});

describe('explainAnalyticsResult (Phase 5)', () => {
  it('passes columns + capped rows through and returns the summary', async () => {
    const user = new cds.User.Privileged();
    const result = await dispatchTool('explainAnalyticsResult', {
      columns: ['id', 'count'],
      rows: [['a', 3], ['b', 7]],
      summary: 'Two groups, 10 events total.',
    }, user);
    expect(result.summary).toBe('Two groups, 10 events total.');
    expect(result.columns).toEqual(['id', 'count']);
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it('caps rows to 50 server-side', async () => {
    const user = new cds.User.Privileged();
    const bigRows = Array.from({ length: 200 }, (_, i) => [`row${i}`]);
    const result = await dispatchTool('explainAnalyticsResult', {
      columns: ['id'], rows: bigRows, summary: 'cap me',
    }, user);
    expect(result.rows).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });
});
