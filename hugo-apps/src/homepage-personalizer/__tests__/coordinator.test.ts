// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// (#1093) Helpers to build fetch responses with an accurate content-type
// header — the coordinator now inspects it on both `/auth/user` and
// `/homepage/personalized` before calling `.json()`.
function jsonResponse(body: unknown, init: { status?: number } = {}): any {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  };
}

function htmlResponse(init: { status?: number } = {}): any {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    // `.json()` on HTML would throw in the browser; mirror that here so any
    // regression that reaches this branch surfaces the exact real-world failure.
    json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
  };
}

function statusResponse(status: number): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => ({}),
  };
}

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

  it('early-exits when /auth/user reports unauthenticated', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(jsonResponse({ authenticated: false }));
    const { boot } = await import('../coordinator');
    await boot();
    const urls = (globalThis.fetch as any).mock.calls.map((c: any) => c[0]);
    expect(urls).toContain('/auth/user');
    expect(urls).not.toContain('/homepage/personalized');
  });

  it('early-exits when /auth/user returns 401', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(statusResponse(401));
    const { boot } = await import('../coordinator');
    await boot();
    const urls = (globalThis.fetch as any).mock.calls.map((c: any) => c[0]);
    expect(urls).not.toContain('/homepage/personalized');
  });

  it('early-exits when /auth/user regresses to HTML (approuter reroute)', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(htmlResponse({ status: 200 }));
    const { boot } = await import('../coordinator');
    await boot();
    const urls = (globalThis.fetch as any).mock.calls.map((c: any) => c[0]);
    expect(urls).not.toContain('/homepage/personalized');
  });

  it('early-exits when session default flag set (no auth probe)', async () => {
    sessionStorage.setItem('sap-devs-homepage-default', '1');
    const { boot } = await import('../coordinator');
    await boot();
    const urls = (globalThis.fetch as any).mock.calls.map((c: any) => c[0]);
    expect(urls).not.toContain('/homepage/personalized');
    expect(urls).not.toContain('/auth/user');
  });

  it('fetches and caches on 200', async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(jsonResponse({ authenticated: true }))
      .mockResolvedValueOnce(jsonResponse({ hash: 'x' }));
    const { boot } = await import('../coordinator');
    await boot();
    const cache = sessionStorage.getItem('sap-devs-homepage-personalized');
    expect(cache).toContain('"hash":"x"');
  });

  it('honours 304 by keeping cached payload', async () => {
    sessionStorage.setItem('sap-devs-homepage-personalized',
      JSON.stringify({ hash: 'x', payload: { hash: 'x', verbOrder: ['a', 'b'] }, at: Date.now() }));
    (globalThis.fetch as any)
      .mockResolvedValueOnce(jsonResponse({ authenticated: true }))
      .mockResolvedValueOnce(statusResponse(304));
    const { boot } = await import('../coordinator');
    await boot();
    const cached = JSON.parse(sessionStorage.getItem('sap-devs-homepage-personalized')!);
    expect(cached.payload.verbOrder).toEqual(['a', 'b']);
  });

  it('warns and bails out when /homepage/personalized returns HTML (auth expired mid-session)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (globalThis.fetch as any)
      .mockResolvedValueOnce(jsonResponse({ authenticated: true }))
      .mockResolvedValueOnce(htmlResponse({ status: 200 }));
    const { boot } = await import('../coordinator');
    await boot();
    expect(sessionStorage.getItem('sap-devs-homepage-personalized')).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('warns (not debugs) when fetch throws — this branch was silently hiding auth failures', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    (globalThis.fetch as any)
      .mockResolvedValueOnce(jsonResponse({ authenticated: true }))
      .mockRejectedValueOnce(new Error('boom'));
    const { boot } = await import('../coordinator');
    await expect(boot()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });
});
