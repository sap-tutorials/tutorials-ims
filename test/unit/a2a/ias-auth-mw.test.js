import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { a2aIasAuthMiddleware, __resetForTests } from '../../../srv/lib/a2a/ias-auth-mw.js';

const require = createRequire(import.meta.url);

// Route-scoped IAS auth middleware for POST /a2a (#2593 fix). These tests assert
// the degrade-closed contract — with no IAS binding (unit/local), the middleware
// must call next() WITHOUT populating a user, so rpc-router.js rejects anonymous
// (-32001/401). The wired-binding path (CAP factory) is exercised in hybrid/smoke.

describe('a2aIasAuthMiddleware (route-scoped IAS auth for /a2a)', () => {
  beforeEach(() => __resetForTests());
  afterEach(() => __resetForTests());

  it('degrades closed: with no IAS binding it calls next() and leaves no user', () => {
    const req = { headers: {} };
    const res = {};
    const next = vi.fn();
    a2aIasAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    // pass-through: no error passed, no user attached to the request
    expect(next.mock.calls[0][0]).toBeUndefined();
    expect(req.user).toBeUndefined();
  });

  it('never throws into the request chain when bindings are absent', () => {
    const next = vi.fn();
    expect(() => a2aIasAuthMiddleware({ headers: {} }, {}, next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('memoizes the built middleware across requests (single build)', () => {
    const n1 = vi.fn();
    const n2 = vi.fn();
    a2aIasAuthMiddleware({ headers: {} }, {}, n1);
    a2aIasAuthMiddleware({ headers: {} }, {}, n2);
    expect(n1).toHaveBeenCalledTimes(1);
    expect(n2).toHaveBeenCalledTimes(1);
  });
});

// Regression: #2649 — the prod /a2a 401. Resolving XSUAA by a single hardcoded
// instance name ('tutorials-xsuaa') threw out of the combined getServices() in
// prod (instance there is 'xsuaa-imsprod'), degrading /a2a to a full anonymous
// pass-through and taking IAS-only M2M down with it. These tests mock @sap/xsenv
// and CAP's internal ias-auth factory via a createRequire shim so the
// binding-resolution branches are exercised without real VCAP_SERVICES.
describe('a2aIasAuthMiddleware binding resolution (#2649)', () => {
  const IAS_CREDS = { clientid: 'ias-client', url: 'https://ias.example' };
  const XSUAA_CREDS = { clientid: 'sb-xsuaa', url: 'https://xsuaa.example' };

  let getServices;
  let factory;
  let wiredMw;

  function installRequireShim() {
    // The module builds its own require via createRequire(import.meta.url). Patch
    // Module.prototype.require so that specific specifiers resolve to our mocks,
    // and everything else falls through to the real require.
    const Module = require('node:module');
    const realRequire = Module.prototype.require;
    const shim = function (spec) {
      if (spec === '@sap/xsenv') return { getServices };
      if (spec.endsWith('/auth/ias-auth')) return factory;
      return realRequire.apply(this, arguments);
    };
    Module.prototype.require = shim;
    return () => {
      Module.prototype.require = realRequire;
    };
  }

  let restore;
  beforeEach(() => {
    __resetForTests();
    wiredMw = vi.fn((_req, _res, next) => next());
    factory = vi.fn(() => wiredMw);
    restore = installRequireShim();
  });
  afterEach(() => {
    restore?.();
    __resetForTests();
    vi.restoreAllMocks();
  });

  it('resolves XSUAA by label when the instance name differs (prod shape) and wires the fallback', () => {
    // name-based query misses (as in prod); label-based query hits.
    getServices = vi.fn((query) => {
      if ('ias' in query) return { ias: IAS_CREDS };
      if (query.xsuaa?.label === 'xsuaa') return { xsuaa: XSUAA_CREDS };
      if (query.xsuaa?.name) throw new Error('No service matches xsuaa');
      throw new Error(`unexpected query ${JSON.stringify(query)}`);
    });
    const next = vi.fn();
    a2aIasAuthMiddleware({ headers: {} }, {}, next);
    expect(factory).toHaveBeenCalledTimes(1);
    // XSUAA fallback wired → factory got the xsuaa requires key.
    expect(factory.mock.calls[0][0]).toMatchObject({ kind: 'ias', xsuaa: 'xsuaa' });
    expect(wiredMw).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('wires IAS-only (not pass-through) when no XSUAA binding exists at all', () => {
    getServices = vi.fn((query) => {
      if ('ias' in query) return { ias: IAS_CREDS };
      throw new Error('No service matches xsuaa'); // both label and name miss
    });
    const next = vi.fn();
    a2aIasAuthMiddleware({ headers: {} }, {}, next);
    // The core #2649 assertion: a missing XSUAA must NOT disable IAS auth.
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][0]).toMatchObject({ kind: 'ias' });
    expect(factory.mock.calls[0][0]).not.toHaveProperty('xsuaa');
    expect(wiredMw).toHaveBeenCalledTimes(1);
  });

  it('still degrades closed (pass-through) when the IAS binding is missing', () => {
    getServices = vi.fn((query) => {
      if ('ias' in query) throw new Error('No service matches ias');
      return { xsuaa: XSUAA_CREDS };
    });
    const next = vi.fn();
    a2aIasAuthMiddleware({ headers: {} }, {}, next);
    expect(factory).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();
  });
});
