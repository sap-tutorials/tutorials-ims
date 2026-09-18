// test/unit/teched-author-match.test.js
//
// Unit tests for srv/lib/teched/author-match.js (issue #2355, Unit 8).
// Covers the name→login matcher, ambiguity exclusion, fail-open behaviour,
// and the enrichSpeakersWithAuthorLogin convenience wrapper.
//
// No cds/db — pure module, runs fast without a serve bootstrap.

import { describe, it, expect } from 'vitest';
import {
  normalizeName,
  buildNameToLoginMap,
  resolveAuthorLogin,
  enrichSpeakersWithAuthorLogin,
  buildNameToSlugMap,
  enrichSpeakersWithAdvocateSlug,
} from '../../srv/lib/teched/author-match.js';

// ---------------------------------------------------------------------------
// normalizeName
// ---------------------------------------------------------------------------
describe('normalizeName', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeName('  Ada  Lovelace  ')).toBe('ada lovelace');
    expect(normalizeName('GRACE HOPPER')).toBe('grace hopper');
    expect(normalizeName('José  Müller')).toBe('josé müller');
  });

  it('returns empty string for null/undefined/blank', () => {
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
    expect(normalizeName('')).toBe('');
    expect(normalizeName('   ')).toBe('');
  });

  it('handles non-string by returning empty string', () => {
    expect(normalizeName(42)).toBe('');
    expect(normalizeName({})).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildNameToLoginMap
// ---------------------------------------------------------------------------
describe('buildNameToLoginMap', () => {
  const index = {
    'ada-lovelace': { login: 'ada-lovelace', displayName: 'Ada Lovelace', githubUrl: 'https://github.com/ada-lovelace', tutorials: [] },
    'grace-hopper': { login: 'grace-hopper', displayName: 'Grace Hopper', githubUrl: 'https://github.com/grace-hopper', tutorials: [] },
  };

  it('builds a 1:1 map for unambiguous entries', () => {
    const map = buildNameToLoginMap(index);
    expect(map.get('ada lovelace')).toBe('ada-lovelace');
    expect(map.get('grace hopper')).toBe('grace-hopper');
  });

  it('excludes entries with an ambiguous normalized name (two logins)', () => {
    const ambiguous = {
      ...index,
      'ada-lovelace-2': { login: 'ada-lovelace-2', displayName: 'Ada Lovelace', githubUrl: '', tutorials: [] },
    };
    const map = buildNameToLoginMap(ambiguous);
    expect(map.has('ada lovelace')).toBe(false); // excluded — ambiguous
    expect(map.get('grace hopper')).toBe('grace-hopper'); // unambiguous still there
  });

  it('returns an empty map for null/invalid input', () => {
    expect(buildNameToLoginMap(null).size).toBe(0);
    expect(buildNameToLoginMap(undefined).size).toBe(0);
    expect(buildNameToLoginMap('not-an-object').size).toBe(0);
    expect(buildNameToLoginMap([]).size).toBe(0);
  });

  it('skips entries with empty displayName', () => {
    const withBlank = {
      'nobody': { login: 'nobody', displayName: '', githubUrl: '', tutorials: [] },
      'ada-lovelace': { login: 'ada-lovelace', displayName: 'Ada Lovelace', githubUrl: '', tutorials: [] },
    };
    const map = buildNameToLoginMap(withBlank);
    expect(map.size).toBe(1);
    expect(map.get('ada lovelace')).toBe('ada-lovelace');
  });
});

// ---------------------------------------------------------------------------
// resolveAuthorLogin
// ---------------------------------------------------------------------------
describe('resolveAuthorLogin', () => {
  const index = {
    'ada-lovelace': { login: 'ada-lovelace', displayName: 'Ada Lovelace', githubUrl: '', tutorials: [] },
    'grace-hopper': { login: 'grace-hopper', displayName: 'Grace Hopper', githubUrl: '', tutorials: [] },
  };
  const map = buildNameToLoginMap(index);

  it('returns the login for an unambiguous match', () => {
    expect(resolveAuthorLogin('Ada Lovelace', map)).toBe('ada-lovelace');
    expect(resolveAuthorLogin('  Grace Hopper  ', map)).toBe('grace-hopper');
  });

  it('returns null for no match', () => {
    expect(resolveAuthorLogin('Unknown Person', map)).toBeNull();
    expect(resolveAuthorLogin('', map)).toBeNull();
    expect(resolveAuthorLogin(null, map)).toBeNull();
    expect(resolveAuthorLogin(undefined, map)).toBeNull();
  });

  it('returns null when map is empty', () => {
    expect(resolveAuthorLogin('Ada Lovelace', new Map())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// enrichSpeakersWithAuthorLogin
// ---------------------------------------------------------------------------
describe('enrichSpeakersWithAuthorLogin', () => {
  const index = {
    'ada-lovelace': { login: 'ada-lovelace', displayName: 'Ada Lovelace', githubUrl: '', tutorials: [] },
    'grace-hopper': { login: 'grace-hopper', displayName: 'Grace Hopper', githubUrl: '', tutorials: [] },
  };

  it('attaches authorLogin on 1:1 name match', () => {
    const speakers = [
      { slug: 'ada', name: 'Ada Lovelace' },
      { slug: 'grace', name: 'Grace Hopper' },
    ];
    enrichSpeakersWithAuthorLogin(speakers, index);
    expect(speakers[0].authorLogin).toBe('ada-lovelace');
    expect(speakers[1].authorLogin).toBe('grace-hopper');
  });

  it('attaches null for no match', () => {
    const speakers = [{ slug: 'anon', name: 'Unknown Person' }];
    enrichSpeakersWithAuthorLogin(speakers, index);
    expect(speakers[0].authorLogin).toBeNull();
  });

  it('attaches null for ambiguous name (two logins)', () => {
    const ambiguous = {
      ...index,
      'ada-lovelace-2': { login: 'ada-lovelace-2', displayName: 'Ada Lovelace', githubUrl: '', tutorials: [] },
    };
    const speakers = [{ slug: 'ada', name: 'Ada Lovelace' }];
    enrichSpeakersWithAuthorLogin(speakers, ambiguous);
    expect(speakers[0].authorLogin).toBeNull();
  });

  it('is fail-open: attaches null when authorIndex is missing/null', () => {
    const speakers = [{ slug: 'ada', name: 'Ada Lovelace' }];
    enrichSpeakersWithAuthorLogin(speakers, null);
    expect(speakers[0].authorLogin).toBeNull();
  });

  it('is fail-open: attaches null when authorIndex is not an object', () => {
    const speakers = [{ slug: 'ada', name: 'Ada Lovelace' }];
    enrichSpeakersWithAuthorLogin(speakers, 'not-an-object');
    expect(speakers[0].authorLogin).toBeNull();
  });

  it('returns the same speakers array (mutation + identity)', () => {
    const speakers = [{ slug: 'ada', name: 'Ada Lovelace' }];
    const result = enrichSpeakersWithAuthorLogin(speakers, index);
    expect(result).toBe(speakers);
  });

  it('handles empty speakers array gracefully', () => {
    expect(() => enrichSpeakersWithAuthorLogin([], index)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// advocate matcher (issue #2392) — name → developer-advocate slug
// ---------------------------------------------------------------------------
describe('buildNameToSlugMap + enrichSpeakersWithAdvocateSlug', () => {
  const roster = [
    { name: 'Rekha D R', slug: 'rekha-d-r' },
    { name: 'Witalij Rudnicki', slug: 'witalij-rudnicki' },
    { name: 'DJ Adams', slug: 'dj-adams' },
  ];

  it('maps normalized name → slug (1:1)', () => {
    const m = buildNameToSlugMap(roster);
    expect(m.get('rekha d r')).toBe('rekha-d-r');
    expect(m.get('witalij rudnicki')).toBe('witalij-rudnicki');
  });

  it('excludes ambiguous names (same name → 2 slugs)', () => {
    const m = buildNameToSlugMap([
      { name: 'Alex Kim', slug: 'alex-kim' },
      { name: 'Alex Kim', slug: 'alex-kim-2' },
    ]);
    expect(m.has('alex kim')).toBe(false);
  });

  it('enriches speakers with advocateSlug, null when unmatched', () => {
    const speakers = [
      { slug: 'rekha', name: 'Rekha D R' },
      { slug: 'josh', name: 'Josh Bentley' }, // not an advocate
    ];
    enrichSpeakersWithAdvocateSlug(speakers, roster);
    expect(speakers[0].advocateSlug).toBe('rekha-d-r');
    expect(speakers[1].advocateSlug).toBeNull();
  });

  it('is fail-open: attaches null when roster is not an array', () => {
    const speakers = [{ slug: 'rekha', name: 'Rekha D R' }];
    enrichSpeakersWithAdvocateSlug(speakers, null);
    expect(speakers[0].advocateSlug).toBeNull();
  });
});
