import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkHugoSafeHtml } = require('../../../scripts/check-hugo-safe-html.cjs');

describe('check-hugo-safe-html guard (#797)', () => {
  it('passes when safeHTML has adjacent security-reviewed marker', () => {
    const files = new Map([
      ['x.html', '<!-- security-reviewed: trusted source -->\n{{ .Bio | safeHTML }}\n'],
    ]);
    expect(checkHugoSafeHtml(files)).toEqual({ ok: true, findings: [] });
  });

  it('flags safeHTML without adjacent marker', () => {
    const files = new Map([
      ['x.html', '<div>{{ .Bio | safeHTML }}</div>\n'],
    ]);
    const result = checkHugoSafeHtml(files);
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ file: 'x.html', line: 1 });
  });

  it('flags safeHTMLAttr without adjacent marker', () => {
    const files = new Map([
      ['x.html', '<a href="{{ .Url | safeHTMLAttr }}">x</a>\n'],
    ]);
    expect(checkHugoSafeHtml(files).ok).toBe(false);
  });

  it('flags printf "<%s>" pattern without adjacent marker', () => {
    const files = new Map([
      ['x.html', '{{ printf "<a href=\'%s\'>x</a>" .Url }}\n'],
    ]);
    expect(checkHugoSafeHtml(files).ok).toBe(false);
  });

  it('accepts multiple safeHTML if each has a marker on line above', () => {
    const files = new Map([
      ['x.html', '<!-- security-reviewed: a -->\n{{ .A | safeHTML }}\n<!-- security-reviewed: b -->\n{{ .B | safeHTML }}\n'],
    ]);
    expect(checkHugoSafeHtml(files).ok).toBe(true);
  });

  it('marker must be within 3 lines above (not stale from earlier in file)', () => {
    const files = new Map([
      ['x.html', '<!-- security-reviewed: old -->\n<p>lots</p>\n<p>of</p>\n<p>lines</p>\n{{ .X | safeHTML }}\n'],
    ]);
    expect(checkHugoSafeHtml(files).ok).toBe(false);
  });

  it('accepts Hugo template-comment marker style in .xml (sitemap pattern)', () => {
    const files = new Map([
      ['sitemap.xml', '{{- /* security-reviewed: static XML declaration string; no user input */ -}}\n{{- printf "<?xml version=\\"1.0\\" encoding=\\"utf-8\\" standalone=\\"yes\\"?>" | safeHTML }}\n'],
    ]);
    expect(checkHugoSafeHtml(files)).toEqual({ ok: true, findings: [] });
  });
});
