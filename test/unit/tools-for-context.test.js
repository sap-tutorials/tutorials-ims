import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { toolsForContext } from '../../srv/lib/chat-orchestrator.js';

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

describe('toolsForContext', () => {
  beforeEach(async () => {
    await cds.deploy(schemaPath).to('sqlite::memory:');
  });

  it('learner pageContext: only searchTutorials', async () => {
    const tools = await toolsForContext({ pageContext: { kind: 'tutorial' }, isAdmin: false });
    const names = tools.map(t => t.function.name);
    expect(names).toEqual(['searchTutorials']);
  });
  it('admin pageContext + admin scope: includes admin docs and analytics', async () => {
    const tools = await toolsForContext({ pageContext: { kind: 'admin' }, isAdmin: true });
    const names = tools.map(t => t.function.name);
    expect(names).toContain('searchAdminDocs');
    expect(names).toContain('analyticsQuery');
  });
  it('forged admin context from learner: admin tools NOT exposed', async () => {
    const tools = await toolsForContext({ pageContext: { kind: 'admin' }, isAdmin: false });
    const names = tools.map(t => t.function.name);
    expect(names).not.toContain('searchAdminDocs');
    expect(names).not.toContain('analyticsQuery');
  });

  it('ragEnabled=true: getRelevantSteps is included in tool list', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ChatSettings);
    await INSERT.into(ChatSettings).entries({
      ID: 'cccccccc-0000-0000-0000-000000000001',
      ragEnabled: true,
      embeddingModel: 'text-embedding-3-small',
      embeddingTopK: 5,
      embeddingMinScore: 0.25
    });
    const tools = await toolsForContext({ pageContext: { kind: 'tutorial' }, isAdmin: false });
    const names = tools.map(t => t.function.name);
    expect(names).toContain('getRelevantSteps');
  });

  it('ragEnabled=false: getRelevantSteps is NOT in tool list', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ChatSettings);
    await INSERT.into(ChatSettings).entries({
      ID: 'cccccccc-0000-0000-0000-000000000001',
      ragEnabled: false,
      embeddingModel: 'text-embedding-3-small',
      embeddingTopK: 5,
      embeddingMinScore: 0.25
    });
    const tools = await toolsForContext({ pageContext: { kind: 'tutorial' }, isAdmin: false });
    const names = tools.map(t => t.function.name);
    expect(names).not.toContain('getRelevantSteps');
  });

  it('no ChatSettings row: getRelevantSteps is NOT in tool list', async () => {
    // No row inserted — ragEnabled defaults to absent/null → tool not exposed
    const tools = await toolsForContext({ pageContext: { kind: 'tutorial' }, isAdmin: false });
    const names = tools.map(t => t.function.name);
    expect(names).not.toContain('getRelevantSteps');
  });
});
