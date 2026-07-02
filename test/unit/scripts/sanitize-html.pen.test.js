/**
 * XSS payload fuzz for the tutorial-content HTML sanitizer (#797).
 *
 * Exercises `stripDangerousHtml` (the exported production entry point used by
 * `scripts/parsers/render-frontmatter.ts`) with payloads from the OWASP XSS
 * Filter Evasion Cheat Sheet. `stripDangerousHtml` wraps `sanitizeLine`
 * line-by-line for non-code-fence content, so single-line inline XSS payloads
 * exercise the same surface as the internal `sanitizeLine` function.
 *
 * Chose `stripDangerousHtml` over exporting `sanitizeLine` to keep the
 * public export surface of `sanitize-html.ts` minimal (no source change).
 */
import { describe, it, expect } from 'vitest';
import { stripDangerousHtml } from '../../../scripts/parsers/sanitize-html.js';

// OWASP XSS Filter Evasion Cheat Sheet — condensed high-signal set.
const XSS_PAYLOADS = [
  { name: 'basic script tag', input: '<script>alert(1)</script>' },
  { name: 'img onerror', input: '<img src=x onerror=alert(1)>' },
  { name: 'svg onload', input: '<svg onload=alert(1)>' },
  { name: 'javascript URI in href', input: '<a href="javascript:alert(1)">x</a>' },
  { name: 'data URI in href', input: '<a href="data:text/html,<script>alert(1)</script>">x</a>' },
  { name: 'iframe with srcdoc', input: '<iframe srcdoc="<script>alert(1)</script>"></iframe>' },
  { name: 'style expression', input: '<div style="background:url(javascript:alert(1))">x</div>' },
  { name: 'meta refresh', input: '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">' },
  { name: 'object embed', input: '<object data="javascript:alert(1)"></object>' },
  { name: 'embed src', input: '<embed src="javascript:alert(1)">' },
  { name: 'form action javascript', input: '<form action="javascript:alert(1)"><input type=submit></form>' },
  { name: 'onmouseover attr', input: '<div onmouseover="alert(1)">x</div>' },
  { name: 'onclick attr', input: '<button onclick="alert(1)">x</button>' },
  { name: 'entity-encoded script', input: '&#60;script&#62;alert(1)&#60;/script&#62;' },
  { name: 'UTF-7 script (historical)', input: '+ADw-script+AD4-alert(1)+ADw-/script+AD4-' },
  { name: 'null byte in tag', input: '<scr\0ipt>alert(1)</scr\0ipt>' },
  { name: 'newline in tag', input: '<scri\npt>alert(1)</scr\nipt>' },
  { name: 'uppercase SCRIPT', input: '<SCRIPT>alert(1)</SCRIPT>' },
  { name: 'mixed case iFRaMe', input: '<iFRaMe src="javascript:alert(1)"></iFRaMe>' },
  { name: 'style tag with @import', input: '<style>@import "javascript:alert(1)";</style>' },
];

describe('sanitize-html: XSS payload fuzz (#797)', () => {
  it.each(XSS_PAYLOADS)('neutralizes: $name', ({ input }) => {
    const output = stripDangerousHtml(input);
    // Sanitized output must not contain any executable form of the payload.
    expect(output).not.toMatch(/<script/i);
    expect(output).not.toMatch(/javascript:/i);
    expect(output).not.toMatch(/on\w+\s*=/i);
    // Iframes are only allowed pointing at the allowlisted video hosts. Any
    // <iframe whose src is not one of those hosts (or has no src at all)
    // must not appear in the sanitized output.
    expect(output).not.toMatch(/<iframe(?![^>]*src="https:\/\/(www\.youtube\.com|youtube\.com|youtu\.be|microlearning\.opensap\.com|sapvideo\.cfapps\.eu10-004\.hana\.ondemand\.com))/i);
  });

  describe('allowlist positive cases', () => {
    it('preserves <a href="https://...">', () => {
      const out = stripDangerousHtml('<a href="https://example.com">x</a>');
      expect(out).toContain('href="https://example.com"');
    });

    it('preserves <code>', () => {
      const out = stripDangerousHtml('<code>x</code>');
      expect(out).toContain('<code>');
    });

    it('preserves YouTube iframe (allowlisted host)', () => {
      const out = stripDangerousHtml('<iframe src="https://www.youtube.com/embed/x"></iframe>');
      expect(out).toContain('iframe');
      expect(out).toContain('youtube.com');
    });
  });
});
