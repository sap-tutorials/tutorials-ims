// test/unit/input-validation.test.js
// Unit coverage for the origin-side input validator (PR3):
//   - json-shape.js pure depth/keys/array walker
//   - input-validation-settings.js config defaulting (no cds runtime → defaults)
//   - the flag-gated / fail-open express middleware (register.js)
//   - graphql-guard.js depth + complexity rule and the per-request rule builder
//
// db-flags + metrics are mocked so no cds runtime is needed; the settings
// resolver naturally falls back to DEFAULT_CONFIG when cds has no model.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildSchema, parse, validate, specifiedRules, NoSchemaIntrospectionCustomRule } from 'graphql';

// Mutable holder so a hoisted vi.mock factory can read per-test state.
const h = vi.hoisted(() => ({ flag: false, throwFlag: false }));
vi.mock('../../srv/lib/feature-flags/db-flags.js', () => ({
  isFlagEnabled: () => {
    if (h.throwFlag) throw new Error('boom');
    return h.flag;
  },
}));
vi.mock('../../srv/lib/metrics.js', () => ({ counter: () => {} }));

import { validateJsonShape } from '../../srv/lib/input-validation/json-shape.js';
import {
  resolveInputValidationConfig,
  DEFAULT_CONFIG,
  _resetForTest as _resetCfg,
} from '../../srv/lib/runtime-config/input-validation-settings.js';
import { inputValidationMiddleware } from '../../srv/lib/input-validation/register.js';
import { costLimitRule, buildPublicValidationRules } from '../../srv/lib/graphql-guard.js';

const LIMITS = { maxJsonDepth: 5, maxJsonKeys: 10, maxArrayLen: 4 };

describe('json-shape: validateJsonShape', () => {
  it('accepts primitives and null', () => {
    for (const v of [null, 1, 'x', true, undefined]) {
      expect(validateJsonShape(v, LIMITS).ok).toBe(true);
    }
  });

  it('accepts a shallow, small object', () => {
    expect(validateJsonShape({ a: 1, b: [1, 2, 3], c: { d: 2 } }, LIMITS).ok).toBe(true);
  });

  it('rejects nesting beyond maxJsonDepth', () => {
    // depth 6 object: {a:{b:{c:{d:{e:{f:1}}}}}}
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    const r = validateJsonShape(deep, LIMITS);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('depth');
  });

  it('accepts nesting exactly at maxJsonDepth', () => {
    // depth 5: {a:{b:{c:{d:{e:1}}}}}
    const atLimit = { a: { b: { c: { d: { e: 1 } } } } };
    expect(validateJsonShape(atLimit, LIMITS).ok).toBe(true);
  });

  it('rejects an array longer than maxArrayLen', () => {
    const r = validateJsonShape({ list: [1, 2, 3, 4, 5] }, LIMITS);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('array');
  });

  it('rejects total key count beyond maxJsonKeys', () => {
    const wide = {};
    for (let i = 0; i < 11; i++) wide['k' + i] = i;
    const r = validateJsonShape(wide, LIMITS);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('keys');
  });

  it('does not blow its own stack on a very deep payload', () => {
    let deep = {};
    let cur = deep;
    for (let i = 0; i < 20000; i++) {
      cur.n = {};
      cur = cur.n;
    }
    // Iterative walk → returns a depth rejection, never a RangeError.
    expect(() => validateJsonShape(deep, LIMITS)).not.toThrow();
    expect(validateJsonShape(deep, LIMITS).reason).toBe('depth');
  });
});

describe('input-validation-settings: config defaulting', () => {
  beforeEach(() => _resetCfg());

  it('returns hardcoded defaults when no cds model / ImsConfig is available', async () => {
    const cfg = await resolveInputValidationConfig();
    expect(cfg.maxBodyBytes).toBe(DEFAULT_CONFIG.maxBodyBytes);
    expect(cfg.maxJsonDepth).toBe(DEFAULT_CONFIG.maxJsonDepth);
    expect(cfg.gqlMaxDepth).toBe(DEFAULT_CONFIG.gqlMaxDepth);
    expect(cfg.gqlMaxComplexity).toBe(DEFAULT_CONFIG.gqlMaxComplexity);
  });

  it('never throws', async () => {
    await expect(resolveInputValidationConfig()).resolves.toBeTypeOf('object');
  });
});

// Minimal express req/res doubles.
function mkRes() {
  return {
    statusCode: 0,
    body: null,
    _headers: {},
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(o) {
      this.body = o;
      return this;
    },
    setHeader(k, v) {
      this._headers[k] = v;
    },
  };
}

