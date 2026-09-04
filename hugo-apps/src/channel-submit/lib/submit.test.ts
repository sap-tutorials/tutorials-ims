import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@shared/csrf-fetch', () => ({
  csrfFetch: vi.fn(),
  CsrfFetchError: class extends Error {},
}));
import { csrfFetch } from '@shared/csrf-fetch';
import { probeAuth, submitChannelProposal } from './submit';

beforeEach(() => vi.resetAllMocks());

describe('probeAuth', () => {
  test('true only when JSON body.authenticated is truthy', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ authenticated: true }),
    }) as unknown as typeof fetch;
    expect(await probeAuth()).toBe(true);
  });

  test('false for a 200 HTML login page (anon)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/html' },
      json: async () => { throw new Error('not json'); },
    }) as unknown as typeof fetch;
    expect(await probeAuth()).toBe(false);
  });
});

describe('submitChannelProposal', () => {
  test('POSTs the payload to the submissions route via csrfFetch', async () => {
    (csrfFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 201 });
    await submitChannelProposal({ kind: 'ADD', proposed: '{"name":"X","url":"https://x"}', rationale: 'add it' });
    expect(csrfFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (csrfFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/channel-submissions/Submissions');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toMatchObject({ kind: 'ADD', rationale: 'add it' });
  });

  test('throws on a non-2xx response', async () => {
    (csrfFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 401 });
    await expect(submitChannelProposal({ kind: 'REMOVE', targetChannel_ID: 'c1', proposed: '', rationale: '' }))
      .rejects.toThrow();
  });
});
