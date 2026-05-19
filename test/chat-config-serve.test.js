import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /api/ChatConfig', () => {
  beforeAll(async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    const existing = await SELECT.from(ChatSettings);
    if (!existing || existing.length === 0) {
      await INSERT.into(ChatSettings).entries({
        ID: 'cccccccc-0000-0000-0000-000000000001',
        enabled: false,
        deploymentId: 'test-deployment',
        maxRequestsPerUser: 100,
        bannerText: 'Welcome'
      });
    }
  });

  it('returns enabled and bannerText only as a singleton', async () => {
    const res = await project.get('/api/ChatConfig', { validateStatus: () => true });
    const { status, data } = res;
    expect(status).toBe(200);
    // Singleton shape: object returned directly, not wrapped in a collection envelope.
    expect(data).not.toHaveProperty('value');
    expect(data).toHaveProperty('enabled');
    expect(data).toHaveProperty('bannerText');
    expect(data).not.toHaveProperty('deploymentId');
    expect(data).not.toHaveProperty('maxRequestsPerUser');
  });

  it('is reachable without auth while protected endpoints stay locked', async () => {
    // Positive: ChatConfig is public.
    const chat = await project.get('/api/ChatConfig', { validateStatus: () => true });
    expect(chat.status).toBe(200);

    // Negative: a known protected endpoint must still require auth.
    // Proves the service-level @requires:'any' flip didn't open the whole service.
    const tutorials = await project.get('/api/Tutorials', { validateStatus: () => true });
    expect(tutorials.status).toBe(401);
  });
});
