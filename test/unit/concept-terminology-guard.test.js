import { describe, it, expect } from 'vitest';
import { validateTerminology, STALE_TERMS } from '../../srv/lib/concept-terminology-guard.js';

describe('validateTerminology (#2426)', () => {
  it('flags deprecated "Open SQL" and names the canonical replacement', () => {
    const r = validateTerminology('Use Open SQL to read data.');
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([{ stale: 'Open SQL', canonical: 'ABAP SQL' }]);
  });

  it('is case-insensitive', () => {
    expect(validateTerminology('open sql').ok).toBe(false);
    expect(validateTerminology('OPEN SQL').ok).toBe(false);
  });

  it('passes clean current terminology', () => {
    const r = validateTerminology('ABAP SQL reads and changes data in the database.');
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('does not false-positive on substrings (word boundaries)', () => {
    // "opensql" without the space, or unrelated words, must not match.
    expect(validateTerminology('the opensqlite driver').ok).toBe(true);
  });

  it('handles null/undefined input', () => {
    expect(validateTerminology(null).ok).toBe(true);
    expect(validateTerminology(undefined).ok).toBe(true);
  });

  it('exposes a frozen term map', () => {
    expect(Object.isFrozen(STALE_TERMS)).toBe(true);
  });
});
