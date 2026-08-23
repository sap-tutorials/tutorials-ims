// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getPref, setPref, getSession, addSession, removeSession,
  consumeFirstRun, isFirstRun,
  getHeaderPref, setHeaderPref, getFooterPref, setFooterPref,
  getBreadcrumbsPref, setBreadcrumbsPref, getFeedbackPref, setFeedbackPref,
  getTextSize, setTextSize, getReadWidth, setReadWidth,
  getCodeSize, setCodeSize, getCodeWrap, setCodeWrap,
  getCopyClean, setCopyClean, getImgSize, setImgSize,
  getImgCollapse, setImgCollapse, getReduceMotion, setReduceMotion,
  getReadableFont, setReadableFont
} from './prefs-store';

describe('prefs-store', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

  it('defaults eye/hand prefs to off', () => {
    expect(getPref('eye')).toBe('off');
    expect(getPref('hand')).toBe('off');
  });

  it('round-trips eye pref', () => {
    setPref('eye', 'on');
    expect(getPref('eye')).toBe('on');
    setPref('eye', 'off');
    expect(getPref('eye')).toBe('off');
  });

  it('session marker is a set of features', () => {
    expect(getSession()).toEqual([]);
    addSession('eye');
    expect(getSession().sort()).toEqual(['eye']);
    addSession('hand');
    expect(getSession().sort()).toEqual(['eye', 'hand']);
    removeSession('eye');
    expect(getSession()).toEqual(['hand']);
    removeSession('hand');
    expect(getSession()).toEqual([]);
    expect(sessionStorage.getItem('tut.cam.session')).toBeNull();
  });

  it('firstRun is true once, then consumed', () => {
    expect(isFirstRun('eye')).toBe(true);
    consumeFirstRun('eye');
    expect(isFirstRun('eye')).toBe(false);
  });

  it('survives storage exceptions silently', () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('quota'); };
    expect(() => setPref('eye', 'on')).not.toThrow();
    Storage.prototype.setItem = orig;
  });
});

describe('prefs-store — display prefs (#1966)', () => {
  beforeEach(() => { localStorage.clear(); });

  it('header/footer default to null (unset) and round-trip', () => {
    expect(getHeaderPref()).toBeNull();
    expect(getFooterPref()).toBeNull();
    setHeaderPref('thinbar');
    setFooterPref('autohide');
    expect(getHeaderPref()).toBe('thinbar');
    expect(getFooterPref()).toBe('autohide');
  });

  it('header ignores invalid stored values', () => {
    localStorage.setItem('tut.pref.header', 'bogus');
    expect(getHeaderPref()).toBeNull();
  });

  it('breadcrumbs/feedback default to "on" and round-trip', () => {
    expect(getBreadcrumbsPref()).toBe('on');
    expect(getFeedbackPref()).toBe('on');
    setBreadcrumbsPref('off');
    setFeedbackPref('off');
    expect(getBreadcrumbsPref()).toBe('off');
    expect(getFeedbackPref()).toBe('off');
  });
});

describe('reading-prefs batch 2 store', () => {
  beforeEach(() => localStorage.clear());

  it('size prefs default correctly and round-trip', () => {
    expect(getTextSize()).toBe('m');
    expect(getCodeSize()).toBe('m');
    expect(getImgSize()).toBe('l'); // natural by default
    setTextSize('l'); setCodeSize('s'); setImgSize('s');
    expect(getTextSize()).toBe('l');
    expect(getCodeSize()).toBe('s');
    expect(getImgSize()).toBe('s');
  });

  it('invalid stored size falls back to default', () => {
    localStorage.setItem('tut.pref.textSize', 'xl');
    expect(getTextSize()).toBe('m');
  });

  it('readWidth defaults full and round-trips full/narrow/wide', () => {
    expect(getReadWidth()).toBe('full');
    setReadWidth('narrow');
    expect(getReadWidth()).toBe('narrow');
    setReadWidth('wide');
    expect(getReadWidth()).toBe('wide');
    setReadWidth('full');
    expect(getReadWidth()).toBe('full');
  });

  it('invalid stored readWidth falls back to full', () => {
    localStorage.setItem('tut.pref.readWidth', 'ultra');
    expect(getReadWidth()).toBe('full');
  });

  it('OnOff toggles default off and round-trip', () => {
    for (const [get, set] of [
      [getCodeWrap, setCodeWrap], [getCopyClean, setCopyClean],
      [getImgCollapse, setImgCollapse], [getReduceMotion, setReduceMotion],
      [getReadableFont, setReadableFont]
    ] as const) {
      expect(get()).toBe('off');
      set('on');
      expect(get()).toBe('on');
      localStorage.clear();
    }
  });
});
