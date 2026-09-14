import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../markdown.js';

describe('renderMarkdown (shared admin-description renderer, #2296)', () => {
  it('renders Markdown syntax to formatted HTML', () => {
    const html = renderMarkdown('**bold** and [link](https://example.com)');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<a href="https://example.com">link</a>');
    expect(html).not.toContain('**');
  });

  it('escapes raw HTML in the source (html:false — no injection)', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('coerces null/undefined/empty to an empty string', () => {
    expect(renderMarkdown(null)).toBe('');
    expect(renderMarkdown(undefined)).toBe('');
    expect(renderMarkdown('')).toBe('');
  });
});
