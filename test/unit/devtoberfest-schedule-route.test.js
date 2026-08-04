import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

// Boot the CAP server in-memory and hit the express routes.
const project = cds.test('serve', '--project', '.', '--in-memory');

describe('devtoberfest schedule route', () => {
  it('GET /api/devtoberfest/schedule is anonymous-accessible and returns the feed shape', async () => {
    const res = await project.axios.get('/api/devtoberfest/schedule', { validateStatus: () => true });
    // Either 200 with the shape, or 503 EVENT_NOT_CONFIGURED when no edition is seeded in the unit DB.
    expect([200, 503]).toContain(res.status);
    if (res.status === 200) {
      expect(res.data).toHaveProperty('sessions');
      expect(res.data).toHaveProperty('activities');
      expect(res.data).toHaveProperty('editions');
    } else {
      expect(res.data.error).toBe('EVENT_NOT_CONFIGURED');
    }
  });

  it('GET /api/devtoberfest/my-completions returns authenticated:false for anonymous', async () => {
    const res = await project.axios.get('/api/devtoberfest/my-completions', { validateStatus: () => true });
    expect(res.status).toBe(200);
    expect(res.data.authenticated).toBe(false);
  });

  it('registers the speaker photo route and returns 503 EVENT_NOT_CONFIGURED when facade absent', async () => {
    const res = await project.axios.get('/api/devtoberfest/speaker/nope/photo', { validateStatus: () => true });
    // In the unit (SQLite) env the external.devtoberfest facades are absent.
    // The handler must explicitly return 503 { error: 'EVENT_NOT_CONFIGURED' },
    // distinguishing it from an unregistered-route 404 (which has no JSON body).
    expect(res.status).toBe(503);
    expect(res.data.error).toBe('EVENT_NOT_CONFIGURED');
  });

  it('transcript endpoint 400s without a video id', async () => {
    const res = await project.axios.get('/api/devtoberfest/transcript', { validateStatus: () => true });
    expect(res.status).toBe(400);
  });
});
