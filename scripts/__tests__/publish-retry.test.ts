import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withRetry, classifyError, formatErrorChain, computeBackoff } from '../lib/publish-retry.js';

describe('classifyError', () => {
  it('classifies HTTP 5xx as transient', () => {
    expect(classifyError({ status: 502 })).toBe('transient');
    expect(classifyError({ status: 503 })).toBe('transient');
    expect(classifyError({ status: 504 })).toBe('transient');
  });
  it('classifies HTTP 408 and 429 as transient', () => {
    expect(classifyError({ status: 408 })).toBe('transient');
    expect(classifyError({ status: 429 })).toBe('transient');
  });
  it('classifies other 4xx as permanent', () => {
    expect(classifyError({ status: 400 })).toBe('permanent');
    expect(classifyError({ status: 401 })).toBe('permanent');
    expect(classifyError({ status: 409 })).toBe('permanent');
    expect(classifyError({ status: 413 })).toBe('permanent');
  });
  it('classifies fetch TypeError as transient', () => {
    const err = new TypeError('fetch failed');
    expect(classifyError(err)).toBe('transient');
  });
  it('classifies AbortError as transient', () => {
    const err = new Error('timeout');
    err.name = 'AbortError';
    expect(classifyError(err)).toBe('transient');
  });
  it('classifies ECONNRESET / ETIMEDOUT / EPIPE codes as transient', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET']) {
      expect(classifyError({ code })).toBe('transient');
    }
  });
});

describe('formatErrorChain', () => {
  it('walks err.cause recursively', () => {
    const inner = new Error('inner');
    (inner as any).code = 'UND_ERR_SOCKET';
    const middle = new Error('middle');
    (middle as any).cause = inner;
    const outer = new TypeError('fetch failed');
    (outer as any).cause = middle;
    const formatted = formatErrorChain(outer);
    expect(formatted).toContain('TypeError: fetch failed');
    expect(formatted).toContain('caused by: Error: middle');
    expect(formatted).toContain('caused by: Error: inner');
    expect(formatted).toContain('UND_ERR_SOCKET');
  });
});

describe('computeBackoff', () => {
  it('returns baseMs unchanged when jitterRatio is 0 or omitted', () => {
    expect(computeBackoff(2000)).toBe(2000);
    expect(computeBackoff(2000, 0)).toBe(2000);
    // rand should be ignored when there is no jitter
    expect(computeBackoff(2000, 0, () => 0.99)).toBe(2000);
  });

  it('scales within [1-r, 1+r] of baseMs', () => {
    // rand()=0 → factor 1-r (low end); rand()=1 → factor 1+r (high end); 0.5 → base
    expect(computeBackoff(1000, 0.2, () => 0)).toBe(800);
    expect(computeBackoff(1000, 0.2, () => 1)).toBe(1200);
    expect(computeBackoff(1000, 0.2, () => 0.5)).toBe(1000);
  });

  it('never returns a negative wait', () => {
    expect(computeBackoff(100, 5, () => 0)).toBe(0);
  });
});

describe('withRetry', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('returns the result on first attempt success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const p = withRetry(fn, { attempts: 3, backoffMs: [1, 3, 9] });
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error and eventually succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 502 }))
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 503 }))
      .mockResolvedValue('ok');
    const p = withRetry(fn, { attempts: 3, backoffMs: [1000, 3000, 9000] });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry permanent errors', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('bad'), { status: 400 }));
    const p = withRetry(fn, { attempts: 3, backoffMs: [1, 3, 9] });
    await expect(p).rejects.toThrow('bad');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after attempts exhausted, exposing attempt count and last cause', async () => {
    const err502 = Object.assign(new Error('boom'), { status: 502 });
    const fn = vi.fn().mockRejectedValue(err502);
    const p = withRetry(fn, { attempts: 3, backoffMs: [10, 30, 90] });
    // Pre-attach a catch handler so the eventual rejection isn't reported
    // as unhandled between vi.advanceTimersByTimeAsync ticks — Vitest's
    // unhandled-rejection guard fires on the microtask BEFORE `expect(p).rejects`
    // registers its own handler.
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(40);
    await vi.advanceTimersByTimeAsync(30);
    await expect(p).rejects.toMatchObject({ attempts: 3 });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
