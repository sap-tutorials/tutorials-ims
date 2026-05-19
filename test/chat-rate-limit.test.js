import { describe, it, expect } from 'vitest';
import { createRateLimiter, RateLimitError } from '../srv/lib/chat-rate-limit.js';

describe('chat-rate-limit', () => {
  it('allows up to the limit then throws RateLimitError', () => {
    const rl = createRateLimiter();
    for (let i = 0; i < 3; i++) rl.check('user-a', 3);
    expect(() => rl.check('user-a', 3)).toThrow(/rate/i);
    expect(() => rl.check('user-a', 3)).toThrow(RateLimitError);
  });

  it('isolates counters per user', () => {
    const rl = createRateLimiter();
    rl.check('a', 1);
    expect(() => rl.check('a', 1)).toThrow();
    expect(() => rl.check('b', 1)).not.toThrow();
  });

  it('resets after the window expires', () => {
    let now = 1_000_000;
    const rl = createRateLimiter({ now: () => now });
    rl.check('a', 1);
    expect(() => rl.check('a', 1)).toThrow();
    now += 24 * 60 * 60 * 1000 + 1;
    expect(() => rl.check('a', 1)).not.toThrow();
  });

  it('reads the limit fresh on each call', () => {
    const rl = createRateLimiter();
    rl.check('a', 1);
    expect(() => rl.check('a', 5)).not.toThrow();
  });

  it('exposes a valid retryAfterSec for the Retry-After header contract', () => {
    expect.assertions(4);
    const rl = createRateLimiter();
    rl.check('u', 1);
    try {
      rl.check('u', 1);
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitError);
      expect(Number.isInteger(e.retryAfterSec)).toBe(true);
      expect(e.retryAfterSec).toBeGreaterThan(0);
      expect(e.retryAfterSec).toBeLessThanOrEqual(86400);
    }
  });
});
