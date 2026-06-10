import { describe, it, expect } from 'vitest';
import { slugifyKey } from '../srv/lib/branch/slug-key.js';

describe('slugifyKey', () => {
  it('lowercases', () => {
    expect(slugifyKey('HANA Cloud')).toBe('hana-cloud');
  });

  it('replaces non-alnum with hyphens', () => {
    expect(slugifyKey('On / Prem!!')).toBe('on-prem');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugifyKey('---foo---')).toBe('foo');
  });

  it('caps at 40 chars', () => {
    const long = 'a'.repeat(80);
    expect(slugifyKey(long)).toHaveLength(40);
  });

  it('handles non-string input via String coercion', () => {
    expect(slugifyKey(null)).toBe('null');
    expect(slugifyKey(123)).toBe('123');
  });
});
