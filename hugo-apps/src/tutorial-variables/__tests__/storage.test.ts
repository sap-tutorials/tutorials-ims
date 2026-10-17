// @vitest-environment happy-dom
//
// Task 6 — tutorial-variables island
// Unit tests for readValue / writeValue in storage.ts.
// happy-dom provides a real in-memory localStorage implementation.

import { describe, it, expect, beforeEach } from 'vitest';
import { readValue, writeValue } from '../storage';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function clearStorage() {
  localStorage.clear();
}

// ──────────────────────────────────────────────────────────────────────────────
// writeValue + readValue
// ──────────────────────────────────────────────────────────────────────────────

describe('storage: readValue / writeValue', () => {
  beforeEach(clearStorage);

  // ── mission carry-over ──────────────────────────────────────────────────────

  it('carries a value across tutorials within the same mission', () => {
    // Write from tutorial t1 in mission m1
    writeValue('groupNumber', '007', { missionSlug: 'm1', tutorialSlug: 't1' });

    // Read from a DIFFERENT tutorial t2 in the SAME mission m1 — must return the value
    const result = readValue('groupNumber', { missionSlug: 'm1', tutorialSlug: 't2' });
    expect(result).toBe('007');
  });

  // ── per-tutorial isolation ───────────────────────────────────────────────────

  it('stores and reads back a per-tutorial value when no missionSlug is given', () => {
    writeValue('groupNumber', '42', { tutorialSlug: 't1' });

    const result = readValue('groupNumber', { tutorialSlug: 't1' });
    expect(result).toBe('42');
  });

  it('returns null when reading a DIFFERENT tutorial with no missionSlug', () => {
    writeValue('groupNumber', '42', { tutorialSlug: 't1' });

    const result = readValue('groupNumber', { tutorialSlug: 't2' });
    expect(result).toBeNull();
  });

  // ── mission key beats tutorial key ──────────────────────────────────────────

  it('returns the mission-scoped value when both mission and tutorial keys are set', () => {
    // Manually plant two different values
    localStorage.setItem('tutvar:m1:x', 'mission-value');
    localStorage.setItem('tutvar:t1:x', 'tutorial-value');

    const result = readValue('x', { missionSlug: 'm1', tutorialSlug: 't1' });
    expect(result).toBe('mission-value');
  });

  // ── readValue returns null when nothing stored ───────────────────────────────

  it('returns null when no value has been stored', () => {
    expect(readValue('unknown', { tutorialSlug: 'any' })).toBeNull();
  });

  // ── writeValue writes BOTH keys when missionSlug is present ─────────────────

  it('writes both tutorial key and mission key when missionSlug is supplied', () => {
    writeValue('name', 'Tom', { missionSlug: 'ms', tutorialSlug: 'ts' });

    expect(localStorage.getItem('tutvar:ms:name')).toBe('Tom');
    expect(localStorage.getItem('tutvar:ts:name')).toBe('Tom');
  });

  it('writes ONLY the tutorial key when missionSlug is absent', () => {
    writeValue('name', 'Tom', { tutorialSlug: 'ts' });

    expect(localStorage.getItem('tutvar:ts:name')).toBe('Tom');
    // No mission key should exist
    expect(localStorage.getItem('tutvar::name')).toBeNull();
  });

  // ── empty string missionSlug is treated as absent ───────────────────────────

  it('treats an empty string missionSlug as no mission (does not write mission key)', () => {
    writeValue('name', 'Tom', { missionSlug: '', tutorialSlug: 'ts' });

    expect(localStorage.getItem('tutvar:ts:name')).toBe('Tom');
    expect(localStorage.getItem('tutvar::name')).toBeNull();
  });

  it('treats an empty string missionSlug as no mission for readValue (falls through to tutorial key)', () => {
    localStorage.setItem('tutvar:ts:name', 'Tom');

    const result = readValue('name', { missionSlug: '', tutorialSlug: 'ts' });
    expect(result).toBe('Tom');
  });
});
