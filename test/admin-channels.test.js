// test/admin-channels.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };
const NS = 'com.sap.developers.ims';
const linked = () => cds.linked(cds.model).entities(NS);

describe('AdminService.Channels', () => {
  beforeAll(async () => {
    await INSERT.into(linked().Channels).entries({
      ID: cds.utils.uuid(), sourceId: 'admin-001', name: 'Admin Test', url: 'https://admin-test', isPublished: true,
    });
  });
  afterAll(async () => { await DELETE.from(linked().Channels).where({ sourceId: 'admin-001' }); });

  it('is exposed at /admin/Channels and requires admin auth', async () => {
    await expect(project.get('/admin/Channels')).rejects.toMatchObject({ response: { status: 401 } });
    const { status, data } = await project.get('/admin/Channels', adminAuth);
    expect(status).toBe(200);
    expect(data.value.some((c) => c.sourceId === 'admin-001')).toBe(true);
  });
});
