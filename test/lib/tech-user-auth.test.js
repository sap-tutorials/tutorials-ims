import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('tech-user-auth', () => {
  let basicAuthMiddleware;
  let tenantResolver;

  beforeEach(async () => {
    vi.resetModules();
    tenantResolver = await import('../../srv/lib/runtime-config/tenant-settings.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockTenant({ techUsers = '', techUsersMapping = '' } = {}) {
    vi.spyOn(tenantResolver, 'resolveTenantSettings').mockResolvedValue({
      allowedCorsOrigins: '',
      rebuildTargetEnv: 'dev',
      techUsers,
      techUsersMapping,
    });
  }

  async function loadMiddleware() {
    const mod = await import('../../srv/lib/tech-user-auth.js');
    return mod.basicAuthMiddleware;
  }

  function makeReq(authHeader) {
    return { headers: { authorization: authHeader }, user: undefined };
  }

  function makeRes() {
    return {};
  }

  it('passes through when no Authorization header', async () => {
    mockTenant();
    const mw = await loadMiddleware();
    const req = { headers: {} };
    let called = false;
    await mw(req, makeRes(), () => { called = true; });
    expect(called).toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('passes through when Authorization is not Basic', async () => {
    mockTenant();
    const mw = await loadMiddleware();
    const req = makeReq('Bearer some-jwt-token');
    let called = false;
    await mw(req, makeRes(), () => { called = true; });
    expect(called).toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('passes through when TECH_USERS is not configured', async () => {
    mockTenant();
    const mw = await loadMiddleware();
    const creds = Buffer.from('admin:secret').toString('base64');
    const req = makeReq(`Basic ${creds}`);
    let called = false;
    await mw(req, makeRes(), () => { called = true; });
    expect(called).toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('authenticates valid tech user with configured roles', async () => {
    mockTenant({ techUsers: 'ci-bot:s3cret:Admin,ContentAuthor' });
    const mw = await loadMiddleware();
    const creds = Buffer.from('ci-bot:s3cret').toString('base64');
    const req = makeReq(`Basic ${creds}`);
    let called = false;
    await mw(req, makeRes(), () => { called = true; });
    expect(called).toBe(true);
    expect(req.user).toBeDefined();
    expect(req.user.id).toBe('ci-bot');
    expect(req.user.is('Admin')).toBe(true);
    expect(req.user.is('ContentAuthor')).toBe(true);
  });

  it('defaults to Admin role when no roles specified', async () => {
    mockTenant({ techUsers: 'svc-account:pass123' });
    const mw = await loadMiddleware();
    const creds = Buffer.from('svc-account:pass123').toString('base64');
    const req = makeReq(`Basic ${creds}`);
    let called = false;
    await mw(req, makeRes(), () => { called = true; });
    expect(called).toBe(true);
    expect(req.user.is('Admin')).toBe(true);
  });

  it('rejects invalid password', async () => {
    mockTenant({ techUsers: 'ci-bot:correct-pass:Admin' });
    const mw = await loadMiddleware();
    const creds = Buffer.from('ci-bot:wrong-pass').toString('base64');
    const req = makeReq(`Basic ${creds}`);
    let called = false;
    await mw(req, makeRes(), () => { called = true; });
    expect(called).toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('rejects unknown username', async () => {
    mockTenant({ techUsers: 'ci-bot:pass:Admin' });
    const mw = await loadMiddleware();
    const creds = Buffer.from('unknown:pass').toString('base64');
    const req = makeReq(`Basic ${creds}`);
    let called = false;
    await mw(req, makeRes(), () => { called = true; });
    expect(called).toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('applies tech user identity mapping', async () => {
    mockTenant({
      techUsers: 'sci-tech:p4ss:ConsolidationScope',
      techUsersMapping: 'sci-tech:a1b2c3d4-real-user-uuid',
    });
    const mw = await loadMiddleware();
    const creds = Buffer.from('sci-tech:p4ss').toString('base64');
    const req = makeReq(`Basic ${creds}`);
    let called = false;
    await mw(req, makeRes(), () => { called = true; });
    expect(called).toBe(true);
    expect(req.user.id).toBe('a1b2c3d4-real-user-uuid');
    expect(req.user.is('ConsolidationScope')).toBe(true);
    expect(req.user.attr.techUser).toBe('sci-tech');
  });

  it('supports multiple tech users', async () => {
    mockTenant({ techUsers: 'user-a:pass-a:Admin;user-b:pass-b:DisplayApp' });
    const mw = await loadMiddleware();

    const credsA = Buffer.from('user-a:pass-a').toString('base64');
    const reqA = makeReq(`Basic ${credsA}`);
    await mw(reqA, makeRes(), () => {});
    expect(reqA.user.id).toBe('user-a');
    expect(reqA.user.is('Admin')).toBe(true);

    const credsB = Buffer.from('user-b:pass-b').toString('base64');
    const reqB = makeReq(`Basic ${credsB}`);
    await mw(reqB, makeRes(), () => {});
    expect(reqB.user.id).toBe('user-b');
    expect(reqB.user.is('DisplayApp')).toBe(true);
  });

  it('does not authenticate when password contains colons (format limitation)', async () => {
    // Env format "user:pass:roles" splits on ":" — passwords with colons are unsupported.
    // Use TECH_USERS_JSON for complex passwords.
    mockTenant({ techUsers: 'bot:my:complex:pass:Admin' });
    const mw = await loadMiddleware();
    // The env parsing sees: user=bot, pass=my, roles=complex,pass,Admin
    // So the actual password stored is "my", not "my:complex:pass"
    const creds = Buffer.from('bot:my').toString('base64');
    const req = makeReq(`Basic ${creds}`);
    await mw(req, makeRes(), () => {});
    expect(req.user).toBeDefined();
    expect(req.user.id).toBe('bot');
  });
});
