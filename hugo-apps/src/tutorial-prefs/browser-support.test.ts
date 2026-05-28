// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectSupport } from './browser-support';

describe('detectSupport', () => {
  const origMM = window.matchMedia;
  afterEach(() => { window.matchMedia = origMM; vi.restoreAllMocks(); });

  function withMM(matches: Record<string, boolean>) {
    window.matchMedia = ((q: string) => ({
      matches: !!matches[q], media: q,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
      onchange: null
    })) as any;
  }

  it('returns supported=true when all APIs and desktop media queries pass', () => {
    withMM({ '(pointer: fine)': true, '(min-width: 768px)': true });
    (navigator as any).mediaDevices = { getUserMedia: vi.fn() };
    (globalThis as any).OffscreenCanvas = function () {};
    const r = detectSupport();
    expect(r.supported).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('flags getUserMedia missing', () => {
    withMM({ '(pointer: fine)': true, '(min-width: 768px)': true });
    (navigator as any).mediaDevices = undefined;
    (globalThis as any).OffscreenCanvas = function () {};
    const r = detectSupport();
    expect(r.supported).toBe(false);
    expect(r.reasons).toContain('camera-api');
  });

  it('flags coarse pointer or narrow viewport as mobile', () => {
    withMM({ '(pointer: fine)': false, '(min-width: 768px)': true });
    (navigator as any).mediaDevices = { getUserMedia: vi.fn() };
    (globalThis as any).OffscreenCanvas = function () {};
    expect(detectSupport().reasons).toContain('mobile');
    withMM({ '(pointer: fine)': true, '(min-width: 768px)': false });
    expect(detectSupport().reasons).toContain('mobile');
  });

  it('reports prefers-reduced-motion', () => {
    withMM({ '(pointer: fine)': true, '(min-width: 768px)': true, '(prefers-reduced-motion: reduce)': true });
    (navigator as any).mediaDevices = { getUserMedia: vi.fn() };
    (globalThis as any).OffscreenCanvas = function () {};
    expect(detectSupport().prefersReducedMotion).toBe(true);
  });
});
