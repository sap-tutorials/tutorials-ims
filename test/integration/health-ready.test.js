import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
const { GET } = cds.test('serve', '--project', '.', '--in-memory');
describe('/health/ready (#2975)', () => {
  it('returns 200 ready once the served app has initialised the scheduler', async () => {
    const res = await GET('/health/ready');
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ready');
    expect(res.data.scheduler).toBe('armed');
  });
});
