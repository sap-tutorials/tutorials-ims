// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchNav, hasNext, hasPrev } from './nav-dispatch';
import { SEL_NAV_NEXT, SEL_NAV_PREV } from './constants';

function setupStepNav({ next, prev }: { next: boolean; prev: boolean }) {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

  const wrap = document.createElement('div');
  wrap.className = 'tutorial-stepnav';
  wrap.setAttribute('role', 'navigation');

  const inner = document.createElement('div');
  inner.className = 'tutorial-stepnav__inner';
  wrap.appendChild(inner);

  const prevSlot = document.createElement('div');
  prevSlot.className = 'tutorial-stepnav__slot tutorial-stepnav__slot--prev';
  if (prev) {
    const a = document.createElement('a');
    a.className = 'nav-pill';
    a.setAttribute('href', '/tutorials/prev');
    a.appendChild(document.createTextNode('Previous'));
    prevSlot.appendChild(a);
  }
  inner.appendChild(prevSlot);

  const nextSlot = document.createElement('div');
  nextSlot.className = 'tutorial-stepnav__slot tutorial-stepnav__slot--next';
  if (next) {
    const a = document.createElement('a');
    a.className = 'nav-pill nav-pill--primary';
    a.setAttribute('href', '/tutorials/next');
    a.appendChild(document.createTextNode('Next'));
    nextSlot.appendChild(a);
  }
  inner.appendChild(nextSlot);

  document.body.appendChild(wrap);
}

describe('nav-dispatch', () => {
  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  });

  it('hasNext / hasPrev reflect DOM state', () => {
    setupStepNav({ next: true, prev: false });
    expect(hasNext()).toBe(true);
    expect(hasPrev()).toBe(false);
  });

  it('dispatchNav("next") clicks the next pill', () => {
    setupStepNav({ next: true, prev: true });
    const next = document.querySelector(SEL_NAV_NEXT) as HTMLAnchorElement;
    const click = vi.spyOn(next, 'click').mockImplementation(() => {});
    dispatchNav('next');
    expect(click).toHaveBeenCalledOnce();
  });

  it('dispatchNav("prev") clicks the prev pill', () => {
    setupStepNav({ next: true, prev: true });
    const prev = document.querySelector(SEL_NAV_PREV) as HTMLAnchorElement;
    const click = vi.spyOn(prev, 'click').mockImplementation(() => {});
    dispatchNav('prev');
    expect(click).toHaveBeenCalledOnce();
  });

  it('dispatchNav is a no-op when target is missing', () => {
    setupStepNav({ next: false, prev: false });
    expect(() => dispatchNav('next')).not.toThrow();
    expect(() => dispatchNav('prev')).not.toThrow();
  });
});
