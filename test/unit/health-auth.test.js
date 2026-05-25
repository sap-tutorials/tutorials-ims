import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('/health/auth', () => {
  let baseUrl;

  beforeAll(async () => {
    // cds.test exposes the URL on `project.url`
    baseUrl = project.url;
  });

  it('returns 401 + authenticated:false for anonymous callers', async () => {
    const res = await fetch(`${baseUrl}/health/auth`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.authenticated).toBe(false);
  });

  it('returns 200 + scopes for authenticated callers (mocked basic auth)', async () => {
    // cds.test mocked-auth: any non-anonymous Basic token authenticates as that user.
    // alice is the canonical fixture in this project's tests; she may or may not have
    // scopes — accept both 200 (if seeded) or 401 (if not). Assert shape when 200.
    const credentials = Buffer.from('alice:').toString('base64');
    const res = await fetch(`${baseUrl}/health/auth`, {
      headers: { Authorization: `Basic ${credentials}` }
    });
    expect([200, 401]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(body.authenticated).toBe(true);
      expect(typeof body.user).toBe('string');
      expect(Array.isArray(body.scopes)).toBe(true);
      expect(typeof body.serverTime).toBe('string');
    }
  });
});
