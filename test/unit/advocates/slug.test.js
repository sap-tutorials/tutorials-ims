import { describe, expect, it } from 'vitest';
import { deriveSlug, suffixOnCollision } from '../../../srv/lib/advocate-slug.js';

describe('deriveSlug', () => {
  it('lowercases simple ASCII names', () => {
    expect(deriveSlug('Thomas', 'Jung')).toBe('thomas-jung');
  });

  it('strips diacritics on European names', () => {
    expect(deriveSlug('André', 'Müller')).toBe('andre-muller');
  });

  it('collapses internal whitespace and punctuation to single dashes', () => {
    expect(deriveSlug('Mary Jo', 'OBrien-Smith')).toBe('mary-jo-obrien-smith');
  });

  it('trims leading and trailing dashes', () => {
    expect(deriveSlug('-- Test --', '--')).toBe('test');
  });

  it('falls back to a placeholder when both names produce empty slug', () => {
    expect(deriveSlug('陈', '伟')).toBe('advocate');
  });

  it('keeps slug at or under 64 chars without trailing dash', () => {
    const slug = deriveSlug('Christopher', 'Stoltzenberg-Williams-Johnson');
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('suffixOnCollision', () => {
  it('returns base when not present', () => {
    expect(suffixOnCollision('thomas-jung', new Set())).toBe('thomas-jung');
  });

  it('appends -2 on first collision', () => {
    expect(suffixOnCollision('thomas-jung', new Set(['thomas-jung']))).toBe('thomas-jung-2');
  });

  it('continues to -3, -4 on further collisions', () => {
    const taken = new Set(['thomas-jung', 'thomas-jung-2']);
    expect(suffixOnCollision('thomas-jung', taken)).toBe('thomas-jung-3');
  });

  it('respects the 64-char limit when adding suffix', () => {
    const long = 'a'.repeat(63);
    const out = suffixOnCollision(long, new Set([long]));
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out.endsWith('-2')).toBe(true);
  });
});
