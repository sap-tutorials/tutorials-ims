import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchSlideshow, photoUrl, probeAuth } from '../lib/server';

afterEach(() => vi.restoreAllMocks());

// Response builders with accurate content-type headers — probeAuth inspects
// the content-type before calling .json() (approuter serves 200 + HTML login
// page to anonymous callers, which must NOT read as signed in).
function jsonResponse(body: unknown, status = 200): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    json: async () => body,
  };
}
function htmlResponse(status = 200): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
  };
}

describe('petoberfest server lib', () => {
  it('photoUrl builds the display + thumb URLs', () => {
    expect(photoUrl('abc', 'display')).toBe('/petoberfest-api/photo/abc?size=display');
    expect(photoUrl('abc', 'thumb')).toBe('/petoberfest-api/photo/abc?size=thumb');
  });

  it('fetchSlideshow unwraps the OData value array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ value: [{ id: '1', petName: 'Rex', uploaderName: 'Tom', uploadedAt: 'x' }] }),
    })) as any);
    const rows = await fetchSlideshow('petoberfest-2026');
    expect(rows).toHaveLength(1);
    expect(rows[0].petName).toBe('Rex');
  });

  describe('probeAuth', () => {
    it('returns true only when the JSON body reports authenticated', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ authenticated: true, id: 'tom' })) as any);
      expect(await probeAuth()).toBe(true);
    });

    it('returns false when JSON body reports not authenticated', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ authenticated: false })) as any);
      expect(await probeAuth()).toBe(false);
    });

    it('returns false on a 401 (direct srv anon response)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ authenticated: false }, 401)) as any);
      expect(await probeAuth()).toBe(false);
    });

    // The core anon bug: approuter answers the XSUAA route with 200 + an HTML
    // login-redirect page for logged-out visitors. A bare `r.ok` check wrongly
    // reports these as signed in and unhides the upload form.
    it('returns false when the approuter serves a 200 HTML login page to anon', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(200)) as any);
      expect(await probeAuth()).toBe(false);
    });

    it('returns false on network error', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }) as any);
      expect(await probeAuth()).toBe(false);
    });
  });
});
