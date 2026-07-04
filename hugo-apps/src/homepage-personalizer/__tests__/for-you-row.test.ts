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
});
