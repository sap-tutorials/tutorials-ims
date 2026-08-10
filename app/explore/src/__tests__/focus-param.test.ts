import { describe, it, expect } from 'vitest';
import { parseFocusParam } from '../focus-param';

describe('parseFocusParam', () => {
  it('extracts a valid focus slug from a query string', () => {
    expect(parseFocusParam('?focus=cap-handlers')).toBe('cap-handlers');
  });
  it('returns empty for missing or malformed focus', () => {
    expect(parseFocusParam('?x=1')).toBe('');
    expect(parseFocusParam('?focus=Bad Slug!')).toBe('');
  });
  it('accepts a single-char slug (minimum valid)', () => {
    expect(parseFocusParam('?focus=a')).toBe('a');
  });
  it('rejects a slug starting with a hyphen', () => {
    expect(parseFocusParam('?focus=-bad')).toBe('');
  });
  it('rejects an empty focus value', () => {
    expect(parseFocusParam('?focus=')).toBe('');
  });
  it('returns empty for an empty string', () => {
    expect(parseFocusParam('')).toBe('');
  });
  it('rejects an 83-character slug (one past the {0,80} suffix bound)', () => {
    // regex is /^[a-z0-9][a-z0-9-]{0,80}$/ — first char + 80 suffix = 81 chars max
    // 82 chars = 1 + 81 suffix → should still reject (suffix bound is 0,80)
    // 83 chars = 1 + 82 suffix → definitely rejects
    const slug83 = 'a' + 'b'.repeat(82); // 1 + 82 = 83 chars
    expect(parseFocusParam(`?focus=${slug83}`)).toBe('');
  });
  it('accepts a maximum-valid 81-character slug (1 + 80 suffix chars)', () => {
    const slug81 = 'a' + 'b'.repeat(80); // 1 + 80 = 81 chars — at the boundary
    expect(parseFocusParam(`?focus=${slug81}`)).toBe(slug81);
  });
});

