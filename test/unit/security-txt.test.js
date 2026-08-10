import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// The approuter middleware is CommonJS; load it via require from ESM.
const require = createRequire(import.meta.url);
const {
  securityTxtHandler,
  SECURITY_TXT,
  SECURITY_TXT_PATH,
} = require('../../approuter/lib/security-txt.js');

// Minimal mock of the (req, res, next) trio the approuter middleware uses.
function mockRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this; },
    end(payload) { this.body = payload; return this; },
  };
}

describe('.well-known/security.txt — canonical file served by approuter middleware', () => {
  it('serves 200 + text/plain with the canonical body at the exact path', () => {
    const res = mockRes();
    let nexted = false;
    securityTxtHandler(
      { method: 'GET', url: SECURITY_TXT_PATH, headers: {} },
      res,
      () => { nexted = true; },
    );
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(res.body).toContain('Contact:');
    expect(res.body).toContain('Expires:');
  });

  it('served body is byte-identical to the exported canonical constant', () => {
    // Guards drift between what we serve and what the drift-check compares
    // against — both read SECURITY_TXT.
    const res = mockRes();
    securityTxtHandler({ method: 'GET', url: SECURITY_TXT_PATH, headers: {} }, res, () => {});
    expect(res.body).toBe(SECURITY_TXT);
  });

  it('canonical content is RFC 9116 shape: LF endings, trailing newline, Contact + Expires', () => {
    expect(SECURITY_TXT).toMatch(/^Contact: https:\/\/www\.sap\.com\/report-a-vulnerability\n/);
    expect(SECURITY_TXT).toMatch(/\nExpires: \d{4}-\d{2}-\d{2}T[\d:.]+Z\n$/);
    expect(SECURITY_TXT).not.toContain('\r');
  });

  it('tolerates a query string on the matched path', () => {
    const res = mockRes();
    let nexted = false;
    securityTxtHandler(
      { method: 'GET', url: `${SECURITY_TXT_PATH}?foo=bar`, headers: {} },
      res,
      () => { nexted = true; },
    );
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(200);
  });

  it('answers HEAD with 200 and no body', () => {
    const res = mockRes();
    securityTxtHandler({ method: 'HEAD', url: SECURITY_TXT_PATH, headers: {} }, res, () => {});
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(res.body).toBeUndefined();
  });

  it('passes through non-GET/HEAD methods to next()', () => {
    const res = mockRes();
    let nexted = false;
    securityTxtHandler({ method: 'POST', url: SECURITY_TXT_PATH, headers: {} }, res, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  it('passes through other /.well-known/* paths so it composes with the oauth handler', () => {
    for (const url of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource',
      '/.well-known/agent-card.json',
      '/.well-known/security.txt.bak',
      '/.well-known/security',
    ]) {
      const res = mockRes();
      let nexted = false;
      securityTxtHandler({ method: 'GET', url, headers: {} }, res, () => { nexted = true; });
      expect(nexted, `${url} should pass through`).toBe(true);
      expect(res.statusCode).toBeNull();
    }
  });
});
