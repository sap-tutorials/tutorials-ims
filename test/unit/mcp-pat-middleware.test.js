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
    // Write-scoped PAT — covers the scope-bypass regression case: a read-only
    // PAT must NOT grant pat-write; a write-scoped one must.
    const writeToken = 'pat_write0001_' + 'c'.repeat(48);
    const writeHash = crypto.createHash('sha256').update(writeToken).digest('hex');
    await INSERT.into(PATs).entries({
      ID: 'pat-write-uuid', user_ID: 'mw-user-uuid', name: 'writer',
      prefix: 'pat_write0001', hashHex: writeHash, scopes: ['read', 'write'],
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
    // sapId path: authInfo.token.userId is what resolveDbUser reads first.
    // The seed above does not set sapId, so the value flows through as null —
    // the assertion locks the SHAPE that resolveDbUser depends on.
    expect(req.user.authInfo?.token).toBeDefined();
    // Scope pseudo-roles (security-review fix): read-only PAT grants pat-read,
    // NOT pat-write. Task 12's write handlers gate on pat-write.
    expect(req.user.is('pat-read')).toBe(true);
    expect(req.user.is('pat-write')).toBe(false);
  });

  it('strips the Authorization header on a valid PAT (#1105 — xsuaa must not JWT-parse it)', async () => {
    // The core production fix: after PAT auth, the Bearer pat_ header MUST be
    // removed so CAP's downstream xsuaa/ias strategy no-ops (jwt-auth returns
    // early on `!req.headers.authorization`) instead of throwing InvalidJwtError
    // → 401. Without this the deployed PAT tier 401'd on every call.
    const req = mockReq('Bearer pat_abcd1234_' + 'a'.repeat(48));
    const res = mockRes(); const next = vi.fn();
    await patMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.headers.authorization).toBeUndefined();
  });

  it('does NOT strip the Authorization header when the PAT is invalid', async () => {
    // A rejected PAT must leave the header intact (the request is 401'd here
    // anyway) — we only strip after a successful auth.
    const bad = 'Bearer pat_revoked1_' + 'b'.repeat(48);
    const req = mockReq(bad); const res = mockRes(); const next = vi.fn();
    await patMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(req.headers.authorization).toBe(bad);
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

  it('grants pat-write to a write-scoped PAT', async () => {
    _cache.clear();
    const req = mockReq('Bearer pat_write0001_' + 'c'.repeat(48));
    const res = mockRes(); const next = vi.fn();
    await patMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.is('pat-read')).toBe(true);
    expect(req.user.is('pat-write')).toBe(true);
  });

  it('invalidateCacheByPatId purges the specific PAT entry', async () => {
    const { invalidateCacheByPatId } = await import('../../srv/lib/mcp-pat-middleware.js');
    _cache.clear();
    // Warm cache with both active + write-scoped PATs.
    await patMiddleware(mockReq('Bearer pat_abcd1234_' + 'a'.repeat(48)), mockRes(), vi.fn());
    await patMiddleware(mockReq('Bearer pat_write0001_' + 'c'.repeat(48)), mockRes(), vi.fn());
    expect(_cache.size).toBe(2);
    invalidateCacheByPatId('pat-active-uuid');
    expect(_cache.size).toBe(1);
  });

  describe('pinPatUserToContext', () => {
    it('copies a PAT req.user onto cds.context.user', async () => {
      const { pinPatUserToContext } = await import('../../srv/lib/mcp-pat-middleware.js');
      const patUser = { id: 'mw@example.com', tokenSource: 'pat', is: () => true };
      const req = { user: patUser };
      const next = vi.fn();
      // Run inside a CAP context so cds.context is defined.
      await cds.tx({ user: new cds.User({ id: 'anonymous' }) }, () => {
        pinPatUserToContext(req, {}, next);
        expect(cds.context.user).toBe(patUser);
      });
      expect(next).toHaveBeenCalled();
    });

    it('is a no-op for non-PAT requests (does not touch cds.context.user)', async () => {
      const { pinPatUserToContext } = await import('../../srv/lib/mcp-pat-middleware.js');
      const jwtUser = new cds.User({ id: 'real@example.com' });
      const req = { user: { id: 'real@example.com', tokenSource: 'jwt' } };
      const next = vi.fn();
      await cds.tx({ user: jwtUser }, () => {
        pinPatUserToContext(req, {}, next);
        expect(cds.context.user).toBe(jwtUser); // unchanged
      });
      expect(next).toHaveBeenCalled();
    });
  });
});
