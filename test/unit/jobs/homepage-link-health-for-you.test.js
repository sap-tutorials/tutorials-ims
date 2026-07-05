// test/unit/jobs/homepage-link-health-for-you.test.js
// Unit tests for the resolveForYouUrl helper exported from
// srv/jobs/homepage-link-health.js (#763 Task 19).

import { describe, it, expect } from 'vitest';
import { resolveForYouUrl } from '../../../srv/jobs/homepage-link-health.js';

describe('resolveForYouUrl', () => {
  it('resolves tutorial kind', () => {
    expect(resolveForYouUrl({ kind: 'tutorial', targetSlug: 'foo' })).toBe('/tutorials/foo/');
  });

  it('resolves mission kind', () => {
    expect(resolveForYouUrl({ kind: 'mission', targetSlug: 'bar' })).toBe('/missions/bar/');
  });

  it('passes full URL through for blog', () => {
    expect(resolveForYouUrl({ kind: 'blog', targetSlug: 'https://x' })).toBe('https://x');
  });

  it('returns null for blog with non-URL slug', () => {
    expect(resolveForYouUrl({ kind: 'blog', targetSlug: 'some-slug' })).toBeNull();
  });

  it('wraps non-URL video slug in youtu.be', () => {
    expect(resolveForYouUrl({ kind: 'video', targetSlug: 'abc123' })).toBe('https://youtu.be/abc123');
  });

  it('passes full https video URL through', () => {
    expect(resolveForYouUrl({ kind: 'video', targetSlug: 'https://youtu.be/xyz' })).toBe('https://youtu.be/xyz');
  });

  it('passes root-relative shelf URL through', () => {
    expect(resolveForYouUrl({ kind: 'shelf', targetSlug: '/missions/ai/' })).toBe('/missions/ai/');
  });

  it('passes full shelf URL through', () => {
    expect(resolveForYouUrl({ kind: 'shelf', targetSlug: 'https://example.com/shelf' })).toBe('https://example.com/shelf');
  });

  it('returns null for shelf with bare slug', () => {
    expect(resolveForYouUrl({ kind: 'shelf', targetSlug: 'some-slug' })).toBeNull();
  });

  it('returns null for unknown kind', () => {
    expect(resolveForYouUrl({ kind: 'widget', targetSlug: 'foo' })).toBeNull();
  });

  it('returns null when targetSlug is empty', () => {
    expect(resolveForYouUrl({ kind: 'tutorial', targetSlug: '' })).toBeNull();
    expect(resolveForYouUrl({ kind: 'tutorial', targetSlug: null })).toBeNull();
  });
});
