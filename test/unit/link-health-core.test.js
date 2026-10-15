import { describe, it, expect, vi, afterEach } from 'vitest';
import { runHealthCheckLoop, checkOne } from '../../srv/lib/link-health-core.js';

afterEach(() => vi.restoreAllMocks());

describe('checkOne', () => {
  it('maps a fast 200 to OK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    expect(await checkOne('https://x/y', 1500)).toBe('OK');
  });
  it('maps a thrown fetch to BROKEN', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENOTFOUND'); }));
    expect(await checkOne('https://x/y', 1500)).toBe('BROKEN');
  });
});

describe('runHealthCheckLoop', () => {
  it('applies linkStatusOverride without fetching and reports counts', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const rows = [{ id: 1, linkStatusOverride: 'OK' }, { id: 2, linkStatusOverride: 'BROKEN' }];
    const updated = [];
    const counts = await runHealthCheckLoop(
      rows, (r) => `https://x/${r.id}`, (r, s) => { updated.push([r.id, s]); }, 1500);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(counts).toEqual({ ok: 1, slow: 0, broken: 1, skipped: 0 });
    expect(updated).toEqual([[1, 'OK'], [2, 'BROKEN']]);
  });
  it('skips rows whose resolveUrl returns null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    const counts = await runHealthCheckLoop(
      [{ id: 1 }], () => null, () => {}, 1500);
    expect(counts.skipped).toBe(1);
  });
});
