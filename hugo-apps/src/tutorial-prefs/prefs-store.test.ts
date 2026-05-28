// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getPref, setPref, getSession, addSession, removeSession,
  consumeFirstRun, isFirstRun
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
