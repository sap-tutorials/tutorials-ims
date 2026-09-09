// test/unit/semaphore-client.test.js
import { describe, it, expect, vi } from 'vitest';
import { buildAllTermsUrl, deriveAuth, fetchAllTerms } from '../../srv/lib/semaphore-sync/client.js';

describe('buildAllTermsUrl', () => {
  it('builds the canonical allterms path', () => {
    expect(buildAllTermsUrl('https://sap.data.progress.cloud/semantic/prodses', { model: 'SAPCore' }))
      .toBe('https://sap.data.progress.cloud/semantic/prodses/SAPCore/en/allterms.json');
  });

  it('honours lang and trims trailing slashes', () => {
    expect(buildAllTermsUrl('https://x/ses/', { model: 'M', lang: 'de' }))
      .toBe('https://x/ses/M/de/allterms.json');
  });

  it('appends an encoded FILTER clause', () => {
    expect(buildAllTermsUrl('https://x/ses', { model: 'M', filter: 'CL=INDUSTRY_CLUSTER' }))
      .toBe('https://x/ses/M/en/allterms.json?FILTER=CL%3DINDUSTRY_CLUSTER');
  });

  it('throws on missing base url or model', () => {
    expect(() => buildAllTermsUrl('', { model: 'M' })).toThrow(/base URL/);
    expect(() => buildAllTermsUrl('https://x', {})).toThrow(/model/);
  });
});

describe('deriveAuth', () => {
  it('prefers an SDK-resolved auth token', () => {
    expect(deriveAuth({ url: 'https://x/', authTokens: [{ type: 'Bearer', value: 'tok' }] }))
      .toEqual({ baseUrl: 'https://x', authHeader: 'Bearer tok' });
  });

  it('falls back to an explicit token property', () => {
    expect(deriveAuth({ url: 'https://x', originalProperties: { apiToken: 'abc' } }))
      .toEqual({ baseUrl: 'https://x', authHeader: 'Bearer abc' });
  });

  it('falls back to Basic auth', () => {
    const { authHeader } = deriveAuth({ url: 'https://x', username: 'u', password: 'p' });
    expect(authHeader).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('throws when no auth material is present', () => {
    expect(() => deriveAuth({ url: 'https://x' })).toThrow(/no usable auth/);
    expect(() => deriveAuth(null)).toThrow(/not found/);
    expect(() => deriveAuth({})).toThrow(/no URL/);
  });
});

describe('fetchAllTerms', () => {
  const dest = { url: 'https://ses/prodses', authTokens: [{ type: 'Bearer', value: 't' }] };

  it('resolves destination, builds URL, and returns parsed terms', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ terms: [{ term: { id: '1', name: 'A' } }] }),
    });
    const getDestination = vi.fn().mockResolvedValue(dest);
    const data = await fetchAllTerms({ model: 'SAPCore', filter: 'CL=X', _deps: { fetch, getDestination } });

    expect(getDestination).toHaveBeenCalledWith({ destinationName: 'semaphore-destination' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://ses/prodses/SAPCore/en/allterms.json?FILTER=CL%3DX');
    expect(init.headers.Authorization).toBe('Bearer t');
    expect(data.terms).toHaveLength(1);
  });

  it('throws on HTTP error with status + body snippet', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden' });
    const getDestination = vi.fn().mockResolvedValue(dest);
    await expect(fetchAllTerms({ model: 'M', _deps: { fetch, getDestination } }))
      .rejects.toThrow(/HTTP 403: forbidden/);
  });

  it('throws when the payload lacks a terms[] array', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ oops: true }) });
    const getDestination = vi.fn().mockResolvedValue(dest);
    await expect(fetchAllTerms({ model: 'M', _deps: { fetch, getDestination } }))
      .rejects.toThrow(/missing terms/);
  });

  it('wraps network errors', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const getDestination = vi.fn().mockResolvedValue(dest);
    await expect(fetchAllTerms({ model: 'M', _deps: { fetch, getDestination } }))
      .rejects.toThrow(/fetch failed: ECONNRESET/);
  });
});