describe('input-validation middleware: flag gating + fail-open', () => {
  beforeEach(() => {
    h.flag = false;
    h.throwFlag = false;
    _resetCfg();
  });
  afterEach(() => vi.restoreAllMocks());

  it('is a pass-through when the flag is OFF', async () => {
    const mw = inputValidationMiddleware({ mode: 'full' });
    const req = { method: 'POST', path: '/x', headers: { 'content-length': '9999999999' } };
    const res = mkRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it('passes non-write methods through', async () => {
    h.flag = true;
    const mw = inputValidationMiddleware({ mode: 'full' });
    const req = { method: 'GET', path: '/x', headers: {} };
    const res = mkRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects an oversized Content-Length with 413 (pre-parse)', async () => {
    h.flag = true;
    const mw = inputValidationMiddleware({ mode: 'size' });
    const tooBig = String(DEFAULT_CONFIG.maxBodyBytes + 1);
    const req = { method: 'POST', path: '/x', headers: { 'content-length': tooBig } };
    const res = mkRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(413);
    expect(res.body.error).toBe('payload_too_large');
  });

  it('shape-rejects a deep already-parsed JSON body in full mode (400)', async () => {
    h.flag = true;
    const mw = inputValidationMiddleware({ mode: 'full' });
    // Build a body deeper than the DEFAULT maxJsonDepth (32).
    let deep = {};
    let cur = deep;
    for (let i = 0; i < 40; i++) {
      cur.n = {};
      cur = cur.n;
    }
    const req = {
      method: 'POST',
      path: '/mcp',
      headers: { 'content-type': 'application/json' },
      body: deep,
    };
    const res = mkRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_body_shape');
    expect(res.body.reason).toBe('depth');
  });

  it('allows a valid already-parsed JSON body in full mode', async () => {
    h.flag = true;
    const mw = inputValidationMiddleware({ mode: 'full' });
    const req = {
      method: 'POST',
      path: '/mcp',
      headers: { 'content-type': 'application/json' },
      body: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'x', arguments: { limit: 5 } } },
    };
    const res = mkRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it('does NOT shape-check in size mode even with a deep body', async () => {
    h.flag = true;
    const mw = inputValidationMiddleware({ mode: 'size' });
    let deep = {};
    let cur = deep;
    for (let i = 0; i < 40; i++) {
      cur.n = {};
      cur = cur.n;
    }
    const req = {
      method: 'POST',
      path: '/content',
      headers: { 'content-type': 'application/json' },
      body: deep,
    };
    const res = mkRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('honours the exclude regexp', async () => {
    h.flag = true;
    const mw = inputValidationMiddleware({ mode: 'size', exclude: /^\/(publish|rollback)\b/ });
    const req = { method: 'POST', path: '/publish', headers: { 'content-length': String(DEFAULT_CONFIG.maxBodyBytes + 1) } };
    const res = mkRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it('fails open when the flag check throws', async () => {
    h.throwFlag = true;
    const mw = inputValidationMiddleware({ mode: 'full' });
    const req = { method: 'POST', path: '/mcp', headers: { 'content-length': '9999999999' } };
    const res = mkRes();
    const next = vi.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });
});

describe('graphql-guard: costLimitRule', () => {
  const schema = buildSchema(`
    type Node { name: String, child: Node, items: [Node] }
    type Query { root: Node }
  `);

  it('accepts a shallow, cheap query', () => {
    const errs = validate(schema, parse('{ root { name } }'), [costLimitRule(3, 10)]);
    expect(errs).toEqual([]);
  });

  it('rejects a query deeper than maxDepth', () => {
    const q = '{ root { child { child { child { name } } } } }';
    const errs = validate(schema, parse(q), [costLimitRule(3, 100)]);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].message).toMatch(/maximum depth/);
  });

  it('rejects a query more complex than maxComplexity', () => {
    const q = '{ root { name child { name items { name } } } }';
    const errs = validate(schema, parse(q), [costLimitRule(100, 3)]);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].message).toMatch(/maximum complexity/);
  });

  it('resolves fragments when measuring depth', () => {
    const q = `
      { root { ...F } }
      fragment F on Node { child { child { name } } }
    `;
    const errs = validate(schema, parse(q), [costLimitRule(3, 100)]);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].message).toMatch(/maximum depth/);
  });
});

describe('graphql-guard: buildPublicValidationRules', () => {
  const OLD_VCAP = process.env.VCAP_APPLICATION;
  beforeEach(() => {
    h.flag = false;
    h.throwFlag = false;
    _resetCfg();
    delete process.env.VCAP_APPLICATION;
  });
  afterEach(() => {
    if (OLD_VCAP === undefined) delete process.env.VCAP_APPLICATION;
    else process.env.VCAP_APPLICATION = OLD_VCAP;
  });

  it('returns the default rules unchanged when the flag is OFF', async () => {
    const rules = await buildPublicValidationRules(null, null, specifiedRules);
    expect(rules).toBe(specifiedRules);
  });

  it('adds the cost rule (but NOT the introspection block) when ON and not prod', async () => {
    h.flag = true;
    const rules = await buildPublicValidationRules(null, null, specifiedRules);
    expect(rules.length).toBe(specifiedRules.length + 1);
    expect(rules).not.toContain(NoSchemaIntrospectionCustomRule);
  });

  it('adds the introspection block in prod', async () => {
    h.flag = true;
    process.env.VCAP_APPLICATION = JSON.stringify({ space_name: 'prod' });
    const rules = await buildPublicValidationRules(null, null, specifiedRules);
    expect(rules).toContain(NoSchemaIntrospectionCustomRule);
    expect(rules.length).toBe(specifiedRules.length + 2);
  });

  it('fails open (returns default rules) when the flag check throws', async () => {
    h.throwFlag = true;
    const rules = await buildPublicValidationRules(null, null, specifiedRules);
    expect(rules).toBe(specifiedRules);
  });
});
