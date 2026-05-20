import { describe, it, expect } from 'vitest';
import { SRV_URL, fetchWithRetry } from './smoke.config.js';

describe('grounded chat smoke', () => {
  it('GET /admin/embeddings/stats returns coverage shape (auth-required)', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/admin/embeddings/stats`);
    if (res.status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty('slugs');
      expect(body).toHaveProperty('embeddedSteps');
    } else {
      expect([401, 403]).toContain(res.status);
    }
  });
});
