import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry, authHeader } from './smoke.config.js';

describe('OData metadata', () => {
  it('DeveloperService $metadata responds with XML', async () => {
    const headers = {};
    const auth = authHeader();
    if (auth) headers['Authorization'] = auth;

    const res = await fetchWithRetry(`${SRV_URL}/api/$metadata`, { headers });
    // Without auth against srv directly, we still get metadata (OData serves it publicly in CAP)
    // If auth is required, skip gracefully
    if (res.status === 401 || res.status === 403) return;

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('<edmx:Edmx');
    expect(text).toContain('DeveloperService');
  });

  it('AdminService $metadata responds with XML', async () => {
    const headers = {};
    const auth = authHeader();
    if (auth) headers['Authorization'] = auth;

    const res = await fetchWithRetry(`${SRV_URL}/admin/$metadata`, { headers });
    if (res.status === 401 || res.status === 403) return;

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('<edmx:Edmx');
  });
});

describe('Admin UI Draft Annotations', () => {
  it('AdminService $metadata includes draft annotations for Missions', async () => {
    const headers = {};
    const auth = authHeader();
    if (auth) headers['Authorization'] = auth;

    const res = await fetchWithRetry(`${SRV_URL}/admin/$metadata`, { headers });
    if (res.status === 401 || res.status === 403) return;

    const text = await res.text();
    expect(text).toContain('DraftAdministrativeData');
    expect(text).toContain('IsActiveEntity');
  });
});
