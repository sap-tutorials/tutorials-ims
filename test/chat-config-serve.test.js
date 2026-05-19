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

  it('returns enabled and bannerText only', async () => {
    const res = await project.get('/api/ChatConfig', { validateStatus: () => true });
    const { status, data } = res;
    expect(status).toBe(200);
    const row = Array.isArray(data?.value) ? data.value[0] : data;
    expect(row).toHaveProperty('enabled');
    expect(row).toHaveProperty('bannerText');
    expect(row).not.toHaveProperty('deploymentId');
    expect(row).not.toHaveProperty('maxRequestsPerUser');
  });

  it('is reachable without auth', async () => {
    const { status } = await project.get('/api/ChatConfig', { validateStatus: () => true });
    expect(status).toBe(200);
  });
});
