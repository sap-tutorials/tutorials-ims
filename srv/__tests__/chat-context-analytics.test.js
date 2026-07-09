import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../lib/chat-context.js';

describe('chat-context analytics-builder pageContext (Phase 5)', () => {
  it('renders currentSpec + lastResult when tool === analytics-builder', async () => {
    const prompt = await buildSystemPrompt({
      kind: 'admin',
      tool: 'analytics-builder',
      currentSpec: {
        version: 1,
        from: { entity: 'TaskRecords', alias: 'tr' },
        select: [{ kind: 'column', ref: { alias: 'tr', column: 'ID' } }],
        filterTree: null, joins: [], groupBy: [], orderBy: [], limit: 50,
      },
      lastResult: { columns: ['ID'], rowCount: 7, truncated: false },
    }, null);
    expect(prompt).toMatch(/TaskRecords/);
    expect(prompt).toMatch(/7 rows/i);
    expect(prompt).toMatch(/generateAnalyticsQuery|explainAnalyticsResult/);
  });

  it('handles admin pageContext without analytics-builder gracefully', async () => {
    const prompt = await buildSystemPrompt({ kind: 'admin', tool: 'changelog' }, null);
    expect(prompt).toMatch(/admin/i);
    expect(prompt).not.toMatch(/TaskRecords/);
  });

  it('no-op when on a non-admin page', async () => {
    const prompt = await buildSystemPrompt({ kind: 'tutorial', slug: 'x' }, null);
    expect(prompt).not.toMatch(/analytics-builder/i);
  });
});
