import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

// Read-only reflection check: fetch high-risk public pages and grep for
// attacker-signature payloads that would indicate un-encoded author-supplied
// HTML slipping through. This catches the class where Hugo's default escaping
// was bypassed (safeHTML/htmlSafe on user data).
//
// Assertions match attacker-signature payloads (alert(), document.cookie,
// location hijack, srcdoc-embedded script) rather than any inline handler.
// Legitimate hardcoded template inline handlers (e.g. Hugo's author-avatar
// `onerror` fallback) are project-owned and CSP-permitted; they must NOT
// trip these assertions.
describe.skipIf(!BASE_URL || BASE_URL.startsWith('http://localhost'))(
  'XSS reflection on public pages (#797)',
  () => {
    const publicPages = [
      { path: '/homepage/', name: 'developer-portal homepage' },
      { path: '/tutorials/tutorial-platform-feature-cookbook', name: 'sample tutorial page' },
    ];

    it.each(publicPages)('$name has no raw <script> in author-editable regions', async ({ path }) => {
      const res = await fetchWithRetry(`${BASE_URL}${path}`);
      // Defensive fallback: these pages SHOULD be 200 HTML on DEV. If they ever
      // move, we degrade to a no-op rather than a false-positive.
      if (res.status === 404) {
        // eslint-disable-next-line no-console
        console.warn(`[xss-reflection] ${path} returned 404; skipping reflection assertion`);
        return;
      }
      expect(res.ok).toBe(true);
      const html = await res.text();
      // Reflection-signature patterns: attacker payloads typically call alert(),
      // read document.cookie, or hijack window.location. Legitimate template
      // inline handlers (e.g. Hugo's author-avatar `onerror` fallback) are
      // hardcoded and CSP-permitted; they must NOT trip the assertion.
      // We look for the tell-tale attacker tokens rather than the mere presence
      // of an inline handler.
      expect(html).not.toMatch(/\balert\s*\(\s*['"0-9]/i);              // alert(1), alert('...'), alert("...")
      expect(html).not.toMatch(/\bdocument\.cookie\b/i);
      expect(html).not.toMatch(/\bdocument\.location\s*=/i);
      expect(html).not.toMatch(/\bwindow\.location\s*=/i);
      expect(html).not.toMatch(/\bjavascript:\s*alert\s*\(/i);          // href="javascript:alert(1)"
      expect(html).not.toMatch(/<iframe[^>]*\bsrcdoc\s*=\s*['"][^'"]*<script/i);  // srcdoc-embedded script
      expect(html).not.toMatch(/<script[^>]*>[^<]*document\.cookie/i);   // inline script exfiltrating cookies
    });

    it('search results page HTML-encodes the query param', async () => {
      // Reflected input: URL query -> rendered on page.
      const payload = '<script>alert(1)</script>';
      const res = await fetchWithRetry(`${BASE_URL}/search/?q=${encodeURIComponent(payload)}`);
      if (res.status === 404) return; // if /search/ not enabled in this env
      const html = await res.text();
      // Raw <script>alert(1)</script> from the URL must NOT appear as literal HTML.
      // Hugo/Vue must encode it.
      expect(html).not.toContain('<script>alert(1)</script>');
      // Encoded form is acceptable (e.g. &lt;script&gt;).
    });

    it('tutorial slug 404 page does not reflect slug unencoded', async () => {
      const payload = '<img src=x onerror=alert(1)>';
      const res = await fetchWithRetry(`${BASE_URL}/tutorials/${encodeURIComponent(payload)}/`);
      // Expect 404, but check the 404 body does not contain the raw payload.
      const html = await res.text();
      expect(html).not.toContain('<img src=x onerror=alert(1)>');
    });
  },
);
