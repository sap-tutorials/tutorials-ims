import { describe, it, expect, beforeAll, vi } from 'vitest';
import cds from '@sap/cds';
import crypto from 'node:crypto';

// Module-level cds.test boots CAP + in-memory SQLite, deploying the schema.
// This must run before data seeding in beforeAll.
cds.test('serve', '--project', '.', '--in-memory');

describe('mcp-pat-middleware', () => {
  let patMiddleware, _cache;

  beforeAll(async () => {
    const { Users, PATs } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({
      ID: 'mw-user-uuid', email: 'mw@example.com', displayName: 'Mw'
    });
    const token = 'pat_abcd1234_' + 'a'.repeat(48);
    const hashHex = crypto.createHash('sha256').update(token).digest('hex');
    await INSERT.into(PATs).entries({
      ID: 'pat-active-uuid', user_ID: 'mw-user-uuid', name: 'active',
      prefix: 'pat_abcd1234', hashHex, scopes: ['read'],
      expiresAt: new Date(Date.now() + 60_000)
    });
    await INSERT.into(PATs).entries({
      ID: 'pat-revoked-uuid', user_ID: 'mw-user-uuid', name: 'revoked',
      prefix: 'pat_revoked1', hashHex: crypto.createHash('sha256').update('pat_revoked1_' + 'b'.repeat(48)).digest('hex'),
      scopes: ['read'], expiresAt: new Date(Date.now() + 60_000),
      revokedAt: new Date()
    });
    ({ patMiddleware, _cache } = await import('../../srv/lib/mcp-pat-middleware.js'));
  });

  function mockReq(authz) {
    return { headers: authz ? { authorization: authz } : {}, user: undefined };
  }
  function mockRes() {
    return {
      statusCode: 200,
      headers: {},
      body: '',
      status(n) { this.statusCode = n; return this; },
      setHeader(k, v) { this.headers[k] = v; },
      send(b) { this.body = b; return this; },
      json(o) { this.body = JSON.stringify(o); return this; }
    };
  }

  it('is a no-op when no Authorization header', async () => {
    const req = mockReq(); const res = mockRes(); const next = vi.fn();
    await patMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('is a no-op when Authorization is not "Bearer pat_..."', async () => {
    const req = mockReq('Bearer eyJhbGciOi...'); const res = mockRes(); const next = vi.fn();
    await patMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('installs synthetic req.user for a valid PAT', async () => {
    const req = mockReq('Bearer pat_abcd1234_' + 'a'.repeat(48));
    const res = mockRes(); const next = vi.fn();
    await patMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toBeDefined();
    expect(req.user.tokenSource).toBe('pat');
    expect(req.user.is('authenticated-user')).toBe(true);
  });

  it('rejects a revoked PAT with 401', async () => {
    const req = mockReq('Bearer pat_revoked1_' + 'b'.repeat(48));
    const res = mockRes(); const next = vi.fn();
    await patMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown PAT with 401', async () => {
    const req = mockReq('Bearer pat_unknown0_' + 'z'.repeat(48));
    const res = mockRes(); const next = vi.fn();
    await patMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('caches successful auth for 60s', async () => {
    _cache.clear();
    const req1 = mockReq('Bearer pat_abcd1234_' + 'a'.repeat(48));
    await patMiddleware(req1, mockRes(), vi.fn());
    expect(_cache.size).toBe(1);
    const req2 = mockReq('Bearer pat_abcd1234_' + 'a'.repeat(48));
    await patMiddleware(req2, mockRes(), vi.fn());
    expect(_cache.size).toBe(1); // still one entry, second was a cache hit
  });
});
