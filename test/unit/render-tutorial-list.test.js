import { describe, it, expect } from 'vitest';
import { renderTutorialList, escapeHtml } from '../../srv/lib/contributor-notifications.js';

describe('escapeHtml', () => {
  it('escapes &, <, >, ", and \'', () => {
    expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml(`"hello"`)).toBe('&quot;hello&quot;');
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('handles null/undefined gracefully', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('renderTutorialList', () => {
  const dashboardUrl = 'https://example.com/dashboard';

  it('renders <ul> with one <li> per tutorial', () => {
    const html = renderTutorialList([
      { title: 'A', slug: 'a', reviewedDate: '2025-01-01T00:00:00.000Z' },
      { title: 'B', slug: 'b', reviewedDate: '2025-02-15T00:00:00.000Z' },
    ], dashboardUrl);
    expect(html).toMatch(/^<ul>/);
    expect(html).toMatch(/<\/ul>$/);
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain('>A</a>');
    expect(html).toContain('>B</a>');
    expect(html).toContain('2025-01-01');
    expect(html).toContain('2025-02-15');
  });

  it('HTML-escapes titles', () => {
    const html = renderTutorialList(
      [{ title: '<script>alert(1)</script>', slug: 's', reviewedDate: '2025-01-01' }],
      dashboardUrl
    );
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('URL-encodes slug in anchor href', () => {
    const html = renderTutorialList(
      [{ title: 'X', slug: 'has spaces & ampersand', reviewedDate: '2025-01-01' }],
      dashboardUrl
    );
    expect(html).toContain('has%20spaces%20%26%20ampersand');
  });

  it('preserves dashboardUrl', () => {
    const html = renderTutorialList(
      [{ title: 'X', slug: 's', reviewedDate: '2025-01-01' }],
      'https://custom.example/foo'
    );
    expect(html).toContain('href="https://custom.example/foo#/tutorial/s"');
  });

  it('falls back to em-dash when reviewedDate is null', () => {
    const html = renderTutorialList(
      [{ title: 'X', slug: 's', reviewedDate: null }],
      dashboardUrl
    );
    expect(html).toContain('last reviewed —');
  });

  it('HTML-escapes dashboardUrl', () => {
    const html = renderTutorialList(
      [{ title: 'X', slug: 's', reviewedDate: '2025-01-01' }],
      'https://example.com/"><script>alert(1)</script>'
    );
    expect(html).not.toContain('"><script>alert');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('normalizes Date instance reviewedDate to YYYY-MM-DD', () => {
    const html = renderTutorialList(
      [{ title: 'X', slug: 's', reviewedDate: new Date('2025-01-01T00:00:00Z') }],
      dashboardUrl
    );
    expect(html).toContain('last reviewed 2025-01-01');
    expect(html).not.toMatch(/last reviewed [A-Z][a-z]{2} /);
  });
});
