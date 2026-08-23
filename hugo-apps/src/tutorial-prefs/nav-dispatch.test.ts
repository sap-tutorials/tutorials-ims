// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { dispatchNav } from './nav-dispatch';

// Hand gestures drive intra-tutorial step navigation via the layout-provided
// window.opStepNav(dir) hook. These tests pin that contract so a future rename
// fails here before gestures silently break (the old fixture clicked the
// tutorial Prev/Next pills, which was the wrong target — gestures moved
// between tutorials instead of between steps).
declare global {
  // eslint-disable-next-line no-var
  var opStepNav: ((dir: 'next' | 'prev') => boolean) | undefined;
}

describe('nav-dispatch (intra-tutorial step navigation)', () => {
  afterEach(() => { delete (globalThis as { opStepNav?: unknown }).opStepNav; });

  it('delegates to window.opStepNav with the requested direction', () => {
    const spy = vi.fn().mockReturnValue(true);
    globalThis.opStepNav = spy;

    expect(dispatchNav('next')).toBe(true);
    expect(spy).toHaveBeenCalledWith('next');

    dispatchNav('prev');
    expect(spy).toHaveBeenLastCalledWith('prev');
  });

  it('returns false at a boundary (opStepNav reports no move)', () => {
    globalThis.opStepNav = vi.fn().mockReturnValue(false);
    expect(dispatchNav('next')).toBe(false);
  });

  it('is a safe no-op when the layout hook is absent', () => {
    delete (globalThis as { opStepNav?: unknown }).opStepNav;
    expect(() => dispatchNav('next')).not.toThrow();
    expect(dispatchNav('next')).toBe(false);
  });
});
