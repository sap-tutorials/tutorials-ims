/**
 * Tests for url-state.ts — the pure parse/serialize layer that backs
 * deep-linking on the TechEd schedule (issue #2461).
 *
 * DOM-free: exercises parseTechEdScheduleUrl / toTechEdScheduleQuery directly,
 * same convention as the teched-sessions-grid url-state and the sessions-grid
 * url-state.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { parseTechEdScheduleUrl, toTechEdScheduleQuery, DEFAULT_URL_STATE } from '../url-state';

describe('parseTechEdScheduleUrl', () => {
  it('returns the default state for an empty search', () => {
    expect(parseTechEdScheduleUrl('')).toEqual(DEFAULT_URL_STATE);
    expect(parseTechEdScheduleUrl('?')).toEqual(DEFAULT_URL_STATE);
  });

  it('accepts a leading "?" or a bare query string', () => {
    expect(parseTechEdScheduleUrl('?q=cap').q).toBe('cap');
    expect(parseTechEdScheduleUrl('q=cap').q).toBe('cap');
  });

  it('parses every recognised param', () => {
    const s = parseTechEdScheduleUrl('?q=hana%20cloud&venue=BERLIN&track=cloud-ai&clubhouse=1&fav=1&row=te26-session-abc');
    expect(s).toEqual({
      q: 'hana cloud',
      venue: 'BERLIN',
      track: 'cloud-ai',
      clubhouse: true,
      favorites: true,
      row: 'te26-session-abc',
    });
  });

  it('normalises venue to BERLIN|VIRTUAL only', () => {
    expect(parseTechEdScheduleUrl('?venue=BERLIN').venue).toBe('BERLIN');
    expect(parseTechEdScheduleUrl('?venue=berlin').venue).toBe('BERLIN');
    expect(parseTechEdScheduleUrl('?venue=VIRTUAL').venue).toBe('VIRTUAL');
    expect(parseTechEdScheduleUrl('?venue=virtual').venue).toBe('VIRTUAL');
    expect(parseTechEdScheduleUrl('?venue=ONLINE').venue).toBeNull();
    expect(parseTechEdScheduleUrl('?venue=').venue).toBeNull();
  });

  it('parses clubhouse=1 and fav=1 as booleans', () => {
    expect(parseTechEdScheduleUrl('?clubhouse=1').clubhouse).toBe(true);
    expect(parseTechEdScheduleUrl('?clubhouse=0').clubhouse).toBe(false);
    expect(parseTechEdScheduleUrl('?fav=1').favorites).toBe(true);
    expect(parseTechEdScheduleUrl('?fav=yes').favorites).toBe(false);
  });

  it('treats empty and whitespace-only values as null', () => {
    const s = parseTechEdScheduleUrl('q=&venue=&track=&row=');
    expect(s).toEqual(DEFAULT_URL_STATE);
    expect(parseTechEdScheduleUrl('q=%20').q).toBeNull();
  });

  it('accepts a URLSearchParams instance directly', () => {
    const s = parseTechEdScheduleUrl(new URLSearchParams({ q: 'abap', venue: 'VIRTUAL' }));
    expect(s.q).toBe('abap');
    expect(s.venue).toBe('VIRTUAL');
  });

  it('ignores unknown params', () => {
    expect(parseTechEdScheduleUrl('foo=bar&speaker=x')).toEqual(DEFAULT_URL_STATE);
  });
});

describe('toTechEdScheduleQuery', () => {
  it('emits an empty string for the default state', () => {
    expect(toTechEdScheduleQuery(DEFAULT_URL_STATE)).toBe('');
  });

  it('omits empty/whitespace-only fields', () => {
    expect(toTechEdScheduleQuery({ ...DEFAULT_URL_STATE, q: '   ' })).toBe('');
    expect(toTechEdScheduleQuery({ ...DEFAULT_URL_STATE, venue: 'ONLINE' })).not.toContain('venue');
  });

  it('serialises clubhouse=1 and fav=1 when true', () => {
    const q = toTechEdScheduleQuery({ ...DEFAULT_URL_STATE, clubhouse: true, favorites: true });
    const p = new URLSearchParams(q.replace(/^\?/, ''));
    expect(p.get('clubhouse')).toBe('1');
    expect(p.get('fav')).toBe('1');
  });

  it('omits clubhouse/fav when false', () => {
    const q = toTechEdScheduleQuery({ ...DEFAULT_URL_STATE, clubhouse: false, favorites: false });
    expect(q).not.toContain('clubhouse');
    expect(q).not.toContain('fav');
  });

  it('serialises all non-default fields and URL-encodes values', () => {
    const q = toTechEdScheduleQuery({
      q: 'hana cloud',
      venue: 'BERLIN',
      track: 'cloud-ai',
      clubhouse: true,
      favorites: true,
      row: 'te26-session-abc',
    });
    const p = new URLSearchParams(q.replace(/^\?/, ''));
    expect(p.get('q')).toBe('hana cloud');
    expect(p.get('venue')).toBe('BERLIN');
    expect(p.get('track')).toBe('cloud-ai');
    expect(p.get('clubhouse')).toBe('1');
    expect(p.get('fav')).toBe('1');
    expect(p.get('row')).toBe('te26-session-abc');
  });

  it('round-trips any parsed state back to the same state', () => {
    for (const search of [
      '',
      '?q=cap',
      '?venue=BERLIN',
      '?clubhouse=1',
      '?fav=1',
      '?venue=VIRTUAL&track=cloud-ai',
      '?q=hana%20cloud&venue=BERLIN&track=cloud-ai&clubhouse=1&fav=1&row=te26-session-abc',
    ]) {
      const state = parseTechEdScheduleUrl(search);
      expect(parseTechEdScheduleUrl(toTechEdScheduleQuery(state))).toEqual(state);
    }
  });
});
