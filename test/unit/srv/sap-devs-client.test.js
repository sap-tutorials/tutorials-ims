import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sapDevsClient, _resetCache, _setMockTransport } from '../../../srv/lib/sap-devs-client.js';

const FIXTURE = JSON.parse(readFileSync(
  join(import.meta.dirname, '__fixtures__/learning-journey-mcp-search.json'),
  'utf8'
));

describe('sapDevsClient.searchLearningJourneys', () => {
  beforeEach(() => {
    _resetCache();
  });

  it('returns the normalized rows from the MCP response', async () => {
    _setMockTransport({
      call: vi.fn().mockResolvedValue(FIXTURE),
    });
    const rows = await sapDevsClient.searchLearningJourneys({ limit: 3 });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      slug: 'discovering-new-ai-capabilities-for-sap-finance',
      title: expect.stringContaining('SAP Business AI'),
      level: 'BEGINNER',
      duration: '3.00',
      url: expect.stringContaining('learning.sap.com'),
    });
  });

  it('caches the response within TTL (24h for learning journeys)', async () => {
    const callMock = vi.fn().mockResolvedValue(FIXTURE);
    _setMockTransport({ call: callMock });

    await sapDevsClient.searchLearningJourneys({ limit: 3 });
    await sapDevsClient.searchLearningJourneys({ limit: 3 });

    expect(callMock).toHaveBeenCalledTimes(1);
  });

  it('retries up to 3 times on transient errors', async () => {
    const callMock = vi.fn()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(FIXTURE);
    _setMockTransport({ call: callMock });

    const rows = await sapDevsClient.searchLearningJourneys({ limit: 3 });
    expect(rows).toHaveLength(3);
    expect(callMock).toHaveBeenCalledTimes(3);
  });

  it('throws after 3 failed attempts', async () => {
    const callMock = vi.fn().mockRejectedValue(new Error('persistent failure'));
    _setMockTransport({ call: callMock });

    await expect(sapDevsClient.searchLearningJourneys({ limit: 3 }))
      .rejects.toThrow();
    expect(callMock).toHaveBeenCalledTimes(3);
  });

  it('rejects malformed MCP response (schema validation)', async () => {
    _setMockTransport({
      call: vi.fn().mockResolvedValue({ results: 'not-an-array' }),
    });
    await expect(sapDevsClient.searchLearningJourneys({ limit: 3 }))
      .rejects.toThrow();
  });

  it('rejects row missing level', async () => {
    _setMockTransport({
      call: vi.fn().mockResolvedValue({
        results: [
          { slug: 's', title: 't', /* level missing */ duration: '1.00', url: 'https://x' },
        ],
      }),
    });
    _resetCache();
    await expect(sapDevsClient.searchLearningJourneys({ limit: 1 }))
      .rejects.toThrow(/missing level/i);
  });

  it('rejects row missing duration', async () => {
    _setMockTransport({
      call: vi.fn().mockResolvedValue({
        results: [
          { slug: 's', title: 't', level: 'BEGINNER', /* duration missing */ url: 'https://x' },
        ],
      }),
    });
    _resetCache();
    await expect(sapDevsClient.searchLearningJourneys({ limit: 1 }))
      .rejects.toThrow(/missing duration/i);
  });

  it('rejects row missing url', async () => {
    _setMockTransport({
      call: vi.fn().mockResolvedValue({
        results: [
          { slug: 's', title: 't', level: 'BEGINNER', duration: '1.00' /* url missing */ },
        ],
      }),
    });
    _resetCache();
    await expect(sapDevsClient.searchLearningJourneys({ limit: 1 }))
      .rejects.toThrow(/missing url/i);
  });
});

describe('sapDevsClient — other methods (scaffolded)', () => {
  // 4.1 scaffolds these with TODO-throws; 4.2-4.6 implement them.
  // 4.3 (#447) implemented searchDiscovery — removed from scaffold list.
  it.each([
    'getRecentNews',
    'getNewsDetail',
    'searchVideos',
    'getSamples',
    'searchResources',
  ])('%s throws "not implemented in 4.1"', async (methodName) => {
    await expect(sapDevsClient[methodName]())
      .rejects.toThrow(/not implemented/i);
  });
});
