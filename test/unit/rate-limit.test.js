// test/unit/rate-limit.test.js
// Unit coverage for the origin-side rate limiter (PR1): pure fixed-window
// logic, the in-memory fail-open fallback counting, tier resolution
// (anon/auth/trusted incl. HMAC verify + replay rejection), and config
// defaulting. No cds runtime is required — the shared store is forced into its
// fallback path by rejecting cds.connect.to.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import cds from '@sap/cds';

import {
  _evaluateForTest,
  checkRateLimit,
  clientIpFrom,
  _resetConnectionForTest,
  _resetFallbackForTest,
} from '../../srv/lib/rate-limit/shared-limiter.js';
import { resolveTier, _canonicalForTest } from '../../srv/lib/rate-limit/agent-identity.js';
import { _primeForTests, _resetForTests as _resetSecrets } from '../../srv/lib/secret-resolver.js';
import { resolveRateLimitConfig, DEFAULT_CONFIG, _resetForTest as _resetCfg } from '../../srv/lib/runtime-config/rate-limit-settings.js';

describe('shared-limiter: fixed-window evaluate()', () => {
  const opts = { windowMs: 1000, max: 3, t: 10_000 };

  it('allows under max and increments count', () => {
    const r1 = _evaluateForTest(null, opts);
    expect(r1.allowed).toBe(true);
    expect(r1.count).toBe(1);
    const r2 = _evaluateForTest(r1.rec, opts);
    expect(r2.allowed).toBe(true);
    expect(r2.count).toBe(2);
  });

  it('blocks at max with a positive retryAfterSec', () => {
    const rec = { count: 3, windowStart: 10_000 };
    const r = _evaluateForTest(rec, { ...opts, t: 10_400 });
    expect(r.allowed).toBe(false);
    expect(r.count).toBe(3);
    // window ends at 11_000, now 10_400 → ceil(600/1000) = 1
    expect(r.retryAfterSec).toBe(1);
  });

  it('resets the window once windowMs has elapsed', () => {
    const rec = { count: 3, windowStart: 10_000 };
    const r = _evaluateForTest(rec, { ...opts, t: 11_000 });
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(1);
    expect(r.rec.windowStart).toBe(11_000);
  });
});

describe('shared-limiter: fail-open fallback counting', () => {
  beforeEach(() => {
    _resetConnectionForTest();
    _resetFallbackForTest();
    // Force the shared-store path to fail → deterministic in-memory fallback.
    vi.spyOn(cds.connect, 'to').mockRejectedValue(new Error('no store in unit'));
  });
  afterEach(() => vi.restoreAllMocks());

  it('allows exactly max requests per window then blocks (store=memory)', async () => {
    const base = 100_000;
    const call = (i) =>
      checkRateLimit({
        tier: 'anon',
        clientKey: '1.2.3.4',
        routeClass: 'build',
        windowMs: 1000,
        max: 2,
        now: () => base + i,
      });

    const a = await call(0);
    const b = await call(10);
    const c = await call(20);
    expect(a.store).toBe('memory');
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(c.allowed).toBe(false);
    expect(c.retryAfterSec).toBeGreaterThan(0);
  });

  it('keys are isolated per (routeClass,tier,clientKey)', async () => {
    const now = () => 200_000;
    const a = await checkRateLimit({ tier: 'anon', clientKey: 'ipA', routeClass: 'graph', windowMs: 1000, max: 1, now });
    const a2 = await checkRateLimit({ tier: 'anon', clientKey: 'ipA', routeClass: 'graph', windowMs: 1000, max: 1, now });
    const b = await checkRateLimit({ tier: 'anon', clientKey: 'ipB', routeClass: 'graph', windowMs: 1000, max: 1, now });
    expect(a.allowed).toBe(true);
    expect(a2.allowed).toBe(false); // same key exhausted
    expect(b.allowed).toBe(true); // different key, own budget
  });
});

