import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('Public endpoints', () => {
  it('GET /build/catalog returns JSON array', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/build/catalog`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /build/navigator returns JSON', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/build/navigator`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);

    const body = await res.json();
    expect(body).toBeTruthy();
    expect(typeof body).toBe('object');
  });

  it('GET /.well-known/open-resource-discovery returns ORD configuration', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/.well-known/open-resource-discovery`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);

    const body = await res.json();
    expect(body.openResourceDiscoveryV1).toBeDefined();
    expect(body.openResourceDiscoveryV1.documents).toBeDefined();
  });

  it('GET /ord/v1/documents/ord-document returns ORD document', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/ord/v1/documents/ord-document`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);

    const body = await res.json();
    expect(body.apiResources).toBeDefined();
    expect(body.apiResources.length).toBeGreaterThan(0);
  });
});
