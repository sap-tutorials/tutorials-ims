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
});
