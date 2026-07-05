// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('coordinator boot()', () => {
  beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
    localStorage.clear();
    document.cookie = '';
    (globalThis as any).fetch = vi.fn();
    // Stub sendBeacon so beacon.ts calls never fire real HTTP in happy-dom.
    Object.defineProperty(globalThis.navigator, 'sendBeacon', {
      value: vi.fn().mockReturnValue(true),
      writable: true,
      configurable: true,
    });
  });

  it('early-exits when anon', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({ ok: false, status: 401 });
    const { boot } = await import('../coordinator');
    await boot();
    const urls = (globalThis.fetch as any).mock.calls.map((c: any) => c[0]);
    expect(urls).not.toContain('/homepage/personalized');
  });

  it('early-exits when session default flag set', async () => {
    sessionStorage.setItem('sap-devs-homepage-default', '1');
    const { boot } = await import('../coordinator');
    await boot();
    const urls = (globalThis.fetch as any).mock.calls.map((c: any) => c[0]);
    expect(urls).not.toContain('/homepage/personalized');
  });

  it('fetches and caches on 200', async () => {
    document.cookie = 'JSESSIONID=abc';
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ hash: 'x' }),
    });
    const { boot } = await import('../coordinator');
    await boot();
    const cache = sessionStorage.getItem('sap-devs-homepage-personalized');
    expect(cache).toContain('"hash":"x"');
  });

  it('honours 304 by keeping cached payload', async () => {
    document.cookie = 'JSESSIONID=abc';
    sessionStorage.setItem('sap-devs-homepage-personalized',
      JSON.stringify({ hash: 'x', payload: { hash: 'x', verbOrder: ['a', 'b'] }, at: Date.now() }));
    (globalThis.fetch as any).mockResolvedValueOnce({ ok: true, status: 304 });
    const { boot } = await import('../coordinator');
    await boot();
    const cached = JSON.parse(sessionStorage.getItem('sap-devs-homepage-personalized')!);
    expect(cached.payload.verbOrder).toEqual(['a', 'b']);
  });

  it('swallows fetch errors silently', async () => {
    document.cookie = 'JSESSIONID=abc';
    (globalThis.fetch as any).mockRejectedValueOnce(new Error('boom'));
    const { boot } = await import('../coordinator');
    await expect(boot()).resolves.toBeUndefined();
  });
});
