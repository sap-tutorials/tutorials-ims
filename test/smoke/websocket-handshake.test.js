import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('WebSocket endpoints', () => {
  it('/ws/event-stream responds to Socket.IO polling handshake', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/ws/event-stream/socket.io/?EIO=4&transport=polling`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('sid');
  });

  it('/rest/event-stream/getEventBuckets is accessible via HTTP', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/rest/event-stream/getEventBuckets(eventLegacyId=1)`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.value ?? json)).toBe(true);
  });
});
