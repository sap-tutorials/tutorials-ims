/**
 * Tests for url-state.ts — the pure parse/serialize layer that backs
 * deep-linking on the Devtoberfest schedule (issue #2461).
 *
 * DOM-free: exercises parseDevtScheduleUrl / toDevtScheduleQuery directly,
 * same convention as the sessions-grid url-state.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { parseDevtScheduleUrl, toDevtScheduleQuery, DEFAULT_URL_STATE } from '../url-state';

describe('parseDevtScheduleUrl', () => {
  it('returns the default state for an empty search', () => {
    expect(parseDevtScheduleUrl('')).toEqual(DEFAULT_URL_STATE);
    expect(parseDevtScheduleUrl('?')).toEqual(DEFAULT_URL_STATE);
  });

  it('accepts a leading "?" or a bare query string', () => {
    expect(parseDevtScheduleUrl('?q=cap').q).toBe('cap');
    expect(parseDevtScheduleUrl('q=cap').q).toBe('cap');
  });

  it('parses every recognised string param', () => {
    const s = parseDevtScheduleUrl('?q=hana%20cloud&week=2&type=activity&track=Cloud%20%26%20AI&format=Live&edition=dtf-2026&row=activity%3Aabc-123');
    expect(s).toEqual({
      q: 'hana cloud',
      week: '2',
      type: 'activity',
      track: 'Cloud & AI',
      format: 'Live',
      favorites: false,
      edition: 'dtf-2026',
      row: 'activity:abc-123',
    });
  });

  it('parses fav=1 as favorites=true', () => {
    expect(parseDevtScheduleUrl('?fav=1').favorites).toBe(true);
    expect(parseDevtScheduleUrl('?fav=0').favorites).toBe(false);
    expect(parseDevtScheduleUrl('?fav=yes').favorites).toBe(false);
  });

  it('normalises type to session|activity only', () => {
    expect(parseDevtScheduleUrl('?type=session').type).toBe('session');
    expect(parseDevtScheduleUrl('?type=activity').type).toBe('activity');
    expect(parseDevtScheduleUrl('?type=SESSION').type).toBe('session');
    expect(parseDevtScheduleUrl('?type=ACTIVITY').type).toBe('activity');
    expect(parseDevtScheduleUrl('?type=unknown').type).toBeNull();
    expect(parseDevtScheduleUrl('?type=').type).toBeNull();
  });

  it('treats empty and whitespace-only values as null', () => {
    const s = parseDevtScheduleUrl('q=&week=&type=&track=&format=&edition=&row=');
    expect(s).toEqual(DEFAULT_URL_STATE);
    expect(parseDevtScheduleUrl('q=%20%20').q).toBeNull();
    expect(parseDevtScheduleUrl('track=%20').track).toBeNull();
  });

  it('accepts a URLSearchParams instance directly', () => {
    const s = parseDevtScheduleUrl(new URLSearchParams({ q: 'abap', type: 'activity' }));
    expect(s.q).toBe('abap');
    expect(s.type).toBe('activity');
  });

  it('ignores unknown params', () => {
    expect(parseDevtScheduleUrl('foo=bar&view=table')).toEqual(DEFAULT_URL_STATE);
  });
});

describe('toDevtScheduleQuery', () => {
  it('emits an empty string for the default state', () => {
    expect(toDevtScheduleQuery(DEFAULT_URL_STATE)).toBe('');
  });

  it('omits empty/whitespace-only fields', () => {
    expect(toDevtScheduleQuery({ ...DEFAULT_URL_STATE, q: '   ' })).toBe('');
    expect(toDevtScheduleQuery({ ...DEFAULT_URL_STATE, week: '' })).toBe('');
    expect(toDevtScheduleQuery({ ...DEFAULT_URL_STATE, type: 'unknown' })).toBe('');
  });

  it('serialises fav=1 when favorites is true', () => {
    const q = toDevtScheduleQuery({ ...DEFAULT_URL_STATE, favorites: true });
    expect(new URLSearchParams(q.replace(/^\?/, '')).get('fav')).toBe('1');
  });

  it('omits fav when favorites is false', () => {
    const q = toDevtScheduleQuery({ ...DEFAULT_URL_STATE, favorites: false });
    expect(q).not.toContain('fav');
  });

  it('serialises all non-default fields and URL-encodes values', () => {
    const q = toDevtScheduleQuery({
      q: 'hana cloud',
      week: '2',
      type: 'activity',
      track: 'Cloud & AI',
      format: 'PreRecorded',
      favorites: true,
      edition: 'dtf-2026',
      row: 'activity:abc-123',
    });
    const p = new URLSearchParams(q.replace(/^\?/, ''));
    expect(p.get('q')).toBe('hana cloud');
    expect(p.get('week')).toBe('2');
    expect(p.get('type')).toBe('activity');
    expect(p.get('track')).toBe('Cloud & AI');
    expect(p.get('format')).toBe('PreRecorded');
    expect(p.get('fav')).toBe('1');
    expect(p.get('edition')).toBe('dtf-2026');
    expect(p.get('row')).toBe('activity:abc-123');
  });

  it('round-trips any parsed state back to the same state', () => {
    for (const search of [
      '',
      '?q=cap',
      '?week=1&type=activity',
      '?fav=1',
      '?type=session&track=DevOps&format=Live',
      '?q=hana%20cloud&week=2&type=activity&track=Cloud%20%26%20AI&format=PreRecorded&edition=dtf-2026&row=activity%3Aabc-123',
    ]) {
      const state = parseDevtScheduleUrl(search);
      expect(parseDevtScheduleUrl(toDevtScheduleQuery(state))).toEqual(state);
    }
  });
});
