// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { applyShelfRerank } from '../shelf-rerank';

beforeEach(() => {
  document.body.innerHTML = `
    <section data-personalize="shelf-rerank" data-verb="learn" data-shelf="start_here">
      <ul>
        <li data-shelf-entry-id="e1">E1</li>
        <li data-shelf-entry-id="e2">E2</li>
        <li data-shelf-entry-id="e3">E3</li>
      </ul>
    </section>`;
});

describe('applyShelfRerank', () => {
  it('reorders entries', () => {
    applyShelfRerank({ learn: { reorder: ['e3','e1','e2'], hidden: [] } }, 'learn');
    const got = [...document.querySelectorAll('li')].map(li => li.getAttribute('data-shelf-entry-id'));
    expect(got).toEqual(['e3','e1','e2']);
  });

  it('hides entries listed in hidden', () => {
    applyShelfRerank({ learn: { reorder: [], hidden: ['e2'] } }, 'learn');
    expect(document.querySelector<HTMLElement>('[data-shelf-entry-id="e2"]')!.hidden).toBe(true);
  });

  it('does nothing when currentVerb differs', () => {
    applyShelfRerank({ learn: { reorder: ['e3','e1','e2'], hidden: [] } }, 'build');
    const got = [...document.querySelectorAll('li')].map(li => li.getAttribute('data-shelf-entry-id'));
    expect(got).toEqual(['e1','e2','e3']);
  });
});
