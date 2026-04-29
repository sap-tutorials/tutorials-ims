import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('Health endpoints', () => {
  it('GET /health returns ok', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeTruthy();
  });

  it('GET /health/db returns connected', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/health/db`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('connected');
  });
});
