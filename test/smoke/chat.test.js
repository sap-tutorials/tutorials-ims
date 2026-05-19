import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('Joule chat smoke', () => {
  it('GET /api/ChatConfig responds with JSON', async () => {
    const r = await fetchWithRetry(`${SRV_URL}/api/ChatConfig`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/json/);
    const j = await r.json();
    expect(typeof j.enabled).toBe('boolean');
    expect(j).not.toHaveProperty('deploymentId');
    expect(j).not.toHaveProperty('maxRequestsPerUser');
  });

  it('POST /chat/stream returns 401 for anonymous', async () => {
    const r = await fetchWithRetry(`${SRV_URL}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], pageContext: { kind: 'generic' } })
    });
    expect(r.status).toBe(401);
  });
});
