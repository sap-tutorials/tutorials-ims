// srv/lib/rate-limit/register.js
//
// Wires the shared-store rate limiter (srv/lib/rate-limit/shared-limiter.js)
// into the CAP express app for the anonymous / expensive surface, following the
// register(app) convention used by advocatesPublic / alertsPublic / deployEvents.
//
// Master kill switch: RATE_LIMIT_ENABLED (ImsConfig flag.ratelimit), default
// OFF. When off, every mounted middleware is a straight pass-through — no store
// calls, no tier resolution. Numeric thresholds come from
// rate-limit-settings.js. EVERYTHING here fails open: a fault anywhere resolves
// to next() (request allowed).
//
// Mounted in cds.on('bootstrap') so the middleware sits AHEAD of the CAP
// service handlers (MCP at /mcp, /build/*, /content/*, etc.) in the express
// stack. This COMPLEMENTS the legacy per-instance /search limiter (which stays
// always-on and is intentionally NOT re-mounted here — replacing it would drop
// its always-on floor while this flag defaults OFF). /search migration to the
// shared store is deferred to a later increment.

import cds from '@sap/cds';
import { checkRateLimit, clientIpFrom } from './shared-limiter.js';
import { resolveTier } from './agent-identity.js';
import { resolveRateLimitConfig } from '../runtime-config/rate-limit-settings.js';
import { isFlagEnabled } from '../feature-flags/db-flags.js';
import { counter } from '../metrics.js';
import { raise as raiseAlert } from '../alerting.js';

const LOG = cds.log('rate-limit');

// Process-wide rolling block counter → RateLimitAbuse alert. Pinned to
// globalThis for the same module-multiplicity reason as the limiter fallback.
const ABUSE = (globalThis[Symbol.for('com.sap.developers.ims:rate-limit-abuse')] ??= {
  windowStart: 0,
  blocks: 0,
  lastAlertAt: 0,
});
const ABUSE_WINDOW_MS = 60_000;
const ABUSE_ALERT_DEBOUNCE_MS = 5 * 60_000; // matches the ANS dedup window

// Record one block and, on sustained abuse, fire a debounced RateLimitAbuse
// alert. Fire-and-forget — NEVER awaited from the request path (alerting.js is
// itself fail-open + timeout-raced, but we still never block the response).
function recordBlockAndMaybeAlert(cfg, { routeClass, tier }) {
  const t = Date.now();
  if (t - ABUSE.windowStart >= ABUSE_WINDOW_MS) {
    ABUSE.windowStart = t;
    ABUSE.blocks = 0;
  }
  ABUSE.blocks += 1;
  if (ABUSE.blocks >= cfg.abuseAlertPerMin && t - ABUSE.lastAlertAt >= ABUSE_ALERT_DEBOUNCE_MS) {
    ABUSE.lastAlertAt = t;
    const blocks = ABUSE.blocks;
    Promise.resolve(
      raiseAlert({
        eventType: 'RateLimitAbuse',
        severity: 'WARNING',
        subject: `Origin rate-limit abuse: ${blocks} blocks/min`,
        body:
          `Sustained origin rate-limit blocking: ${blocks} requests blocked in the last minute ` +
          `(threshold ${cfg.abuseAlertPerMin}). Latest route=${routeClass}, tier=${tier}. ` +
          `Likely a scraper/bot flood or a misbehaving client.`,
        resource: { resourceName: 'origin-rate-limit', resourceType: 'cap-service' },
      })
    ).catch(() => {});
  }
}

/**
 * Build an express middleware for one route class. `exclude` is an optional
 * RegExp tested against req.path — matching requests bypass the limiter (used
 * to spare privileged write paths like /content/publish).
 */
export function rateLimitMiddleware({ routeClass = 'default', exclude = null } = {}) {
  return async function rateLimit(req, res, next) {
    try {
      if (!isFlagEnabled('RATE_LIMIT_ENABLED')) return next();
      if (exclude && exclude.test(req.path)) return next();

      const cfg = await resolveRateLimitConfig();
      const { tier, clientKey } = await resolveTier(req);
      const key = clientKey || clientIpFrom(req);

      const base = cfg.limits[routeClass] ?? cfg.limits.default;
      const mult = cfg.tierMult[tier] ?? 1;
      const max = Math.max(1, Math.round(base * mult));
      const windowMs = Math.max(1_000, cfg.windowMs);

      const result = await checkRateLimit({ tier, clientKey: key, routeClass, windowMs, max });
      counter('ratelimit.hits');
      if (result.allowed) return next();

      counter(`ratelimit.blocked[route=${routeClass},tier=${tier}]`);
      recordBlockAndMaybeAlert(cfg, { routeClass, tier });
      res.setHeader('Retry-After', String(result.retryAfterSec));
      return res.status(429).json({ error: 'rate_limit', retryAfter: result.retryAfterSec });
    } catch (err) {
      // Fail-open: never let the limiter break the surface it protects.
      LOG.warn(`rate-limit middleware error (allowing request): ${err.message}`);
      return next();
    }
  };
}

// (prefix, routeClass) mounts for the anon / expensive surface. Order matters:
// express matches by mount prefix, so the more specific /content/pages must be
// registered before /content.
const MOUNTS = [
  { prefix: '/content/pages', routeClass: 'page' },
  // Spare the privileged publish/rollback write paths (API-key auth, low volume).
  { prefix: '/content', routeClass: 'content', exclude: /^\/(publish|rollback)\b/ },
  { prefix: '/build', routeClass: 'build' },
  { prefix: '/graph', routeClass: 'graph' },
  { prefix: '/feedback', routeClass: 'feedback' },
  { prefix: '/homepage', routeClass: 'homepage' },
  { prefix: '/api', routeClass: 'api' },
  // Agentic endpoints — anonymous AND CSRF-disabled, the sharpest exposure.
  { prefix: '/mcp', routeClass: 'agentic' },
  { prefix: '/mcp-pat', routeClass: 'agentic' },
  { prefix: '/a2a', routeClass: 'agentic' },
  { prefix: '/chat/stream', routeClass: 'agentic' },
  { prefix: '/graphql/public', routeClass: 'agentic' },
];

/**
 * Mount the rate limiter on the anon/expensive routes. Call from
 * cds.on('bootstrap'). Idempotent-safe to call once.
 */
export function register(app) {
  for (const m of MOUNTS) {
    app.use(m.prefix, rateLimitMiddleware({ routeClass: m.routeClass, exclude: m.exclude }));
  }
  LOG.info(`rate limiter mounted on ${MOUNTS.length} route classes (flag-gated, default off)`);
}
