import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('WebSocket endpoints', () => {
  it('/display/websocket is mounted (returns 401 without auth, not 404)', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/display/websocket`);
    // Endpoint is auth-protected, so plain GET returns 401. The point of the
    // smoke check is to confirm the route exists at all.
    expect(res.status).not.toBe(404);
    expect([401, 403, 426, 400]).toContain(res.status);
  });

  it('/rest/event-stream/getEventBuckets endpoint is mounted', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/rest/event-stream/getEventBuckets(eventLegacyId=1)`);
    // DEV may not have an event with legacyId=1, so the call can return 404
    // with an error body. We only care that routing reaches the handler —
    // the response should be a JSON payload either way.
    expect([200, 404]).toContain(res.status);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });
});
