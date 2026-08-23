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

describe('reading-prefs attrs (#1966 batch 2)', () => {
  beforeEach(() => {
    window.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} } as any);
    localStorage.clear();
    document.documentElement.removeAttribute('data-tut-text-size');
    document.documentElement.removeAttribute('data-tut-read-width');
    document.documentElement.removeAttribute('data-tut-code-size');
    document.documentElement.removeAttribute('data-tut-code-wrap');
    document.documentElement.removeAttribute('data-tut-img-size');
    document.documentElement.removeAttribute('data-tut-img-collapse');
    document.documentElement.removeAttribute('data-tut-reduce-motion');
    document.documentElement.removeAttribute('data-tut-readable-font');
  });

  it('applies reading-prefs attrs from storage (pass-through, no short-viewport effect)', () => {
    localStorage.setItem('tut.pref.textSize', 'l');
    localStorage.setItem('tut.pref.readWidth', 'narrow');
    localStorage.setItem('tut.pref.codeSize', 's');
    localStorage.setItem('tut.pref.codeWrap', 'on');
    localStorage.setItem('tut.pref.imgSize', 's');
    localStorage.setItem('tut.pref.imgCollapse', 'on');
    localStorage.setItem('tut.pref.reduceMotion', 'on');
    localStorage.setItem('tut.pref.readableFont', 'on');
    applyDisplayChrome(document);
    const el = document.documentElement;
    expect(el.getAttribute('data-tut-text-size')).toBe('l');
    expect(el.getAttribute('data-tut-read-width')).toBe('narrow');
    expect(el.getAttribute('data-tut-code-size')).toBe('s');
    expect(el.getAttribute('data-tut-code-wrap')).toBe('on');
    expect(el.getAttribute('data-tut-img-size')).toBe('s');
    expect(el.getAttribute('data-tut-img-collapse')).toBe('on');
    expect(el.getAttribute('data-tut-reduce-motion')).toBe('on');
    expect(el.getAttribute('data-tut-readable-font')).toBe('on');
  });

  it('reading-prefs use defaults when unset', () => {
    applyDisplayChrome(document);
    const el = document.documentElement;
    expect(el.getAttribute('data-tut-text-size')).toBe('m');
    expect(el.getAttribute('data-tut-img-size')).toBe('l');
    expect(el.getAttribute('data-tut-read-width')).toBe('full');
    expect(el.getAttribute('data-tut-code-wrap')).toBe('off');
  });

  it('applies super-wide read width from storage', () => {
    localStorage.setItem('tut.pref.readWidth', 'wide');
    applyDisplayChrome(document);
    expect(document.documentElement.getAttribute('data-tut-read-width')).toBe('wide');
  });
});
