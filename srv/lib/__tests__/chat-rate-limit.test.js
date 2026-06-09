import { describe, it, expect } from 'vitest';
import { createRateLimiter, RateLimitError } from '../chat-rate-limit.js';

describe('createRateLimiter — configurable window', () => {
  it('defaults to 24h window when windowMs is omitted (back-compat)', () => {
    let now = 0;
    const limiter = createRateLimiter({ now: () => now });
    for (let i = 0; i < 5; i++) limiter.check('user-1', 5);
    expect(() => limiter.check('user-1', 5)).toThrow(RateLimitError);
    now += 23 * 60 * 60 * 1000;
    expect(() => limiter.check('user-1', 5)).toThrow(RateLimitError);
    now += 2 * 60 * 60 * 1000;
    expect(() => limiter.check('user-1', 5)).not.toThrow();
  });

  it('honors a 1-hour windowMs', () => {
    let now = 0;
    const limiter = createRateLimiter({ now: () => now, windowMs: 60 * 60 * 1000 });
    for (let i = 0; i < 3; i++) limiter.check('u', 3);
    expect(() => limiter.check('u', 3)).toThrow(RateLimitError);
    now += 30 * 60 * 1000;
    expect(() => limiter.check('u', 3)).toThrow(RateLimitError);
    now += 31 * 60 * 1000;
    expect(() => limiter.check('u', 3)).not.toThrow();
  });

  it('RateLimitError carries retryAfterSec rounded to ceil', () => {
    expect.assertions(2);  // guard against silent zero-assertion pass if check() ever stops throwing
    let now = 0;
    const limiter = createRateLimiter({ now: () => now, windowMs: 60 * 60 * 1000 });
    limiter.check('u', 1);
    try {
      limiter.check('u', 1);
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect(err.retryAfterSec).toBe(60 * 60);
    }
  });
});
