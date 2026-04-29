// test/admin-schema-ext.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('Schema Extensions', () => {
  it('Missions entity has groupOrder field', async () => {
    const { data } = await project.get('/admin/$metadata', adminAuth);
    expect(data).toContain('Name="groupOrder"');
  });

  it('Missions entity has primaryTagRef navigation property', async () => {
    const { data } = await project.get('/admin/$metadata', adminAuth);
    expect(data).toContain('Name="primaryTagRef"');
  });

  it('groupOrder defaults to 0 on new mission', async () => {
    const mission = { title: '__TEST__ Schema Ext Mission', slug: 'test-schema-ext' };
    const { data } = await project.post('/admin/Missions', mission, adminAuth);
    expect(data.groupOrder).toBe(0);
  });
});
