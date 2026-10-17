import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock resolveSecret
vi.mock('../../srv/lib/secret-resolver.js', () => ({
  resolveSecret: vi.fn(),
}));

import { getAccessToken, _resetTokenCache } from '../../srv/lib/youtube-official-transcript.js';
import { resolveSecret } from '../../srv/lib/secret-resolver.js';

describe('youtube-official-transcript', () => {
  beforeEach(() => {
    _resetTokenCache();
    vi.clearAllMocks();
  });

  describe('getAccessToken', () => {
    it('exchanges refresh token for access token', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ access_token: 'AT', expires_in: 3600 }),
      }));
      const tok = await getAccessToken({
        clientId: 'c',
        clientSecret: 's',
        refreshToken: 'r',
        fetchImpl: fetchMock,
      });
      expect(tok).toBe('AT');

      // Verify the fetch was called with correct URL and body
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://oauth2.googleapis.com/token',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/x-www-form-urlencoded',
          }),
        })
      );

      // Verify the body contains expected parameters
      const body = fetchMock.mock.calls[0][1].body;
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('client_id=c');
      expect(body).toContain('client_secret=s');
      expect(body).toContain('refresh_token=r');
    });

    it('caches token within process (second call does not re-fetch)', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ access_token: 'AT1', expires_in: 3600 }),
      }));

      const tok1 = await getAccessToken({
        clientId: 'c',
        clientSecret: 's',
        refreshToken: 'r',
        fetchImpl: fetchMock,
      });
      expect(tok1).toBe('AT1');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Second call with different credentials should return cached token
      const tok2 = await getAccessToken({
        clientId: 'different_c',
        clientSecret: 'different_s',
        refreshToken: 'different_r',
        fetchImpl: fetchMock,
      });
      expect(tok2).toBe('AT1'); // Same cached token
      expect(fetchMock).toHaveBeenCalledTimes(1); // Still only called once
    });

    it('resolves credentials from credstore when deps absent', async () => {
      resolveSecret.mockResolvedValueOnce('cred_client_id');
      resolveSecret.mockResolvedValueOnce('cred_client_secret');
      resolveSecret.mockResolvedValueOnce('cred_refresh_token');

      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ access_token: 'AT_FROM_STORE', expires_in: 3600 }),
      }));

      const tok = await getAccessToken({
        fetchImpl: fetchMock,
      });
      expect(tok).toBe('AT_FROM_STORE');

      // Verify resolveSecret was called for each credential
      expect(resolveSecret).toHaveBeenCalledWith('YOUTUBE_OAUTH_CLIENT_ID', expect.any(Object));
      expect(resolveSecret).toHaveBeenCalledWith('YOUTUBE_OAUTH_CLIENT_SECRET', expect.any(Object));
      expect(resolveSecret).toHaveBeenCalledWith('YOUTUBE_OAUTH_REFRESH_TOKEN', expect.any(Object));
    });

    it('throws on non-ok token response', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Invalid refresh token',
      }));

      await expect(
        getAccessToken({
          clientId: 'c',
          clientSecret: 's',
          refreshToken: 'r',
          fetchImpl: fetchMock,
        })
      ).rejects.toThrow(/token request failed/i);
    });

    it('uses globalThis.fetch when fetchImpl not provided', async () => {
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ access_token: 'AT_GLOBAL', expires_in: 3600 }),
      }));
      globalThis.fetch = fetchMock;

      try {
        const tok = await getAccessToken({
          clientId: 'c',
          clientSecret: 's',
          refreshToken: 'r',
        });
        expect(tok).toBe('AT_GLOBAL');
        expect(fetchMock).toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('_resetTokenCache', () => {
    it('clears the cached token', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ access_token: 'AT1', expires_in: 3600 }),
      }));

      // First call caches the token
      await getAccessToken({
        clientId: 'c',
        clientSecret: 's',
        refreshToken: 'r',
        fetchImpl: fetchMock,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Reset the cache
      _resetTokenCache();

      // Second call should re-fetch
      const fetchMock2 = vi.fn(async () => ({
        ok: true,
        json: async () => ({ access_token: 'AT2', expires_in: 3600 }),
      }));
      const tok = await getAccessToken({
        clientId: 'c',
        clientSecret: 's',
        refreshToken: 'r',
        fetchImpl: fetchMock2,
      });
      expect(tok).toBe('AT2');
      expect(fetchMock2).toHaveBeenCalledTimes(1);
    });
  });
});
