// test/unit/page-route-registered.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
const test = cds.test('serve', '--project', '.', '--in-memory');

describe('/content/pages route', () => {
  it('is mounted and 404s an unpublished in-scope page (not 500/unhandled)', async () => {
    const res = await test.get('/content/pages/topics/').catch((e) => e.response);
    expect(res.status).toBe(404);
  });
});
