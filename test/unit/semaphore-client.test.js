// test/unit/semaphore-client.test.js
import { describe, it, expect, vi } from 'vitest';
import {
  buildAllTermsUrl,
  deriveTokenBaseUrl,
  resolveBaseUrl,
  fetchAccessToken,
  fetchAllTerms,
} from '../../srv/lib/semaphore-sync/client.js';

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
    expect(buildAllTermsUrl('https://x/ses', { model: 'M', filter: 'CL=TOPIC' }))
      .toBe('https://x/ses/M/en/allterms.json?FILTER=CL%3DTOPIC');
  });

  it('throws on missing base url or model', () => {
    expect(() => buildAllTermsUrl('', { model: 'M' })).toThrow(/base URL/);
    expect(() => buildAllTermsUrl('https://x', {})).toThrow(/model/);
  });
});

describe('deriveTokenBaseUrl', () => {
  it('reduces an SES path URL to its origin (where /token/ lives)', () => {
    expect(deriveTokenBaseUrl('https://sap.data.progress.cloud/semantic/prodses'))
      .toBe('https://sap.data.progress.cloud');
  });
  it('is idempotent on a bare origin', () => {
    expect(deriveTokenBaseUrl('https://sap.data.progress.cloud')).toBe('https://sap.data.progress.cloud');
  });
});

describe('resolveBaseUrl', () => {
  it('reads dest.url and trims trailing slashes', async () => {
    expect(await resolveBaseUrl({ url: 'https://x/ses/' })).toBe('https://x/ses');
  });
  it('falls back to originalProperties.URL', async () => {
    expect(await resolveBaseUrl({ originalProperties: { URL: 'https://y/ses' } })).toBe('https://y/ses');
  });
  it('throws when the destination is missing or has no URL', async () => {
    await expect(resolveBaseUrl(null)).rejects.toThrow(/not found/);
    await expect(resolveBaseUrl({})).rejects.toThrow(/no URL/);
  });
});

describe('fetchAccessToken (PDC POST /token/)', () => {
  it('POSTs form-encoded key= and returns access_token', async () => {
    const _fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'tok', token_type: 'bearer', expires_in: 180 }),
    });
    const tok = await fetchAccessToken('MY-KEY', {
      tokenBaseUrl: 'https://sap.data.progress.cloud',
      _fetch,
    });
    expect(tok).toBe('tok');
    const [url, init] = _fetch.mock.calls[0];
    expect(url).toBe('https://sap.data.progress.cloud/token/');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    // field name is "key", value URL-encoded
    expect(init.body).toBe('key=MY-KEY');
  });

  it('throws when no API key is provided', async () => {
    await expect(fetchAccessToken('', { tokenBaseUrl: 'https://x' })).rejects.toThrow(/no API key/);
  });

  it('throws on token HTTP error with status + body', async () => {
    const _fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'No key provided.' });
    await expect(fetchAccessToken('k', { tokenBaseUrl: 'https://x', _fetch }))
      .rejects.toThrow(/token HTTP 400: No key provided/);
  });

  it('throws when the token response has no access_token', async () => {
    const _fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ statusCode: 200 }) });
    await expect(fetchAccessToken('k', { tokenBaseUrl: 'https://x', _fetch }))
      .rejects.toThrow(/missing access_token/);
  });
});

describe('fetchAllTerms (full two-step)', () => {
  const dest = { url: 'https://sap.data.progress.cloud/semantic/prodses' };
  const getDestination = () => vi.fn().mockResolvedValue(dest);
  const resolveSecret = () => vi.fn().mockResolvedValue('API-KEY');

  // fetch called twice: [0] token POST, [1] allterms GET.
  function twoStepFetch(allterms) {
    return vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'BEARER' }) })
      .mockResolvedValueOnce(allterms);
  }

  it('exchanges the key for a token then GETs allterms with Bearer', async () => {
    const fetch = twoStepFetch({ ok: true, json: async () => ({ terms: [{ term: { id: '1', name: 'A' } }] }) });
    const data = await fetchAllTerms({
      model: 'SAPCore', filter: 'CL=TOPIC',
      _deps: { fetch, getDestination: getDestination(), resolveSecret: resolveSecret() },
    });

    // token call
    expect(fetch.mock.calls[0][0]).toBe('https://sap.data.progress.cloud/token/');
    // allterms call, with the token from step 1
    const [url, init] = fetch.mock.calls[1];
    expect(url).toBe('https://sap.data.progress.cloud/semantic/prodses/SAPCore/en/allterms.json?FILTER=CL%3DTOPIC');
    expect(init.headers.Authorization).toBe('Bearer BEARER');
    expect(data.terms).toHaveLength(1);
  });

  it('reuses a pre-resolved connection (no token re-fetch)', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ terms: [] }) });
    await fetchAllTerms({
      model: 'M',
      connection: { baseUrl: 'https://x/ses', token: 'PRE' },
      _deps: { fetch },
    });
    // only the allterms GET — no token POST
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer PRE');
  });

  it('throws on allterms HTTP error with status + body snippet', async () => {
    const fetch = twoStepFetch({ ok: false, status: 403, text: async () => 'forbidden' });
    await expect(fetchAllTerms({
      model: 'M', _deps: { fetch, getDestination: getDestination(), resolveSecret: resolveSecret() },
    })).rejects.toThrow(/HTTP 403: forbidden/);
  });

  it('throws when the payload lacks a terms[] array', async () => {
    const fetch = twoStepFetch({ ok: true, json: async () => ({ oops: true }) });
    await expect(fetchAllTerms({
      model: 'M', _deps: { fetch, getDestination: getDestination(), resolveSecret: resolveSecret() },
    })).rejects.toThrow(/missing terms/);
  });

  it('wraps allterms network errors', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 't' }) })
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(fetchAllTerms({
      model: 'M', _deps: { fetch, getDestination: getDestination(), resolveSecret: resolveSecret() },
    })).rejects.toThrow(/allterms fetch failed: ECONNRESET/);
  });
});
