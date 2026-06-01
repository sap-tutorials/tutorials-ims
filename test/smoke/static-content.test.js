import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

describe('Static content', () => {
  it('GET / returns HTML', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/`);
    // Root may redirect (302) or serve HTML directly (200)
    if (res.status === 302) return; // redirect to login is acceptable

    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') || '';
    expect(contentType).toMatch(/text\/html/);
  });

  it('GET / wires the header logo as a link to home', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/`);
    if (res.status === 302) return; // login redirect — acceptable, like the sibling test
    expect(res.status).toBe(200);
    const html = await res.text();
    // Whitespace-tolerant: survives any future JS minifier pass over inline <script>.
    expect(html).toMatch(/logo:\s*\{\s*role:\s*['"]link['"]/);
    expect(html).toContain('SAP Tutorial Platform — home');
  });

  it('response includes security headers', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/health`);
    // When served via approuter, CSP header is present
    // When testing directly against srv, it won't be — skip gracefully
    if (BASE_URL.includes('approuter') || BASE_URL.includes('cfapps')) {
      const csp = res.headers.get('content-security-policy');
      expect(csp).toBeTruthy();
    }
  });
});
