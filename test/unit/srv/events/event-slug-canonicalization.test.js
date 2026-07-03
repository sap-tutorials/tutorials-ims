// test/unit/srv/events/event-slug-canonicalization.test.js
import { describe, it, expect } from 'vitest';
import { canonicalizeEventSlug } from '../../../../srv/lib/events/index.js';

describe('canonicalizeEventSlug', () => {
  it('produces "ce-" prefix + kebab of alphanumerics', () => {
    expect(canonicalizeEventSlug('codejam/12345')).toBe('ce-codejam-12345');
  });

  it('collapses non-alphanumeric runs to a single dash', () => {
    expect(canonicalizeEventSlug('devtoberfest/abc123__def')).toBe('ce-devtoberfest-abc123-def');
  });

  it('trims leading/trailing dashes', () => {
    expect(canonicalizeEventSlug('//foo/bar//')).toBe('ce-foo-bar');
  });

  it('truncates to 80 chars total (including the ce- prefix)', () => {
    const long = 'x'.repeat(200);
    const s = canonicalizeEventSlug(long);
    expect(s.length).toBe(80);
    expect(s.startsWith('ce-')).toBe(true);
  });
});
