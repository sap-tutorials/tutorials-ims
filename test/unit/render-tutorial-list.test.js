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
      { title: 'A', slug: 'a', tutorialId: '11111111-1111-1111-1111-111111111111', reviewedDate: '2025-01-01T00:00:00.000Z' },
      { title: 'B', slug: 'b', tutorialId: '22222222-2222-2222-2222-222222222222', reviewedDate: '2025-02-15T00:00:00.000Z' },
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
      [{ title: '<script>alert(1)</script>', slug: 's', tutorialId: 'aaaaaaaa-0000-0000-0000-000000000000', reviewedDate: '2025-01-01' }],
      dashboardUrl
    );
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  // The admin-shell router keys the Tutorials Object Page by UUID, not slug —
  // the deep link must match the working "<outerRoute>&/<prefix>/<Entity>(<key>)"
  // hash format (mirrors the shell's own homepageConfig/petoberfestContests
  // deep links). A "#/tutorial/<slug>" hash matches NO route and lands the
  // recipient on a blank screen (#622 regression — the slug hash was invented
  // in the design spec and never verified against the real router).
  it('builds a UUID-keyed Fiori Object Page deep link', () => {
    const html = renderTutorialList(
      [{ title: 'X', slug: 's', tutorialId: '9f3ca1e0-1234-4abc-8def-000000000e21', reviewedDate: '2025-01-01' }],
      'https://custom.example/foo'
    );
    expect(html).toContain(
      'href="https://custom.example/foo#tutorials&/tu/Tutorials(9f3ca1e0-1234-4abc-8def-000000000e21)"'
    );
    expect(html).not.toContain('#/tutorial/');
  });

  it('falls back to em-dash when reviewedDate is null', () => {
    const html = renderTutorialList(
      [{ title: 'X', slug: 's', tutorialId: 'bbbbbbbb-0000-0000-0000-000000000000', reviewedDate: null }],
      dashboardUrl
    );
    expect(html).toContain('last reviewed —');
  });

  it('HTML-escapes dashboardUrl', () => {
    const html = renderTutorialList(
      [{ title: 'X', slug: 's', tutorialId: 'cccccccc-0000-0000-0000-000000000000', reviewedDate: '2025-01-01' }],
      'https://example.com/"><script>alert(1)</script>'
    );
    expect(html).not.toContain('"><script>alert');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('normalizes Date instance reviewedDate to YYYY-MM-DD', () => {
    const html = renderTutorialList(
      [{ title: 'X', slug: 's', tutorialId: 'dddddddd-0000-0000-0000-000000000000', reviewedDate: new Date('2025-01-01T00:00:00Z') }],
      dashboardUrl
    );
    expect(html).toContain('last reviewed 2025-01-01');
    expect(html).not.toMatch(/last reviewed [A-Z][a-z]{2} /);
  });
});
