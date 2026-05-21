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

  it('POST /chat/stream rejects anonymous (401) or short-circuits when disabled (503)', async () => {
    const r = await fetchWithRetry(`${SRV_URL}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], pageContext: { kind: 'generic' } })
    });
    // The kill-switch (ChatSettings.enabled=false) fires before the auth
    // check in srv/server.js, so anonymous gets 503 when chat is disabled
    // and 401 when it's enabled. Either is the expected guard behaviour.
    expect([401, 503]).toContain(r.status);
  });
});
