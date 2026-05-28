import { describe, it, expect } from 'vitest';
import { slugify, ensureUniqueSlug } from '../srv/lib/slug-utils.js';

describe('slugify()', () => {
  it('lowercases and hyphenates plain ASCII', () => {
    expect(slugify('Test Group')).toBe('test-group');
    expect(slugify('Build a CAP App')).toBe('build-a-cap-app');
  });

  it('strips combining diacritics via NFKD normalization', () => {
    expect(slugify('Schöne Mission')).toBe('schone-mission');
    expect(slugify('Café au Lait')).toBe('cafe-au-lait');
  });

  it('collapses runs of non-alphanumerics to single hyphens', () => {
    expect(slugify('SAP S/4HANA — Cloud!!!')).toBe('sap-s-4hana-cloud');
    expect(slugify('a   b___c')).toBe('a-b-c');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugify('-leading-')).toBe('leading');
    expect(slugify('   spaced   ')).toBe('spaced');
  });

  it('falls back when input is empty or all-symbol', () => {
    expect(slugify('')).toBe('item');
    expect(slugify(null)).toBe('item');
    expect(slugify(undefined)).toBe('item');
    expect(slugify('!!!')).toBe('item');
    expect(slugify('---')).toBe('item');
  });

  it('caps length at 200 chars to keep URLs reasonable', () => {
    const out = slugify('x'.repeat(500));
    expect(out.length).toBe(200);
  });

  it('produces output matching the content-store VALID_SLUG contract', () => {
    const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;
    for (const input of ['Test Group', 'Schöne!', '   leading', '___bad___', 'OK 1']) {
      expect(slugify(input)).toMatch(VALID_SLUG);
    }
  });
});

describe('ensureUniqueSlug()', () => {
  it('returns base unchanged when not taken', () => {
    expect(ensureUniqueSlug('test-group', new Set())).toBe('test-group');
  });

  it('appends -2, -3, ... on collision', () => {
    const taken = new Set(['test-group']);
    expect(ensureUniqueSlug('test-group', taken)).toBe('test-group-2');
    taken.add('test-group-2');
    expect(ensureUniqueSlug('test-group', taken)).toBe('test-group-3');
  });

  it('skips already-taken numeric suffixes', () => {
    const taken = new Set(['x', 'x-2', 'x-3', 'x-4']);
    expect(ensureUniqueSlug('x', taken)).toBe('x-5');
  });

  it('returns selfSlug unchanged when base equals selfSlug (idempotent UPDATE)', () => {
    const taken = new Set(['test-group']);
    expect(ensureUniqueSlug('test-group', taken, 'test-group')).toBe('test-group');
  });

  it('still bumps when title changes to collide with another record', () => {
    const taken = new Set(['test-group', 'other']);
    // self was 'other', renaming to a title that slugifies to 'test-group'
    expect(ensureUniqueSlug('test-group', taken, 'other')).toBe('test-group-2');
  });
});
