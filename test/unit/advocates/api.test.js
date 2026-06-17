import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('Advocates admin handlers', () => {
  afterAll(async () => {
    const db = await cds.connect.to('db');
    const { Advocates } = cds.entities('com.sap.developers.ims');
    // Clean up TEST rows so re-runs are isolated; preserve seeded fixtures.
    await db.run(DELETE.from(Advocates).where`firstName like '__TEST__%'`);
  });

  it('auto-derives slug from firstName/lastName on activate', async () => {
    // POST creates a draft. With @odata.draft.enabled, the handler must
    // produce a final slug by the time the row reaches active state.
    const res = await project.post('/admin/Advocates', {
      firstName: '__TEST__Andre',
      lastName:  'Muller',
      region:    'EMEA'
    }, { ...adminAuth, headers: { Prefer: 'handling=lenient' } });
    expect([201, 200]).toContain(res.status);
    expect(res.data.slug).toBe('test-andre-muller');
  });

  it('appends -2 on slug collision', async () => {
    const a = await project.post('/admin/Advocates', {
      firstName: '__TEST__Casey',
      lastName:  'Smith',
      region:    'AMERICAS'
    }, { ...adminAuth, headers: { Prefer: 'handling=lenient' } });
    expect(a.data.slug).toBe('test-casey-smith');
    const b = await project.post('/admin/Advocates', {
      firstName: '__TEST__Casey',
      lastName:  'Smith',
      region:    'APJ'
    }, { ...adminAuth, headers: { Prefer: 'handling=lenient' } });
    expect(b.data.slug).toBe('test-casey-smith-2');
  });
});
