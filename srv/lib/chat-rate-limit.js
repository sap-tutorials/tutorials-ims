const WINDOW_MS = 24 * 60 * 60 * 1000;

export class RateLimitError extends Error {
  constructor(retryAfterSec) {
    super('rate_limit');
    this.code = 'RATE_LIMIT';
    this.retryAfterSec = retryAfterSec;
  }
}

export function createRateLimiter({ now = () => Date.now() } = {}) {
  const counters = new Map();

  return {
    check(userId, limit) {
      const t = now();
      let entry = counters.get(userId);
      if (!entry || t - entry.windowStart >= WINDOW_MS) {
        entry = { count: 0, windowStart: t };
        counters.set(userId, entry);
      }
      if (entry.count >= limit) {
        const retryAfterSec = Math.ceil((entry.windowStart + WINDOW_MS - t) / 1000);
        throw new RateLimitError(retryAfterSec);
      }
      entry.count += 1;
    }
  };
}
