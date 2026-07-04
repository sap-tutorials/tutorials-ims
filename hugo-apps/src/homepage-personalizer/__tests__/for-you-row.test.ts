// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mountForYou } from '../mount-for-you';

beforeEach(() => {
  document.body.innerHTML = '<section class="for-you-row" data-personalize="for-you" hidden></section>';
});

describe('mountForYou', () => {
  const root = () => document.querySelector<HTMLElement>('[data-personalize="for-you"]')!;

  it('stays hidden with fewer than 3 items', () => {
    mountForYou(root(), [
      { ID: '1', kind: 'tutorial', slug: 'a', title: 'A', description: '', imageUrl: '' },
      { ID: '2', kind: 'tutorial', slug: 'b', title: 'B', description: '', imageUrl: '' },
    ]);
    expect(root().hidden).toBe(true);
  });

  it('renders and unhides with 3+ items', () => {
    mountForYou(root(), [
      { ID: '1', kind: 'tutorial', slug: 'a', title: 'A', description: '', imageUrl: '' },
      { ID: '2', kind: 'tutorial', slug: 'b', title: 'B', description: '', imageUrl: '' },
      { ID: '3', kind: 'tutorial', slug: 'c', title: 'C', description: '', imageUrl: '' },
    ]);
    expect(root().hidden).toBe(false);
    expect(root().querySelectorAll('a').length).toBe(3);
  });

  // Regression: XSS via javascript:/data:/vbscript: URLs in admin-authored
  // For-you candidates. linkFor() must drop unsafe kinds/schemes entirely
  // (the <li v-if=linkFor> gate removes the whole item from the DOM).
  it('drops items whose resolved link is not http(s)', async () => {
    mountForYou(root(), [
      { ID: '1', kind: 'tutorial', slug: 'safe-a', title: 'A', description: '', imageUrl: '' },
      { ID: '2', kind: 'shelf',    slug: 'javascript:alert(1)', title: 'JS', description: '', imageUrl: '' },
      { ID: '3', kind: 'tutorial', slug: 'safe-b', title: 'B', description: '', imageUrl: '' },
      { ID: '4', kind: 'blog',     slug: 'data:text/html,<script>alert(1)</script>', title: 'Data', description: '', imageUrl: '' },
      { ID: '5', kind: 'tutorial', slug: 'safe-c', title: 'C', description: '', imageUrl: '' },
      { ID: '6', kind: 'unknown-kind', slug: '/tutorials/x/', title: 'X', description: '', imageUrl: '' },
    ]);
    // Wait a tick for Vue to render.
    await new Promise((r) => setTimeout(r, 0));

    const links = root().querySelectorAll('a');
    expect(links.length).toBe(3); // only the three safe-* tutorials remain

    for (const a of Array.from(links)) {
      const href = a.getAttribute('href') || '';
      expect(href.startsWith('/') || href.startsWith('https://') || href.startsWith('http://')).toBe(true);
      expect(href.startsWith('javascript:')).toBe(false);
      expect(href.startsWith('data:')).toBe(false);
    }
  });
});
