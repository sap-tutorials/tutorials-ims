// srv/lib/__tests__/llm-backoff.test.js
import { describe, it, expect, vi } from 'vitest';
import { callWithBackoff, isRetryableLlmError } from '../llm-backoff.js';

// Zero-delay sleep + pinned RNG so the suite is instant and deterministic.
const noSleep = () => Promise.resolve();
const pinnedRandom = () => 0.5;

function httpError(status) {
  const e = new Error(`HTTP ${status}`);
  e.status = status;
  return e;
}

describe('isRetryableLlmError', () => {
  it('treats 429 as retryable', () => {
    expect(isRetryableLlmError(httpError(429))).toBe(true);
  });

  it('treats 5xx as retryable', () => {
    expect(isRetryableLlmError(httpError(500))).toBe(true);
    expect(isRetryableLlmError(httpError(503))).toBe(true);
  });

  it('treats other 4xx as NON-retryable', () => {
    expect(isRetryableLlmError(httpError(400))).toBe(false);
    expect(isRetryableLlmError(httpError(401))).toBe(false);
    expect(isRetryableLlmError(httpError(404))).toBe(false);
  });

  it('reads status from nested response/cause shapes', () => {
    expect(isRetryableLlmError({ response: { status: 429 } })).toBe(true);
    expect(isRetryableLlmError({ cause: { status: 502 } })).toBe(true);
  });

  it('treats transient transport codes as retryable', () => {
    expect(isRetryableLlmError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryableLlmError({ code: 'ECONNRESET' })).toBe(true);
  });

  it('treats a plain error (no status/code) as NON-retryable', () => {
    expect(isRetryableLlmError(new Error('Model did not return a tool call'))).toBe(false);
    expect(isRetryableLlmError(null)).toBe(false);
  });
});

describe('callWithBackoff', () => {
  it('returns immediately on first success (no retries)', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await callWithBackoff(fn, { sleep: noSleep, random: pinnedRandom });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 then succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(httpError(429))
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValue('recovered');
    const result = await callWithBackoff(fn, { sleep: noSleep, random: pinnedRandom });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws immediately on a non-retryable error without retrying', async () => {
    const fn = vi.fn().mockRejectedValue(httpError(400));
    await expect(callWithBackoff(fn, { sleep: noSleep, random: pinnedRandom })).rejects.toThrow('HTTP 400');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts the retry budget then throws the last error', async () => {
    const fn = vi.fn().mockRejectedValue(httpError(429));
    await expect(
      callWithBackoff(fn, { maxRetries: 3, sleep: noSleep, random: pinnedRandom }),
    ).rejects.toThrow('HTTP 429');
    // 1 initial + 3 retries = 4 attempts.
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('grows the delay ceiling exponentially and caps it', async () => {
    const delays = [];
    const sleep = (ms) => { delays.push(ms); return Promise.resolve(); };
    const fn = vi.fn().mockRejectedValue(httpError(503));
    await expect(
      callWithBackoff(fn, {
        maxRetries: 5,
        baseDelayMs: 500,
        maxDelayMs: 8000,
        sleep,
        random: () => 1 - Number.EPSILON, // push delay to the top of each ceiling
      }),
    ).rejects.toThrow();
    // Ceilings: 500, 1000, 2000, 4000, 8000 (capped). Each delay < its ceiling.
    expect(delays.length).toBe(5);
    expect(delays[0]).toBeLessThanOrEqual(500);
    expect(delays[1]).toBeLessThanOrEqual(1000);
    expect(delays[2]).toBeLessThanOrEqual(2000);
    expect(delays[3]).toBeLessThanOrEqual(4000);
    expect(delays[4]).toBeLessThanOrEqual(8000);
    // Monotonic non-decreasing ceilings mean later delays trend larger.
    expect(delays[4]).toBeGreaterThan(delays[0]);
  });

  it('invokes onRetry for each retry with a status-bearing message', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValue('ok');
    await callWithBackoff(fn, { sleep: noSleep, random: pinnedRandom, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toContain('429');
  });
});
