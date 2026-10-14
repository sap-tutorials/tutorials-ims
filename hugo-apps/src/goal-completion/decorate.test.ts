// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { decorateMarkers } from './decorate';

function fixture() {
  document.body.innerHTML = `
    <div class="group-card">
      <div class="group-card-header">
        <span class="group-meta">2 Tutorials</span>
        <span class="group-completion" data-group-slugs='["tut-a","tut-b"]'></span>
      </div>
      <ol class="group-tutorials">
        <li class="tutorial-item"><span class="tutorial-number" data-slug="tut-a">1</span></li>
        <li class="tutorial-item"><span class="tutorial-number" data-slug="tut-b">2</span></li>
      </ol>
    </div>
    <div class="group-card">
      <div class="group-card-header">
        <span class="group-completion" data-group-slugs='["tut-c"]'></span>
      </div>
      <ol class="group-tutorials">
        <li class="tutorial-item"><span class="tutorial-number" data-slug="tut-c">1</span></li>
      </ol>
    </div>`;
  return document.body;
}

describe('decorateMarkers', () => {
  it('marks completed tutorial numbers with the completed class + check, leaves others plain', () => {
    const root = fixture();
    decorateMarkers(root, ['tut-a', 'tut-c']);
    const a = root.querySelector('.tutorial-number[data-slug="tut-a"]')!;
    const b = root.querySelector('.tutorial-number[data-slug="tut-b"]')!;
    const c = root.querySelector('.tutorial-number[data-slug="tut-c"]')!;
    expect(a.classList.contains('completed')).toBe(true);
    expect(a.textContent).toBe('✓');
    expect(a.getAttribute('data-number')).toBe('1');
    expect(b.classList.contains('completed')).toBe(false);
    expect(b.textContent).toBe('2');          // untouched plain number
    expect(c.classList.contains('completed')).toBe(true);
  });

  it('labels group N of M complete, with a check only when the whole group is done', () => {
    const root = fixture();
    decorateMarkers(root, ['tut-a', 'tut-c']); // group1: 1/2, group2: 1/1
    const g1 = root.querySelectorAll('.group-completion')[0];
    const g2 = root.querySelectorAll('.group-completion')[1];
    expect(g1.textContent).toBe('1 of 2 complete');
    expect(g1.classList.contains('group-completion--complete')).toBe(false);
    expect(g2.textContent).toBe('✓ 1 of 1 complete');
    expect(g2.classList.contains('group-completion--complete')).toBe(true);
  });

  it('case-insensitive slug match', () => {
    const root = fixture();
    decorateMarkers(root, ['TUT-A']);
    expect(root.querySelector('.tutorial-number[data-slug="tut-a"]')!.classList.contains('completed')).toBe(true);
  });

  it('empty completedSlugs leaves everything plain (anonymous / no progress)', () => {
    const root = fixture();
    const r = decorateMarkers(root, []);
    expect(r.tutorialsMarked).toBe(0);
    expect(root.querySelector('.tutorial-number[data-slug="tut-a"]')!.textContent).toBe('1');
    expect(root.querySelectorAll('.group-completion')[0].textContent).toBe('0 of 2 complete');
  });

  it('also decorates group-body .timeline-circle markers', () => {
    document.body.innerHTML = `
      <div class="timeline-item"><span class="timeline-circle" data-slug="tut-x">1</span></div>
      <div class="timeline-item"><span class="timeline-circle" data-slug="tut-y">2</span></div>`;
    decorateMarkers(document.body, ['tut-x']);
    const x = document.querySelector('.timeline-circle[data-slug="tut-x"]')!;
    const y = document.querySelector('.timeline-circle[data-slug="tut-y"]')!;
    expect(x.classList.contains('completed')).toBe(true);
    expect(x.textContent).toBe('✓');
    expect(y.classList.contains('completed')).toBe(false);
    expect(y.textContent).toBe('2');
  });
});
