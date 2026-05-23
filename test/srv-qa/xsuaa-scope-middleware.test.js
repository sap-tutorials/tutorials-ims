import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';
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

  describe('when authKind === "xsuaa" but XSUAA binding is missing', () => {
    let originalAuthKind;

    beforeEach(() => {
      _resetForTests();
      // Force the "configured but misbehaving" branch: CAP says xsuaa is the
      // auth provider, but no VCAP_SERVICES → xsenv.serviceCredentials throws.
      cds.env.requires = cds.env.requires || {};
      cds.env.requires.auth = cds.env.requires.auth || {};
      originalAuthKind = cds.env.requires.auth.kind;
      cds.env.requires.auth.kind = 'xsuaa';
      delete process.env.VCAP_SERVICES;
      delete process.env.VCAP_APPLICATION;
    });

    afterEach(() => {
      cds.env.requires.auth.kind = originalAuthKind;
      _resetForTests();
    });

    it('fails closed with 503 + { error: "service_unavailable" }', async () => {
      const mw = requireXsuaaScope('Tutorial.Author');
      const req = { headers: {} };
      let statusCode = null;
      let body = null;
      const res = {
        status(code) { statusCode = code; return this; },
        json(payload) { body = payload; return this; }
      };
      let nextCalled = false;
      await mw(req, res, () => { nextCalled = true; });
      expect(nextCalled).toBe(false);
      expect(statusCode).toBe(503);
      expect(body).toEqual({ error: 'service_unavailable' });
    });
  });
});
