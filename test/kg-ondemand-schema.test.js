import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('KgOnDemandRequests schema (#948)', () => {
  beforeAll(async () => {
    await cds.deploy(cds.env.roots).to('sqlite::memory:');
  });

  it('registers KgOnDemandRequests with the expected columns', () => {
    const { KgOnDemandRequests } = cds.entities('com.sap.developers.ims');
    expect(KgOnDemandRequests).toBeDefined();
    const cols = Object.keys(KgOnDemandRequests.elements);
    for (const name of [
      'ID', 'query', 'normalizedKey', 'requestedBy', 'requestedByKind',
      'status', 'attempts', 'requestedAt', 'startedAt', 'completedAt',
      'latencyMs', 'tutorialsExtracted', 'conceptsCreated', 'conceptsMerged',
      'lastError', 'llmPromptTokens', 'llmCompletionTokens',
    ]) {
      expect(cols, `missing column: ${name}`).toContain(name);
    }
  });

  it('defaults status to PENDING', async () => {
    const db = await cds.connect.to('db');
    const { KgOnDemandRequests } = cds.entities('com.sap.developers.ims');
    await INSERT.into(KgOnDemandRequests).entries({
      ID: '11111111-1111-1111-1111-111111111111',
      query: 'test',
      normalizedKey: 'test',
    });
    const [row] = await SELECT.from(KgOnDemandRequests)
      .columns('status', 'attempts', 'tutorialsExtracted')
      .where({ ID: '11111111-1111-1111-1111-111111111111' });
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(0);
    expect(row.tutorialsExtracted).toBe(0);
  });

  it('exposes onDemandExtractionEnabled on KnowledgeGraphSettings, default false', async () => {
    const db = await cds.connect.to('db');
    const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(KnowledgeGraphSettings).entries({});
    const [row] = await SELECT.from(KnowledgeGraphSettings)
      .columns('onDemandExtractionEnabled');
    expect(row.onDemandExtractionEnabled === false || row.onDemandExtractionEnabled === 0).toBe(true);
  });
});
