// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { applyVerbOrder } from '../verb-order';

function setup(order: string[]) {
  document.body.innerHTML = `
    <section data-personalize="verb-order">
      <ul>${order.map(v => `<li data-verb="${v}">${v}</li>`).join('')}</ul>
    </section>`;
  return document.querySelector<HTMLElement>('[data-personalize="verb-order"]')!;
}

describe('applyVerbOrder', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('reorders children by data-verb', () => {
    const root = setup(['learn','build','integrate','operate','ai','connect']);
    applyVerbOrder(root, ['build','learn','integrate','ai','operate','connect']);
    const got = [...root.querySelectorAll('li')].map(li => li.getAttribute('data-verb'));
    expect(got).toEqual(['build','learn','integrate','ai','operate','connect']);
  });

  it('is a no-op when order is empty', () => {
    const root = setup(['learn','build','integrate','operate','ai','connect']);
    applyVerbOrder(root, []);
    const got = [...root.querySelectorAll('li')].map(li => li.getAttribute('data-verb'));
    expect(got).toEqual(['learn','build','integrate','operate','ai','connect']);
  });

  it('does not throw when root is null', () => {
    expect(() => applyVerbOrder(null, ['build'])).not.toThrow();
  });

  it('preserves DOM identity (same element reference after reorder)', () => {
    const root = setup(['learn','build','integrate','operate','ai','connect']);
    const before = [...root.querySelectorAll('li')];
    applyVerbOrder(root, ['build','learn','integrate','ai','operate','connect']);
    const after = [...root.querySelectorAll('li')];
    // Same element objects — just reordered
    expect(after[0]).toBe(before[1]); // build was index 1
    expect(after[1]).toBe(before[0]); // learn was index 0
  });
});
