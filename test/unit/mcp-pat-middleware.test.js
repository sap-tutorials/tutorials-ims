import { describe, it, expect, beforeAll, vi } from 'vitest';
import cds from '@sap/cds';
import crypto from 'node:crypto';

// Module-level cds.test boots CAP + in-memory SQLite, deploying the schema.
// This must run before data seeding in beforeAll.
cds.test('serve', '--project', '.', '--in-memory');

describe('mcp-pat-middleware', () => {
  let patMiddleware, invalidateCacheByPatId, _resetConnection;

  beforeAll(async () => {
    // Configure an in-memory caching store so the `caching` service resolves
    // (issue #1180 — the PAT cache is now backed by cds-caching, not lru-cache).
    cds.env.requires = cds.env.requires || {};
    cds.env.requires.caching = { impl: 'cds-caching', namespace: 'pat-test', store: 'memory' };
    await cds.connect.to('caching');

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
    // Dedicated PAT for the cache-behavior tests below — revoked mid-test to
    // prove cache-hit vs. invalidation semantics, so kept off the shared seeds.
    await INSERT.into(PATs).entries({
      ID: 'pat-cache-uuid', user_ID: 'mw-user-uuid', name: 'cache-probe',
      prefix: 'pat_cache0001', hashHex: crypto.createHash('sha256').update('pat_cache0001_' + 'd'.repeat(48)).digest('hex'),
      scopes: ['read'], expiresAt: new Date(Date.now() + 60_000)
    });
    ({ patMiddleware, invalidateCacheByPatId, _resetConnection } =
      await import('../../srv/lib/mcp-pat-middleware.js'));
    _resetConnection();
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

  it('caches a successful auth (a DB revoke after warming is not seen until invalidation)', async () => {
    // cds-caching owns TTL/eviction now (#1180); we assert OUR contract — a hit
    // is served from cache, so a revoke written straight to the DB underneath
    // is invisible until the entry is invalidated or expires.
    const auth = 'Bearer pat_cache0001_' + 'd'.repeat(48);
    // Warm the cache with a valid auth.
    const req1 = mockReq(auth); const res1 = mockRes(); const next1 = vi.fn();
    await patMiddleware(req1, res1, next1);
    expect(next1).toHaveBeenCalled();
    expect(req1.user?.tokenSource).toBe('pat');

    // Revoke straight in the DB — bypasses invalidateCacheByPatId on purpose.
    const { PATs } = cds.entities('com.sap.developers.ims');
    await UPDATE(PATs).set({ revokedAt: new Date() }).where({ ID: 'pat-cache-uuid' });

    // Second call still hits the cached (pre-revoke) entry → still authorized.
    const req2 = mockReq(auth); const res2 = mockRes(); const next2 = vi.fn();
    await patMiddleware(req2, res2, next2);
    expect(next2).toHaveBeenCalled();
    expect(res2.statusCode).toBe(200);
  });

  it('grants pat-write to a write-scoped PAT', async () => {
    const req = mockReq('Bearer pat_write0001_' + 'c'.repeat(48));
    const res = mockRes(); const next = vi.fn();
    await patMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.is('pat-read')).toBe(true);
    expect(req.user.is('pat-write')).toBe(true);
  });

  it('invalidateCacheByPatId purges the entry so the next call re-reads the DB (revoked → 401)', async () => {
    // Continues from the warmed+DB-revoked pat-cache-uuid above: invalidating
    // its cache entry forces a fresh DB read, which now sees the revocation.
    await invalidateCacheByPatId('pat-cache-uuid');
    const req = mockReq('Bearer pat_cache0001_' + 'd'.repeat(48));
    const res = mockRes(); const next = vi.fn();
    await patMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
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
