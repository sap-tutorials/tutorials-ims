import './_guard.js';
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('ChatSettings (hybrid)', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });

  it('singleton row is present after deploy', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(ChatSettings));
    expect(rows.length).toBe(1);
    expect(rows[0].enabled).toBe(false);
  });

  it('public ChatConfig only exposes enabled and bannerText', async () => {
    const r = await project.get('/api/ChatConfig', { validateStatus: () => true });
    expect(r.status).toBe(200);
    const j = r.data;
    expect(j).toHaveProperty('enabled');
    expect(j).toHaveProperty('bannerText');
    expect(j).not.toHaveProperty('deploymentId');
    expect(j).not.toHaveProperty('maxRequestsPerUser');
  });
});
