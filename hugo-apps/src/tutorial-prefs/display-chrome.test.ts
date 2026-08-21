// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { computeEffective, applyDisplayChrome, installAutoHide, type DisplayPrefs } from './display-chrome';

const NONE: DisplayPrefs = { header: null, footer: null, breadcrumbs: 'on', feedback: 'on' };

describe('computeEffective (#1966)', () => {
  it('tall viewport, no prefs → locked/shown', () => {
    expect(computeEffective(NONE, false)).toEqual({ header: 'locked', footer: 'shown', breadcrumbs: 'on', feedback: 'on' });
  });
  it('short viewport, no prefs → thinbar/autohide', () => {
    expect(computeEffective(NONE, true)).toEqual({ header: 'thinbar', footer: 'autohide', breadcrumbs: 'on', feedback: 'on' });
  });
  it('explicit prefs override the short-viewport default', () => {
    const e = computeEffective({ header: 'locked', footer: 'shown', breadcrumbs: 'off', feedback: 'off' }, true);
    expect(e).toEqual({ header: 'locked', footer: 'shown', breadcrumbs: 'off', feedback: 'off' });
  });
});

describe('applyDisplayChrome (#1966)', () => {
  beforeEach(() => {
    // Stub matchMedia so isShortViewport() returns false (tall viewport) deterministically
    window.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} } as any);
    localStorage.clear();
    document.documentElement.removeAttribute('data-tut-header');
    document.documentElement.removeAttribute('data-tut-footer');
  });
  it('writes effective attributes from stored prefs', () => {
    localStorage.setItem('tut.pref.header', 'autohide');
    localStorage.setItem('tut.pref.breadcrumbs', 'off');
    applyDisplayChrome(document);
    const html = document.documentElement;
    expect(html.getAttribute('data-tut-header')).toBe('autohide');
    expect(html.getAttribute('data-tut-breadcrumbs')).toBe('off');
    // footer unset + happy-dom viewport not short → 'shown'
    expect(html.getAttribute('data-tut-footer')).toBe('shown');
    expect(html.getAttribute('data-tut-feedback')).toBe('on');
  });
});

describe('installAutoHide (#1966)', () => {
  beforeEach(() => {
    window.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} } as any);
    localStorage.clear();
    document.documentElement.removeAttribute('data-tut-header-hidden');
  });

  it('returns a teardown function and does not throw', () => {
    localStorage.setItem('tut.pref.header', 'autohide');
    applyDisplayChrome(document);
    const teardown = installAutoHide(document);
    expect(typeof teardown).toBe('function');
    // Simulate a downward scroll; header-hidden should be set for autohide mode.
    Object.defineProperty(window, 'scrollY', { value: 400, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    expect(document.documentElement.getAttribute('data-tut-header-hidden')).toBe('');
    // Scroll back to top → shown.
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    expect(document.documentElement.hasAttribute('data-tut-header-hidden')).toBe(false);
    teardown();
  });

  it('does not hide the header when effective header is not autohide', () => {
    // no pref, tall viewport → locked
    applyDisplayChrome(document);
    const teardown = installAutoHide(document);
    Object.defineProperty(window, 'scrollY', { value: 400, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    expect(document.documentElement.hasAttribute('data-tut-header-hidden')).toBe(false);
    teardown();
  });
});
