import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock resolveSecret
vi.mock('../../srv/lib/secret-resolver.js', () => ({
  resolveSecret: vi.fn(),
}));

import { getAccessToken, _resetTokenCache, getVideoSnippet, isSapDevelopersChannel, listCaptions, pickCaptionTrack, downloadCaption, parseSbv } from '../../srv/lib/youtube-official-transcript.js';
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

  describe('getVideoSnippet', () => {
    it('fetches and returns video snippet with channelId, title, and description', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          items: [
            {
              snippet: {
                channelId: 'UCNfmelKDrvRmjYwSi9yvrMg',
                title: 'Test Video',
                description: 'Test description',
              },
            },
          ],
        }),
      }));

      const result = await getVideoSnippet('test_video_id', {
        apiKey: 'test_api_key',
        fetchImpl: fetchMock,
      });

      expect(result).toEqual({
        channelId: 'UCNfmelKDrvRmjYwSi9yvrMg',
        title: 'Test Video',
        description: 'Test description',
      });

      // Verify the fetch was called with correct URL
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://www.googleapis.com/youtube/v3/videos?part=snippet&id=test_video_id&key=test_api_key'
      );
    });

    it('defaults description to empty string when absent from snippet', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          items: [
            {
              snippet: {
                channelId: 'UCNfmelKDrvRmjYwSi9yvrMg',
                title: 'No Description Video',
              },
            },
          ],
        }),
      }));

      const result = await getVideoSnippet('test_video_id', {
        apiKey: 'test_api_key',
        fetchImpl: fetchMock,
      });

      expect(result).toEqual({
        channelId: 'UCNfmelKDrvRmjYwSi9yvrMg',
        title: 'No Description Video',
        description: '',
      });
    });

    it('returns null when items array is empty', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          items: [],
        }),
      }));

      const result = await getVideoSnippet('invalid_video_id', {
        apiKey: 'test_api_key',
        fetchImpl: fetchMock,
      });

      expect(result).toBeNull();
    });

    it('returns null when items is missing', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({}),
      }));

      const result = await getVideoSnippet('invalid_video_id', {
        apiKey: 'test_api_key',
        fetchImpl: fetchMock,
      });

      expect(result).toBeNull();
    });

    it('resolves apiKey from credstore when deps absent', async () => {
      resolveSecret.mockResolvedValueOnce('credstore_api_key');

      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          items: [
            {
              snippet: {
                channelId: 'UCNfmelKDrvRmjYwSi9yvrMg',
                title: 'From Credstore',
                description: 'desc',
              },
            },
          ],
        }),
      }));

      const result = await getVideoSnippet('test_video_id', {
        fetchImpl: fetchMock,
      });

      expect(result).toEqual({
        channelId: 'UCNfmelKDrvRmjYwSi9yvrMg',
        title: 'From Credstore',
        description: 'desc',
      });

      expect(resolveSecret).toHaveBeenCalledWith('YOUTUBE_API_KEY', expect.any(Object));
    });

    it('uses globalThis.fetch when fetchImpl not provided', async () => {
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          items: [
            {
              snippet: {
                channelId: 'UCNfmelKDrvRmjYwSi9yvrMg',
                title: 'Global Fetch Test',
                description: 'desc',
              },
            },
          ],
        }),
      }));
      globalThis.fetch = fetchMock;

      try {
        const result = await getVideoSnippet('test_video_id', {
          apiKey: 'test_api_key',
        });

        expect(result).toEqual({
          channelId: 'UCNfmelKDrvRmjYwSi9yvrMg',
          title: 'Global Fetch Test',
          description: 'desc',
        });
        expect(fetchMock).toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('isSapDevelopersChannel', () => {
    it('returns true for default SAP Developers channel ID', () => {
      expect(isSapDevelopersChannel('UCNfmelKDrvRmjYwSi9yvrMg')).toBe(true);
    });

    it('returns true for custom SAP_DEV_CHANNEL_ID from environment', () => {
      const originalEnv = process.env.SAP_DEV_CHANNEL_ID;
      process.env.SAP_DEV_CHANNEL_ID = 'UCcustom123';

      try {
        expect(isSapDevelopersChannel('UCcustom123')).toBe(true);
      } finally {
        process.env.SAP_DEV_CHANNEL_ID = originalEnv;
      }
    });

    it('returns false for different channel IDs', () => {
      expect(isSapDevelopersChannel('UC9999999999')).toBe(false);
      expect(isSapDevelopersChannel('UCsomethingelse')).toBe(false);
    });

    it('returns false for null or undefined', () => {
      expect(isSapDevelopersChannel(null)).toBe(false);
      expect(isSapDevelopersChannel(undefined)).toBe(false);
    });
  });

  describe('listCaptions', () => {
    it('fetches captions list and maps to {id, language, trackKind}', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          items: [
            { id: 'cap1', snippet: { language: 'en', trackKind: 'standard' } },
            { id: 'cap2', snippet: { language: 'de', trackKind: 'ASR' } },
          ],
        }),
      }));

      const result = await listCaptions('vid123', 'tok123', { fetchImpl: fetchMock });

      expect(result).toEqual([
        { id: 'cap1', language: 'en', trackKind: 'standard' },
        { id: 'cap2', language: 'de', trackKind: 'ASR' },
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=vid123',
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: 'Bearer tok123',
          }),
        })
      );
    });

    it('returns [] when no captions found', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({ items: [] }),
      }));

      const result = await listCaptions('vid123', 'tok123', { fetchImpl: fetchMock });

      expect(result).toEqual([]);
    });

    it('throws on non-ok response', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'No access',
      }));

      await expect(
        listCaptions('vid123', 'tok123', { fetchImpl: fetchMock })
      ).rejects.toThrow(/captions.*failed/i);
    });
  });

  describe('pickCaptionTrack', () => {
    it('prefers en across kinds (und-standard + en-asr)', () => {
      const tracks = [
        { language: 'und', trackKind: 'standard', id: 'u' },
        { language: 'en', trackKind: 'ASR', id: 'e' },
      ];
      expect(pickCaptionTrack(tracks).id).toBe('e');
    });

    it('returns track with language === en', () => {
      const tracks = [
        { language: 'de', trackKind: 'standard', id: 'd' },
        { language: 'en', trackKind: 'standard', id: 'e' },
      ];
      expect(pickCaptionTrack(tracks).id).toBe('e');
    });

    it('falls back to language startsWith en-', () => {
      const tracks = [
        { language: 'de', trackKind: 'standard', id: 'd' },
        { language: 'en-US', trackKind: 'standard', id: 'us' },
      ];
      expect(pickCaptionTrack(tracks).id).toBe('us');
    });

    it('returns first track when no en or en-* found', () => {
      const tracks = [
        { language: 'fr', trackKind: 'standard', id: 'f' },
        { language: 'de', trackKind: 'standard', id: 'd' },
      ];
      expect(pickCaptionTrack(tracks).id).toBe('f');
    });

    it('returns null for empty tracks', () => {
      expect(pickCaptionTrack([])).toBeNull();
    });
  });

  describe('downloadCaption', () => {
    it('downloads caption in SBV format', async () => {
      const sbvText = '0:00:01.680,0:00:05.440\nHello there\n\n0:00:05.440,0:00:09.599\nwelcome';
      const fetchMock = vi.fn(async () => ({
        ok: true,
        text: async () => sbvText,
      }));

      const result = await downloadCaption('cap123', 'tok123', { fetchImpl: fetchMock });

      expect(result).toBe(sbvText);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://www.googleapis.com/youtube/v3/captions/cap123?tfmt=sbv',
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: 'Bearer tok123',
          }),
        })
      );
    });

    it('throws on non-ok response', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => 'Not allowed',
      }));

      await expect(
        downloadCaption('cap123', 'tok123', { fetchImpl: fetchMock })
      ).rejects.toThrow(/caption.*failed/i);
    });
  });

  describe('parseSbv', () => {
    it('strips timestamps and keeps text', () => {
      const sbv = '0:00:01.680,0:00:05.440\nHello there\n\n0:00:05.440,0:00:09.599\nwelcome';
      expect(parseSbv(sbv)).toEqual([
        { start: 1.68, text: 'Hello there' },
        { start: 5.44, text: 'welcome' },
      ]);
    });

    it('handles multi-line text in a block', () => {
      const sbv = '0:00:01.000,0:00:05.000\nLine 1\nLine 2\n\n0:00:05.000,0:00:10.000\nLine 3';
      expect(parseSbv(sbv)).toEqual([
        { start: 1.0, text: 'Line 1 Line 2' },
        { start: 5.0, text: 'Line 3' },
      ]);
    });

    it('returns [] on empty input', () => {
      expect(parseSbv('')).toEqual([]);
    });

    it('returns [] on input with no timestamp lines', () => {
      expect(parseSbv('just some text\nwithout timestamps')).toEqual([]);
    });

    it('handles timestamps with hours', () => {
      const sbv = '1:23:45.678,1:23:50.100\nTest';
      expect(parseSbv(sbv)).toEqual([{ start: 5025.678, text: 'Test' }]);
    });

    it('handles edge case: single block no trailing blank', () => {
      const sbv = '0:00:02.500,0:00:06.000\nOnly block';
      expect(parseSbv(sbv)).toEqual([{ start: 2.5, text: 'Only block' }]);
    });
  });
});
