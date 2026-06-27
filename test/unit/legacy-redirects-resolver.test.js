import { describe, it, expect } from 'vitest';
import { resolveRedirect, buildIndex } from '../../srv/lib/legacy-redirects-resolver.js';

const FIXTURES = [
  { id: 'r1', fromPath: '/tutorial-navigator.html', toPath: '/tutorial-navigator/', statusCode: 301, isPattern: false, isActive: true },
  { id: 'r2', fromPath: '/index.html',              toPath: '/',                    statusCode: 301, isPattern: false, isActive: true },
  { id: 'r3', fromPath: '^/topics/([^/]+)\\.html$', toPath: '/tags/$1/',            statusCode: 301, isPattern: true,  isActive: true },
  { id: 'r4', fromPath: '/old-disabled.html',       toPath: '/new/',                statusCode: 301, isPattern: false, isActive: false }
];

describe('resolveRedirect', () => {
  const idx = buildIndex(FIXTURES);

  it('matches exact path (case-insensitive)', () => {
    expect(resolveRedirect(idx, '/Tutorial-Navigator.html')).toEqual({
      id: 'r1', toPath: '/tutorial-navigator/', statusCode: 301
    });
  });

  it('matches regex pattern and substitutes capture groups', () => {
    expect(resolveRedirect(idx, '/topics/cap.html')).toEqual({
      id: 'r3', toPath: '/tags/cap/', statusCode: 301
    });
  });

  it('skips inactive entries', () => {
    expect(resolveRedirect(idx, '/old-disabled.html')).toBeNull();
  });

  it('returns null on no match', () => {
    expect(resolveRedirect(idx, '/nothing-here')).toBeNull();
  });

  it('preserves query string when target does not include one', () => {
    expect(resolveRedirect(idx, '/index.html?utm=foo')).toEqual({
      id: 'r2', toPath: '/?utm=foo', statusCode: 301
    });
  });
});
