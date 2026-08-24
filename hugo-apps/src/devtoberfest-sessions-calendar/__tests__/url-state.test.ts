/**
 * Tests for url-state.ts — the pure parse/serialize layer that backs
 * deep-linking on the Devtoberfest calendar (issue #2006).
 *
 * DOM-free: exercises parseCalendarUrl / toCalendarQuery directly, the
 * same way concepts-filter/filter-logic.ts is tested without jsdom.
 */

import { describe, it, expect } from 'vitest';
import { parseCalendarUrl, toCalendarQuery, DEFAULT_URL_STATE } from '../url-state';

describe('parseCalendarUrl', () => {
  it('returns the default (all null) state for an empty search', () => {
    expect(parseCalendarUrl('')).toEqual(DEFAULT_URL_STATE);
    expect(parseCalendarUrl('?')).toEqual(DEFAULT_URL_STATE);
  });

  it('accepts a leading "?" or a bare query string', () => {
    expect(parseCalendarUrl('?view=day').view).toBe('day');
    expect(parseCalendarUrl('view=day').view).toBe('day');
  });

  it('parses every recognised param', () => {
    const s = parseCalendarUrl('?view=week&date=2026-10-05&session=abc-123&track=Cloud%20%26%20AI&edition=dtf-2026');
    expect(s).toEqual({
      view: 'week',
      date: '2026-10-05',
      session: 'abc-123',
      track: 'Cloud & AI', // URL-decoded
      edition: 'dtf-2026',
    });
  });

  it('only accepts month|week|day for view; anything else → null', () => {
    expect(parseCalendarUrl('view=month').view).toBe('month');
    expect(parseCalendarUrl('view=year').view).toBeNull();
    expect(parseCalendarUrl('view=').view).toBeNull();
  });

  it('rejects malformed or impossible dates (fail-open, never throws)', () => {
    expect(parseCalendarUrl('date=2026-10-05').date).toBe('2026-10-05');
    expect(parseCalendarUrl('date=10-05-2026').date).toBeNull(); // wrong format
    expect(parseCalendarUrl('date=2026-13-40').date).toBeNull(); // impossible
    expect(parseCalendarUrl('date=2026-02-30').date).toBeNull(); // Feb 30
    expect(parseCalendarUrl('date=garbage').date).toBeNull();
    expect(parseCalendarUrl('date=').date).toBeNull();
  });

  it('treats empty session/track/edition as null', () => {
    const s = parseCalendarUrl('session=&track=&edition=');
    expect(s.session).toBeNull();
    expect(s.track).toBeNull();
    expect(s.edition).toBeNull();
  });

  it('accepts a URLSearchParams instance directly', () => {
    const s = parseCalendarUrl(new URLSearchParams({ view: 'day', session: 'x' }));
    expect(s.view).toBe('day');
    expect(s.session).toBe('x');
  });
});

describe('toCalendarQuery', () => {
  it('emits an empty string for the default state (clean URL)', () => {
    expect(toCalendarQuery(DEFAULT_URL_STATE)).toBe('');
  });

  it('omits view when it is the default (month)', () => {
    expect(toCalendarQuery({ ...DEFAULT_URL_STATE, view: 'month' })).toBe('');
    expect(toCalendarQuery({ ...DEFAULT_URL_STATE, view: 'week' })).toBe('?view=week');
  });

  it('serialises non-default fields and URL-encodes values', () => {
    const q = toCalendarQuery({
      view: 'day',
      date: '2026-10-05',
      session: 'abc-123',
      track: 'Cloud & AI',
      edition: 'dtf-2026',
    });
    const p = new URLSearchParams(q.replace(/^\?/, ''));
    expect(p.get('view')).toBe('day');
    expect(p.get('date')).toBe('2026-10-05');
    expect(p.get('session')).toBe('abc-123');
    expect(p.get('track')).toBe('Cloud & AI');
    expect(p.get('edition')).toBe('dtf-2026');
  });

  it('drops a malformed date rather than emitting it', () => {
    expect(toCalendarQuery({ ...DEFAULT_URL_STATE, date: 'nope' })).toBe('');
  });

  it('round-trips any parsed state back to the same state', () => {
    for (const search of [
      '',
      '?view=week',
      '?view=day&date=2026-10-05',
      '?session=abc-123&track=DevOps',
      '?view=day&date=2026-10-05&session=abc-123&track=Cloud%20%26%20AI&edition=dtf-2026',
    ]) {
      const state = parseCalendarUrl(search);
      expect(parseCalendarUrl(toCalendarQuery(state))).toEqual(state);
    }
  });
});
