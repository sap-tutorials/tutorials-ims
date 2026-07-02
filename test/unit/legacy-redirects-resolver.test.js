import { describe, it, expect } from 'vitest';
import { resolveRedirect, buildIndex, isSameOriginPath } from '../../srv/lib/legacy-redirects-resolver.js';

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

describe('#891 — same-origin toPath validation', () => {
  it('isSameOriginPath accepts absolute paths', () => {
    expect(isSameOriginPath('/foo')).toBe(true);
    expect(isSameOriginPath('/foo/bar?q=1')).toBe(true);
    expect(isSameOriginPath('/')).toBe(true);
  });

  it('isSameOriginPath rejects protocol-relative and absolute URLs', () => {
    expect(isSameOriginPath('//attacker.example')).toBe(false);
    expect(isSameOriginPath('//attacker.example/phish')).toBe(false);
    expect(isSameOriginPath('http://attacker.example')).toBe(false);
    expect(isSameOriginPath('https://attacker.example')).toBe(false);
    expect(isSameOriginPath('javascript:alert(1)')).toBe(false);
    expect(isSameOriginPath('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSameOriginPath('mailto:evil@attacker.example')).toBe(false);
  });

  it('isSameOriginPath rejects paths without leading slash and empty input', () => {
    expect(isSameOriginPath('')).toBe(false);
    expect(isSameOriginPath('foo')).toBe(false);
    expect(isSameOriginPath(undefined)).toBe(false);
    expect(isSameOriginPath(null)).toBe(false);
  });

  it('buildIndex drops rows whose toPath is external', () => {
    const rows = [
      { id: 'ok',     fromPath: '/a', toPath: '/b',                    statusCode: 301, isPattern: false, isActive: true },
      { id: 'evil1',  fromPath: '/c', toPath: '//attacker.example',    statusCode: 301, isPattern: false, isActive: true },
      { id: 'evil2',  fromPath: '/d', toPath: 'https://attacker.example', statusCode: 301, isPattern: false, isActive: true },
      { id: 'evil3',  fromPath: '/e', toPath: 'javascript:alert(1)',   statusCode: 301, isPattern: false, isActive: true },
    ];
    const badIdx = buildIndex(rows);
    expect(resolveRedirect(badIdx, '/a')).toEqual({ id: 'ok', toPath: '/b', statusCode: 301 });
    expect(resolveRedirect(badIdx, '/c')).toBeNull();
    expect(resolveRedirect(badIdx, '/d')).toBeNull();
    expect(resolveRedirect(badIdx, '/e')).toBeNull();
  });

  it('pattern substitution: capture group cannot smuggle external target', () => {
    // toPath is same-origin at build time, but $1 substitution could produce
    // an external URL. Resolver must re-validate the substituted result.
    const rows = [
      { id: 'p1', fromPath: '^/redir/(.+)$', toPath: '/$1', statusCode: 301, isPattern: true, isActive: true },
    ];
    const patIdx = buildIndex(rows);
    // Benign match: pathname includes safe capture → same-origin result
    expect(resolveRedirect(patIdx, '/redir/blog')).toEqual({ id: 'p1', toPath: '/blog', statusCode: 301 });
    // Attempt to smuggle a scheme via the capture. Even if the request path
    // contained percent-encoded evil, the resolver must ensure the resolved
    // toPath is still same-origin.
    const rows2 = [
      { id: 'p2', fromPath: '^/x/(.+)$', toPath: '$1', statusCode: 301, isPattern: true, isActive: true },
    ];
    const pat2 = buildIndex(rows2);
    // build-time check rejects p2 entirely because '$1' as literal toPath doesn't start with /
    expect(resolveRedirect(pat2, '/x/anything')).toBeNull();
  });
});

