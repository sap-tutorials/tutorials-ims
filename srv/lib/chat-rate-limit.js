const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export class RateLimitError extends Error {
  constructor(retryAfterSec) {
    super('rate_limit');
    this.name = 'RateLimitError';
    this.code = 'RATE_LIMIT';
    this.retryAfterSec = retryAfterSec;
  }
}

export function createRateLimiter({ now = () => Date.now(), windowMs = DEFAULT_WINDOW_MS } = {}) {
  const counters = new Map();

  return {
    check(userId, limit) {
      const t = now();
      let entry = counters.get(userId);
      // Reset before checking so an expired window never triggers the limit.
      if (!entry || t - entry.windowStart >= windowMs) {
        entry = { count: 0, windowStart: t };
        counters.set(userId, entry);
      }
      if (entry.count >= limit) {
        const retryAfterSec = Math.ceil((entry.windowStart + windowMs - t) / 1000);
        throw new RateLimitError(retryAfterSec);
      }
      entry.count += 1;
    }
  };
}
