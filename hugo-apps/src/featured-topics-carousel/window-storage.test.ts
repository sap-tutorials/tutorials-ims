//
// @vitest-environment happy-dom
//
import { describe, it, expect, beforeEach } from 'vitest';
import { readLocalStorageWindow, writeLocalStorageWindow, DEFAULT_WINDOW, WINDOW_OPTIONS } from './window-storage';

describe('window-storage', () => {
  beforeEach(() => localStorage.clear());

  it('exposes 90/180/360 with a 180 default', () => {
    expect([...WINDOW_OPTIONS]).toEqual([90, 180, 360]);
    expect(DEFAULT_WINDOW).toBe(180);
  });

  it('round-trips a valid window', () => {
    writeLocalStorageWindow(360);
    expect(readLocalStorageWindow()).toBe(360);
  });

  it('returns null for an unset or invalid value', () => {
    expect(readLocalStorageWindow()).toBeNull();
    localStorage.setItem('sap-devs-homepage-top-tutorials-window', '45');
    expect(readLocalStorageWindow()).toBeNull();
  });
});
