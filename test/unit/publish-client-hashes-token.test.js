import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchRemoteHashes } from '../../scripts/lib/publish-client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchRemoteHashes — returns { hashes, pipelineToken } in one GET', () => {
  it('returns both the hash map and the X-Pipeline-Token from a single fetch call', async () => {
    const hashBody = { 'tutorial-foo': 'abc123', 'tutorial-bar': 'def456' };
    const token = 'tok-xyz-9999';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name) => name.toLowerCase() === 'x-pipeline-token' ? token : null,
      },
      json: async () => hashBody,
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchRemoteHashes({ baseUrl: 'http://localhost:4004', apiKey: 'key1' });

    // One call only — no second GET for the token
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.hashes).toEqual(hashBody);
    expect(result.pipelineToken).toBe(token);
  });

  it('returns { hashes: {}, pipelineToken: null } on a 503 response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: {
        get: () => null,
      },
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchRemoteHashes({ baseUrl: 'http://localhost:4004' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.hashes).toEqual({});
    expect(result.pipelineToken).toBeNull();
  });

  it('returns null pipelineToken when the header is absent', async () => {
    const hashBody = { 'tutorial-baz': 'aaa111' };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: () => null,
      },
      json: async () => hashBody,
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchRemoteHashes({ baseUrl: 'http://localhost:4004' });

    expect(result.hashes).toEqual(hashBody);
    expect(result.pipelineToken).toBeNull();
  });
});
