import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Issue #133: CORS must allowlist origins, not reflect any. The allowlist is
// now sourced from TenantSettings (managed via /admin-ui/#tenantsettings-display)
// — the ALLOWED_CORS_ORIGINS env-var fallback was removed in the
// credstore-runtime-config PR. See srv/lib/runtime-config/tenant-settings.js.

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('CORS allowlist (#133)', () => {
  let baseUrl;

  beforeAll(async () => {
    baseUrl = project.url;
    // Seed the TenantSettings row that resolveTenantSettings() reads. The
    // resolver caches for 5s on globalThis; reset the cache and (re-)insert.
    const { TenantSettings } = cds.entities('com.sap.developers.ims');
    const { _resetCacheForTests } = await import('../../srv/lib/runtime-config/tenant-settings.js');
    await DELETE.from(TenantSettings);
    await INSERT.into(TenantSettings).entries({
      allowedCorsOrigins: 'http://allowed.example,http://localhost:1313',
    });
    _resetCacheForTests();
  });

  it('does not echo a disallowed origin', async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://attacker.example' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('echoes an allowed origin and sets credentials + Vary', async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'http://allowed.example' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://allowed.example');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    // Vary: Origin is required when ACAO varies by request
    const vary = res.headers.get('vary') || '';
    expect(vary.toLowerCase()).toContain('origin');
  });

  it('omits CORS headers entirely when no Origin is sent', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('handles preflight: OPTIONS with allowed origin returns 204 with ACAO', async () => {
    const res = await fetch(`${baseUrl}/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://allowed.example',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://allowed.example');
  });

  it('handles preflight: OPTIONS with disallowed origin returns 204 but no ACAO', async () => {
    const res = await fetch(`${baseUrl}/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://attacker.example',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
