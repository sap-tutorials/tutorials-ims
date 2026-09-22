// test/unit/semaphore-rotation.test.js
import { describe, it, expect, vi } from 'vitest';
import { daysUntil, checkAndRotateApiKey } from '../../srv/lib/semaphore-sync/rotation.js';

describe('daysUntil', () => {
  const now = Date.parse('2026-09-22T00:00:00Z');
  it('computes days until an ISO expiry', () => {
    expect(daysUntil('2026-09-29T00:00:00Z', now)).toBeCloseTo(7, 5);
  });
  it('returns Infinity for an unparseable date (never rotate on garbage)', () => {
    expect(daysUntil('not-a-date', now)).toBe(Infinity);
    expect(daysUntil(undefined, now)).toBe(Infinity);
  });
});

describe('checkAndRotateApiKey', () => {
  const base = { tokenBaseUrl: 'https://sap.data.progress.cloud', token: 'BEARER' };

  it('does NOT rotate when the key is comfortably in date', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ apikey: 'K', expiryDate: '2026-12-20T00:00:00Z' }),
    });
    const writeSecret = vi.fn();
    const res = await checkAndRotateApiKey({ ...base, _deps: { fetch, writeSecret } });
    expect(res.rotated).toBe(false);
    expect(res.daysLeft).toBeGreaterThan(7);
    expect(writeSecret).not.toHaveBeenCalled();
    // only the GET happened
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].method).toBe('GET');
  });

  it('rotates + persists + invalidates cache when within the threshold', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ apikey: 'OLD', expiryDate: '2026-09-25T00:00:00Z' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ apikey: 'NEW-KEY', expiryDate: '2027-03-01T00:00:00Z' }) });
    const writeSecret = vi.fn().mockResolvedValue(true);
    const invalidateSecret = vi.fn();

    const res = await checkAndRotateApiKey({
      ...base, thresholdDays: 7, _deps: { fetch, writeSecret, invalidateSecret },
    });

    expect(res.rotated).toBe(true);
    expect(fetch.mock.calls[0][1].method).toBe('GET');
    expect(fetch.mock.calls[1][1].method).toBe('PUT');
    expect(writeSecret).toHaveBeenCalledWith('SEMAPHORE_API_KEY', 'NEW-KEY');
    expect(invalidateSecret).toHaveBeenCalledWith('SEMAPHORE_API_KEY');
  });

  it('fails SOFT: a rotation error is swallowed (never blocks the sync)', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const res = await checkAndRotateApiKey({ ...base, _deps: { fetch, writeSecret: vi.fn() } });
    expect(res.rotated).toBe(false);
    expect(res.error).toMatch(/HTTP 500/);
  });

  it('surfaces a PUT with no new apikey as an error (fail-soft)', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ apikey: 'OLD', expiryDate: '2026-09-23T00:00:00Z' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ nope: true }) });
    const res = await checkAndRotateApiKey({ ...base, _deps: { fetch, writeSecret: vi.fn(), invalidateSecret: vi.fn() } });
    expect(res.rotated).toBe(false);
    expect(res.error).toMatch(/missing apikey/);
  });
});
