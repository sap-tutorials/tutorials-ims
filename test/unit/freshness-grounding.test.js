// test/unit/freshness-grounding.test.js
// Task 4: Grounding helper unit test — SQLite Float32 BLOB path.
// Verifies that groundCodeBlock() embeds the code, cosine-searches ApiDocs
// rows, and returns results above minScore sorted by score desc.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import cds from '@sap/cds';
import { embed } from '../../srv/lib/embedding-client.js';

vi.mock('../../srv/lib/embedding-client.js', () => ({
  embed: vi.fn(async () => [new Float32Array(1536).fill(0.5)]),
}));

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('groundCodeBlock', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('returns nearest ApiDocs chunks above minScore', async () => {
    const { ApiDocs } = cds.entities('com.sap.developers.ims.external');
    const vec = new Float32Array(1536).fill(0.5);
    const blob = Buffer.from(vec.buffer);
    await INSERT.into(ApiDocs).entries({ ID: cds.utils.uuid(), slug: 'fetch-api', title: 'Fetch API', url: 'https://x', embedding: blob });
    const { groundCodeBlock } = await import('../../srv/lib/freshness-grounding.js');
    embed.mockClear();
    const hits = await groundCodeBlock({ db, code: 'require("node-fetch")', limit: 3 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]).toMatchObject({ source: 'apidoc', title: 'Fetch API' });
    expect(hits[0].score).toBeGreaterThan(0.9);
    // Regression: embed() must receive a resolved model string as its 2nd arg —
    // undefined constructs AzureOpenAiEmbeddingClient(undefined) and throws.
    expect(typeof embed.mock.calls[0][1]).toBe('string');
    expect(embed.mock.calls[0][1].length).toBeGreaterThan(0);
  });
});
