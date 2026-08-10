import { describe, it, expect } from 'vitest';
import { resolveEmbedParams } from './params';

describe('resolveEmbedParams', () => {
  it('parses a valid embed mode', () => {
    expect(resolveEmbedParams('?embed=none')).toMatchObject({ mode: 'none', reset: false });
    expect(resolveEmbedParams('?embed=minimal').mode).toBe('minimal');
    expect(resolveEmbedParams('?embed=reader').mode).toBe('reader');
  });

  it('treats embed=full as a reset (no mode)', () => {
    expect(resolveEmbedParams('?embed=full')).toMatchObject({ mode: null, reset: true });
  });

  it('ignores unknown embed values (treated as reset-neutral: no mode, no reset)', () => {
    expect(resolveEmbedParams('?embed=bogus')).toMatchObject({ mode: null, reset: false });
  });

  it('expands host=1 to minimal + pip', () => {
    const r = resolveEmbedParams('?host=1');
    expect(r.mode).toBe('minimal');
    expect(r.pip).toBe(true);
  });

  it('an explicit embed value overrides the host shorthand', () => {
    expect(resolveEmbedParams('?host=1&embed=none').mode).toBe('none');
  });

  it('parses pip=1 as a boolean flag', () => {
    expect(resolveEmbedParams('?pip=1').pip).toBe(true);
    expect(resolveEmbedParams('?pip=0').pip).toBe(false);
    expect(resolveEmbedParams('').pip).toBe(false);
  });

  it('parses a positive integer step, rejects junk', () => {
    expect(resolveEmbedParams('?step=3').step).toBe(3);
    expect(resolveEmbedParams('?step=0').step).toBeNull();
    expect(resolveEmbedParams('?step=-2').step).toBeNull();
    expect(resolveEmbedParams('?step=abc').step).toBeNull();
  });

  it('returns hostOrigin verbatim when present', () => {
    expect(resolveEmbedParams('?host-origin=https%3A%2F%2Ftrial.sap.com').hostOrigin)
      .toBe('https://trial.sap.com');
  });

  it('is empty for a bare query string', () => {
    expect(resolveEmbedParams('')).toEqual({ mode: null, reset: false, pip: false, step: null, hostOrigin: null });
  });
});
