/**
 * Tests for url-state.ts — the pure parse/serialize layer that backs
 * deep-linking on the Devtoberfest sessions grid (issue #2030).
 *
 * DOM-free: exercises parseSessionsUrl / toSessionsQuery directly, the same
 * way the calendar's url-state.test.ts does without jsdom.
 */

import { describe, it, expect } from 'vitest';
import { parseSessionsUrl, toSessionsQuery, DEFAULT_URL_STATE } from '../url-state';

describe('parseSessionsUrl', () => {
  it('returns the default (all null) state for an empty search', () => {
    expect(parseSessionsUrl('')).toEqual(DEFAULT_URL_STATE);
    expect(parseSessionsUrl('?')).toEqual(DEFAULT_URL_STATE);
  });

  it('accepts a leading "?" or a bare query string', () => {
    expect(parseSessionsUrl('?q=cap').q).toBe('cap');
    expect(parseSessionsUrl('q=cap').q).toBe('cap');
  });

  it('parses every recognised param (URL-decoded)', () => {
    const s = parseSessionsUrl('?q=hana%20cloud&week=1&track=Cloud%20%26%20AI&edition=dtf-2026&session=abc-123');
    expect(s).toEqual({
      q: 'hana cloud',
      week: '1',
      track: 'Cloud & AI',
      edition: 'dtf-2026',
      session: 'abc-123',
    });
  });

  it('treats empty values as null', () => {
    const s = parseSessionsUrl('q=&week=&track=&edition=&session=');
    expect(s).toEqual(DEFAULT_URL_STATE);
  });

  it('treats whitespace-only values as null', () => {
    expect(parseSessionsUrl('q=%20%20').q).toBeNull();
    expect(parseSessionsUrl('track=%20').track).toBeNull();
  });

  it('accepts a URLSearchParams instance directly', () => {
    const s = parseSessionsUrl(new URLSearchParams({ q: 'abap', session: 'x' }));
    expect(s.q).toBe('abap');
    expect(s.session).toBe('x');
  });

  it('ignores unknown params', () => {
    expect(parseSessionsUrl('foo=bar&view=day')).toEqual(DEFAULT_URL_STATE);
  });
});

describe('toSessionsQuery', () => {
  it('emits an empty string for the default state (clean URL)', () => {
    expect(toSessionsQuery(DEFAULT_URL_STATE)).toBe('');
  });

  it('omits empty/whitespace-only fields', () => {
    expect(toSessionsQuery({ ...DEFAULT_URL_STATE, q: '   ' })).toBe('');
    expect(toSessionsQuery({ ...DEFAULT_URL_STATE, week: '' })).toBe('');
  });

  it('serialises non-default fields and URL-encodes values', () => {
    const q = toSessionsQuery({
      q: 'hana cloud',
      week: '2',
      track: 'Cloud & AI',
      edition: 'dtf-2026',
      session: 'abc-123',
    });
    const p = new URLSearchParams(q.replace(/^\?/, ''));
    expect(p.get('q')).toBe('hana cloud');
    expect(p.get('week')).toBe('2');
    expect(p.get('track')).toBe('Cloud & AI');
    expect(p.get('edition')).toBe('dtf-2026');
    expect(p.get('session')).toBe('abc-123');
  });

  it('round-trips any parsed state back to the same state', () => {
    for (const search of [
      '',
      '?q=cap',
      '?week=1&track=DevOps',
      '?q=hana%20cloud&week=2&track=Cloud%20%26%20AI&edition=dtf-2026&session=abc-123',
      '?session=xyz',
    ]) {
      const state = parseSessionsUrl(search);
      expect(parseSessionsUrl(toSessionsQuery(state))).toEqual(state);
    }
  });
});
