// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchSlideshow, photoUrl, probeAuth, uploadPet } from '../lib/server';

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));
vi.mock('@shared/csrf-fetch', () => ({ csrfFetch: csrfFetchMock }));

afterEach(() => { vi.restoreAllMocks(); csrfFetchMock.mockReset(); });

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

describe('uploadPet — JSON base64 transport', () => {
  it('sends a JSON body with base64-encoded photo (no multipart FormData)', async () => {
    csrfFetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ id: 'x1', awarded: true, moderation: 'PENDING' }),
    });
    const file = new File([new Uint8Array([1, 2, 3])], 'pet.png', { type: 'image/png' });

    const res = await uploadPet('petoberfest-2026', file, 'Rex');

    expect(res).toEqual({ id: 'x1', awarded: true, moderation: 'PENDING' });
    expect(csrfFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = csrfFetchMock.mock.calls[0];
    expect(url).toBe('/petoberfest-api/petoberfest-2026/upload');
    expect(init.method).toBe('POST');
    // JSON transport — NOT multipart FormData (the thing Akamai stalls).
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(init.body).toBeTypeOf('string');
    const body = JSON.parse(init.body as string);
    expect(body.petName).toBe('Rex');
    expect(body.mimeType).toBe('image/png');
    expect(body.filename).toBe('pet.png');
    expect(body.photoBase64).toBe('AQID'); // base64 of bytes [1,2,3]
  });

  it('surfaces the HTTP status and Akamai reference when the edge returns a non-JSON error', async () => {
    csrfFetchMock.mockResolvedValue({
      ok: false, status: 411,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
      text: async () => '<HTML><HEAD>Length Required</HEAD>Reference&#32;#1.abc12345</HTML>',
    });
    const file = new File([new Uint8Array([1])], 'pet.png', { type: 'image/png' });

    await expect(uploadPet('petoberfest-2026', file, 'Rex')).rejects.toMatchObject({
      status: 411,
    });
    // Re-run to inspect the message (rejects.toMatchObject can't read .message reliably).
    csrfFetchMock.mockResolvedValue({
      ok: false, status: 411,
      json: async () => { throw new SyntaxError('bad'); },
      text: async () => '<HTML>Reference&#32;#1.abc12345</HTML>',
    });
    const err = await uploadPet('petoberfest-2026', file, 'Rex').catch((e) => e);
    expect(err.message).toContain('411');
    expect(err.message).toContain('1.abc12345');
  });

  it('translates an aborted/timed-out request into a clear message', async () => {
    csrfFetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const file = new File([new Uint8Array([1])], 'pet.png', { type: 'image/png' });

    const err = await uploadPet('petoberfest-2026', file, 'Rex').catch((e) => e);
    expect(err.message).toMatch(/timed out/i);
  });
});
