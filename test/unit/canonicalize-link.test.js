import { describe, it, expect } from 'vitest';
import { canonicalizeLink } from '../../srv/lib/canonicalize-link.js';

describe('canonicalizeLink', () => {
  it('lowercases scheme and host', () => {
    expect(canonicalizeLink('HTTPS://News.SAP.com/x')).toBe('https://news.sap.com/x');
  });
  it('lowercases the path', () => {
    expect(canonicalizeLink('https://news.sap.com/2026/CAP-10/')).toBe('https://news.sap.com/2026/cap-10/');
  });
  it('strips utm_* params', () => {
    expect(canonicalizeLink('https://news.sap.com/a?utm_source=x&utm_medium=y&foo=1'))
      .toBe('https://news.sap.com/a?foo=1');
  });
  it('strips sc_camp / mc_cid / mc_eid', () => {
    expect(canonicalizeLink('https://news.sap.com/a?sc_camp=1&mc_cid=2&mc_eid=3'))
      .toBe('https://news.sap.com/a');
  });
  it('keeps unknown params in original order', () => {
    expect(canonicalizeLink('https://news.sap.com/a?b=2&a=1'))
      .toBe('https://news.sap.com/a?b=2&a=1');
  });
  it('returns input unchanged when URL constructor throws', () => {
    expect(canonicalizeLink('not-a-url')).toBe('not-a-url');
  });
  it('handles empty string', () => {
    expect(canonicalizeLink('')).toBe('');
  });
});
