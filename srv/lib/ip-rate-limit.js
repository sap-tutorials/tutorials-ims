// Per-IP fixed-window rate limiter for unauthenticated routes (e.g. /search).
// Single-process in-memory; adequate for current single-instance deployment.
// On scale-out, replace with a shared store (Redis / HANA table) or accept
// drift across instances.
const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX = 60;
const PRUNE_EVERY = 1024; // periodic GC so the Map doesn't grow unbounded

export class IpRateLimitError extends Error {
  constructor(retryAfterSec) {
    super('rate_limit');
    this.name = 'IpRateLimitError';
    this.code = 'RATE_LIMIT';
    this.retryAfterSec = retryAfterSec;
  }
}

export function createIpRateLimiter({
  windowMs = DEFAULT_WINDOW_MS,
  max = DEFAULT_MAX,
  now = () => Date.now()
} = {}) {
  const counters = new Map();
  let writes = 0;

  return {
    check(ip) {
      const t = now();
      let entry = counters.get(ip);
      if (!entry || t - entry.windowStart >= windowMs) {
        entry = { count: 0, windowStart: t };
        counters.set(ip, entry);
      }
      if (entry.count >= max) {
        const retryAfterSec = Math.ceil((entry.windowStart + windowMs - t) / 1000);
        throw new IpRateLimitError(retryAfterSec);
      }
      entry.count += 1;

      if (++writes >= PRUNE_EVERY) {
        writes = 0;
        for (const [k, v] of counters) {
          if (t - v.windowStart >= windowMs) counters.delete(k);
        }
      }
    }
  };
}

// Express middleware factory. Derives the originating client IP from the
// leftmost X-Forwarded-For entry (BTP Gorouter strips client-supplied XFF
// before AppRouter sees it, so the leftmost is trustworthy as long as ingress
// is constrained to AppRouter). Falls back to req.ip.
export function ipRateLimitMiddleware(limiter, { logName = 'rate-limit' } = {}) {
  return (req, res, next) => {
    const xff = String(req.headers['x-forwarded-for'] || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const clientIp = xff.length ? xff[0] : req.ip || 'unknown';
    try {
      limiter.check(clientIp);
      return next();
    } catch (err) {
      if (err instanceof IpRateLimitError) {
        res.setHeader('Retry-After', String(err.retryAfterSec));
        return res.status(429).json({ error: 'rate_limit', retryAfter: err.retryAfterSec });
      }
      return next(err);
    }
  };
}
