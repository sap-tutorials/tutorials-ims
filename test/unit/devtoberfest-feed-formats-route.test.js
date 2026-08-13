import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

// Boot the CAP server in-memory and hit the express routes. In the unit (SQLite)
// env the external.devtoberfest.* facades are absent, so the feed endpoints
// return 503 EVENT_NOT_CONFIGURED rather than 404 — that distinction proves the
// route is registered and anonymous-accessible. Content-type-on-200 is exercised
// in hybrid/smoke (guarded below).
const project = cds.test('serve', '--project', '.', '--in-memory');

describe('devtoberfest calendar feed routes', () => {
  it('GET /api/devtoberfest/feed.ics is registered, anonymous, and returns text/calendar on success', async () => {
    const res = await project.axios.get('/api/devtoberfest/feed.ics', { validateStatus: () => true });
    expect(res.status).not.toBe(404);
    expect([200, 503]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers['content-type']).toContain('text/calendar');
      expect(String(res.data)).toContain('BEGIN:VCALENDAR');
    } else {
      expect(res.data.error).toBe('EVENT_NOT_CONFIGURED');
    }
  });

  it('GET /api/devtoberfest/feed.xml is registered, anonymous, and returns RSS on success', async () => {
    const res = await project.axios.get('/api/devtoberfest/feed.xml', { validateStatus: () => true });
    expect(res.status).not.toBe(404);
    expect([200, 503]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers['content-type']).toContain('application/rss+xml');
      expect(String(res.data)).toContain('<rss');
    } else {
      expect(res.data.error).toBe('EVENT_NOT_CONFIGURED');
    }
  });

  it('GET /api/devtoberfest/session/:id.ics is registered and anonymous', async () => {
    const res = await project.axios.get('/api/devtoberfest/session/s1.ics', { validateStatus: () => true });
    expect(res.status).not.toBe(404);
    // 503 when facade absent; 404 with JSON body would mean session not found on a
    // configured env; 200 text/calendar on success.
    expect([200, 404, 503]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers['content-type']).toContain('text/calendar');
    }
  });
});
