import { describe, it, expect } from 'vitest';
import { mergeVolatile } from './hydrate';

describe('mergeVolatile', () => {
  const ssr = [
    { kind: 'tutorial', slug: 't1', title: 'T1', href: '/tutorials/t1' },
    { kind: 'tutorial', slug: 't2', title: 'T2', href: '/tutorials/t2' },
  ];
  it('appends volatile items, dedupes by kind+slug, caps at 8', () => {
    const volatile = [
      { kind: 'blog-post', slug: 'b1', title: 'B1', href: 'https://x/b1', isNew: true },
      { kind: 'tutorial', slug: 't1', title: 'T1', href: '/tutorials/t1' }, // dup — dropped
    ];
    const out = mergeVolatile(ssr, volatile, 8);
    expect(out.filter(i => i.kind === 'blog-post').length).toBe(1);
    expect(out.filter(i => i.slug === 't1').length).toBe(1);
    expect(out.length).toBeLessThanOrEqual(8);
  });
  it('returns SSR unchanged when volatile is empty', () => {
    expect(mergeVolatile(ssr, [], 8)).toEqual(ssr);
  });
});
