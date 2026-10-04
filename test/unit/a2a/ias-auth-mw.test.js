import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { a2aIasAuthMiddleware, __resetForTests } from '../../../srv/lib/a2a/ias-auth-mw.js';

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
