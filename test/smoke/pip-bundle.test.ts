import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:5000';

describe('PiP bundles deployed', () => {
  it('GET /js/tutorial-pip-launcher.js returns 200', async () => {
    const res = await fetch(`${BASE}/js/tutorial-pip-launcher.js`);
    expect(res.status).toBe(200);
    const txt = await res.text();
    expect(txt.length).toBeGreaterThan(0);
  });

  it('GET /js/tutorial-pip.js returns 200', async () => {
    const res = await fetch(`${BASE}/js/tutorial-pip.js`);
    expect(res.status).toBe(200);
    const txt = await res.text();
    expect(txt.length).toBeGreaterThan(0);
  });
});
