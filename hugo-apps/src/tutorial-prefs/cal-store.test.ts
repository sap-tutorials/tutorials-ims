// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { getCal, setCal, clearCal, isCalPrompted, markCalPrompted } from './prefs-store';
import { KEY_CAL_EYE, CAL_PROFILE_VERSION, type EyeProfile } from './constants';

describe('calibration store', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips an eye profile', () => {
    const p: EyeProfile = { v: CAL_PROFILE_VERSION, gazeMin: 0.1, gazeMax: 0.6 };
    setCal('eye', p);
    expect(getCal('eye')).toEqual(p);
  });

  it('returns null when absent', () => {
    expect(getCal('hand')).toBeNull();
  });

  it('returns null on parse failure', () => {
    localStorage.setItem(KEY_CAL_EYE, 'not json');
    expect(getCal('eye')).toBeNull();
  });

  it('returns null on version mismatch', () => {
    localStorage.setItem(KEY_CAL_EYE, JSON.stringify({ v: 99, gazeMin: 0, gazeMax: 1 }));
    expect(getCal('eye')).toBeNull();
  });

  it('clearCal removes the profile', () => {
    setCal('eye', { v: CAL_PROFILE_VERSION, gazeMin: 0, gazeMax: 1 });
    clearCal('eye');
    expect(getCal('eye')).toBeNull();
  });

  it('cal-prompted flag round-trips', () => {
    expect(isCalPrompted('eye')).toBe(false);
    markCalPrompted('eye');
    expect(isCalPrompted('eye')).toBe(true);
  });
});
