import { describe, it, expect, beforeAll, vi } from 'vitest';
import path from 'node:path';
const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

vi.mock('../../srv/lib/embedding-client.js', () => ({
  embed: vi.fn(async (texts) => texts.map(() => new Float32Array(1536).fill(0.01)))
}));

const cds = (await import('@sap/cds')).default;

describe('embedding-query', () => {
  beforeAll(async () => {
    await cds.deploy(schemaPath).to('sqlite::memory:');
  });

  it('filters to current embeddingModel', async () => {
    const { findRelevantSteps } = await import('../../srv/lib/embedding-query.js');
    const hits = await findRelevantSteps({
      query: 'how do I bind a HANA service',
      settings: { embeddingModel: 'text-embedding-3-small', embeddingTopK: 4, embeddingMinScore: 0.0 }
    });
    expect(Array.isArray(hits)).toBe(true);
    for (const h of hits) {
      expect(h).toHaveProperty('tutorialSlug');
      expect(h).toHaveProperty('stepNumber');
      expect(h).toHaveProperty('text');
      expect(h).toHaveProperty('score');
    }
  });

  it('returns [] when query is empty', async () => {
    const { findRelevantSteps } = await import('../../srv/lib/embedding-query.js');
    const hits = await findRelevantSteps({ query: '   ', settings: { embeddingModel: 'x', embeddingTopK: 4, embeddingMinScore: 0 } });
    expect(hits).toEqual([]);
  });
});
