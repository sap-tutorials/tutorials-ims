import { describe, it, expect, beforeEach } from 'vitest';
import { requireXsuaaScope, _resetForTests } from '../../srv-qa/xsuaa-scope-middleware.js';

// These tests verify the middleware *contract* — its behaviour with and without
// an XSUAA binding. Real JWT validation is exercised by the smoke test in CI
// against the deployed srv-qa (where the xsuaa instance is bound).  Faking
// xssec locally would defeat the purpose of the test.

describe('requireXsuaaScope middleware', () => {
  beforeEach(() => {
    _resetForTests();
    // Ensure no XSUAA binding leaks in from CI env. xsenv.serviceCredentials
    // throws when it can't find a binding labelled 'xsuaa', which is the
    // mocked-auth path the middleware degrades to.
    delete process.env.VCAP_SERVICES;
    delete process.env.VCAP_APPLICATION;
  });

  it('passes through when no XSUAA binding is present (mocked-auth/unit-test mode)', async () => {
    const mw = requireXsuaaScope('Tutorial.Author');
    const req = { headers: {} };
    const res = {
      status() { throw new Error('status should not be called in mocked-auth mode'); },
      json() { throw new Error('json should not be called in mocked-auth mode'); }
    };
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it('exports a function factory that returns an Express middleware (3-arg signature)', () => {
    const mw = requireXsuaaScope('Tutorial.Author');
    expect(typeof mw).toBe('function');
    expect(mw.length).toBe(3); // (req, res, next)
  });
});