describe('shared-limiter: clientIpFrom', () => {
  it('takes the leftmost X-Forwarded-For entry', () => {
    expect(clientIpFrom({ headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' } })).toBe('9.9.9.9');
  });
  it('falls back to req.ip then unknown', () => {
    expect(clientIpFrom({ headers: {}, ip: '5.5.5.5' })).toBe('5.5.5.5');
    expect(clientIpFrom({ headers: {} })).toBe('unknown');
  });
});

describe('agent-identity: resolveTier', () => {
  const SECRET = 'unit-test-hmac-secret';
  beforeEach(() => {
    _resetSecrets();
    _primeForTests('AGENT_HMAC_SECRET', SECRET);
  });
  afterEach(() => _resetSecrets());

  const sign = ({ keyId = 'default', method, path, ts }) =>
    createHmac('sha256', SECRET).update(_canonicalForTest({ keyId, method, path, ts })).digest('hex');

  it('returns anon for a bare request', async () => {
    const r = await resolveTier({ method: 'GET', url: '/build/catalog', headers: {} });
    expect(r.tier).toBe('anon');
    expect(r.clientKey).toBeNull();
  });

  it('returns auth when a bearer token is present, keyed off a hash', async () => {
    const r = await resolveTier({ method: 'GET', url: '/api/x', headers: { authorization: 'Bearer abc.def.ghi' } });
    expect(r.tier).toBe('auth');
    expect(r.clientKey).toMatch(/^auth:[0-9a-f]{16}$/);
  });

  it('returns trusted for a valid HMAC signature', async () => {
    const ts = String(Date.now());
    const headers = {
      'x-agent-signature': sign({ method: 'GET', path: '/mcp', ts }),
      'x-agent-timestamp': ts,
    };
    const r = await resolveTier({ method: 'GET', url: '/mcp', headers });
    expect(r.tier).toBe('trusted');
    expect(r.clientKey).toBe('hmac:default');
  });

  it('rejects a stale timestamp (replay window)', async () => {
    const ts = String(Date.now() - 10 * 60 * 1000); // 10 min ago, outside ±5min
    const headers = {
      'x-agent-signature': sign({ method: 'GET', path: '/mcp', ts }),
      'x-agent-timestamp': ts,
    };
    const r = await resolveTier({ method: 'GET', url: '/mcp', headers });
    expect(r.tier).toBe('anon');
  });

  it('rejects a tampered signature', async () => {
    const ts = String(Date.now());
    const good = sign({ method: 'GET', path: '/mcp', ts });
    // Flip the first hex nibble to guarantee a different signature.
    const tampered = (good[0] === 'a' ? 'b' : 'a') + good.slice(1);
    const headers = {
      'x-agent-signature': tampered,
      'x-agent-timestamp': ts,
    };
    const r = await resolveTier({ method: 'GET', url: '/mcp', headers });
    expect(r.tier).toBe('anon');
  });

  it('does not grant trusted when path differs from the signed path', async () => {
    const ts = String(Date.now());
    const headers = {
      'x-agent-signature': sign({ method: 'GET', path: '/mcp', ts }),
      'x-agent-timestamp': ts,
    };
    const r = await resolveTier({ method: 'GET', url: '/graph/neighborhood', headers });
    expect(r.tier).toBe('anon');
  });
});

describe('rate-limit-settings: resolveRateLimitConfig', () => {
  beforeEach(() => {
    _resetCfg();
    vi.spyOn(cds.connect, 'to').mockRejectedValue(new Error('no db in unit'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetCfg();
  });

  it('falls back to hardcoded defaults on read failure', async () => {
    const cfg = await resolveRateLimitConfig();
    expect(cfg.windowMs).toBe(DEFAULT_CONFIG.windowMs);
    expect(cfg.limits.build).toBe(DEFAULT_CONFIG.limits.build);
    expect(cfg.tierMult).toEqual({ anon: 1, auth: 5, trusted: 20 });
  });

  it('returns a mutable clone, not the frozen default', async () => {
    const cfg = await resolveRateLimitConfig();
    expect(() => {
      cfg.limits.build = 999;
    }).not.toThrow();
    expect(DEFAULT_CONFIG.limits.build).not.toBe(999);
  });
});
