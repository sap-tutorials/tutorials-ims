// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyTeaserRerank } from '../teaser-rerank';

function setup(slugs: string[]) {
  document.body.innerHTML = `
    <section data-personalize="teaser-rerank">
      <div class="cards">
        ${slugs.map(s => `<article data-slug="${s}">${s}</article>`).join('')}
      </div>
    </section>`;
  return document.querySelector<HTMLElement>('[data-personalize="teaser-rerank"]')!;
}

describe('applyTeaserRerank', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('reorders existing cards by slug', async () => {
    const root = setup(['a','b','c']);
    await applyTeaserRerank(root, ['c','a','b'], async () => []);
    const got = [...root.querySelectorAll('article')].map(a => a.getAttribute('data-slug'));
    expect(got).toEqual(['c','a','b']);
  });

  it('appends fetched cards for missing slugs', async () => {
    const root = setup(['a','b']);
    const fetchMissing = vi.fn(async () => [
      { slug: 'z', html: '<article data-slug="z">Z</article>' },
    ]);
    await applyTeaserRerank(root, ['a','b','z'], fetchMissing);
    expect(fetchMissing).toHaveBeenCalledWith(['z']);
    const got = [...root.querySelectorAll('article')].map(a => a.getAttribute('data-slug'));
    expect(got).toEqual(['a','b','z']);
  });

  it('is a no-op when order is empty', async () => {
    const root = setup(['a','b']);
    await applyTeaserRerank(root, [], async () => []);
    const got = [...root.querySelectorAll('article')].map(a => a.getAttribute('data-slug'));
    expect(got).toEqual(['a','b']);
  });
});
