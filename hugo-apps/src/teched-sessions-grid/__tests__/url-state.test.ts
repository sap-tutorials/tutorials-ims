import { describe, it, expect } from 'vitest';
import { parseTechEdUrl, toTechEdQuery, DEFAULT_URL_STATE } from '../url-state';

describe('parseTechEdUrl', () => {
  it('returns the default (all null) state for an empty search', () => {
    expect(parseTechEdUrl('')).toEqual(DEFAULT_URL_STATE);
    expect(parseTechEdUrl('?')).toEqual(DEFAULT_URL_STATE);
  });

  it('accepts a leading "?" or a bare query string', () => {
    expect(parseTechEdUrl('?q=cap').q).toBe('cap');
    expect(parseTechEdUrl('q=cap').q).toBe('cap');
  });

  it('parses every recognised param (URL-decoded)', () => {
    const s = parseTechEdUrl('?q=hana%20cloud&venue=BERLIN&track=ai-ml&speaker=ada-lovelace&session=my-session');
    expect(s).toEqual({ q: 'hana cloud', venue: 'BERLIN', track: 'ai-ml', speaker: 'ada-lovelace', session: 'my-session' });
  });

  it('normalises venue to canonical upper-case, else null', () => {
    expect(parseTechEdUrl('venue=berlin').venue).toBe('BERLIN');
    expect(parseTechEdUrl('venue=Virtual').venue).toBe('VIRTUAL');
    expect(parseTechEdUrl('venue=hybrid').venue).toBeNull();
  });

  it('treats empty and whitespace-only values as null', () => {
    expect(parseTechEdUrl('q=&venue=&track=&speaker=&session=')).toEqual(DEFAULT_URL_STATE);
    expect(parseTechEdUrl('q=%20%20').q).toBeNull();
    expect(parseTechEdUrl('track=%20').track).toBeNull();
    expect(parseTechEdUrl('session=%20').session).toBeNull();
  });

  it('trims surrounding whitespace on retained values', () => {
    // A padded deep-link must yield the canonical value so exact facet
    // comparison (s.track === state.track) still matches.
    expect(parseTechEdUrl('track=%20ai%20').track).toBe('ai');
    expect(parseTechEdUrl('q=%20hana%20').q).toBe('hana');
    expect(parseTechEdUrl('speaker=%20ada-lovelace').speaker).toBe('ada-lovelace');
    expect(parseTechEdUrl('session=%20my-session%20').session).toBe('my-session');
  });

  it('accepts a URLSearchParams instance directly', () => {
    const s = parseTechEdUrl(new URLSearchParams({ q: 'abap', speaker: 'x', session: 'my-session' }));
    expect(s.q).toBe('abap');
    expect(s.speaker).toBe('x');
    expect(s.session).toBe('my-session');
  });

  it('ignores unknown params', () => {
    expect(parseTechEdUrl('foo=bar&view=day')).toEqual(DEFAULT_URL_STATE);
  });

  it('parses session param', () => {
    expect(parseTechEdUrl('?session=ai-berlin').session).toBe('ai-berlin');
    expect(parseTechEdUrl('?session=').session).toBeNull();
  });
});

describe('toTechEdQuery', () => {
  it('emits an empty string for the default state (clean URL)', () => {
    expect(toTechEdQuery(DEFAULT_URL_STATE)).toBe('');
  });

  it('omits empty/whitespace-only fields', () => {
    expect(toTechEdQuery({ ...DEFAULT_URL_STATE, q: '   ' })).toBe('');
    expect(toTechEdQuery({ ...DEFAULT_URL_STATE, track: '' })).toBe('');
    expect(toTechEdQuery({ ...DEFAULT_URL_STATE, session: '' })).toBe('');
  });

  it('drops an invalid venue', () => {
    expect(toTechEdQuery({ ...DEFAULT_URL_STATE, venue: 'hybrid' })).toBe('');
  });

  it('serialises non-default fields and URL-encodes values', () => {
    const q = toTechEdQuery({ q: 'hana cloud', venue: 'VIRTUAL', track: 'ai-ml', speaker: 'ada-lovelace', session: 'my-session' });
    const p = new URLSearchParams(q.replace(/^\?/, ''));
    expect(p.get('q')).toBe('hana cloud');
    expect(p.get('venue')).toBe('VIRTUAL');
    expect(p.get('track')).toBe('ai-ml');
    expect(p.get('speaker')).toBe('ada-lovelace');
    expect(p.get('session')).toBe('my-session');
  });

  it('serialises session param', () => {
    const q = toTechEdQuery({ ...DEFAULT_URL_STATE, session: 'ai-berlin' });
    expect(q).toContain('session=ai-berlin');
  });

  it('round-trips any parsed state back to the same state', () => {
    for (const search of [
      '',
      '?q=cap',
      '?venue=BERLIN',
      '?track=ai-ml&speaker=x',
      '?q=hana%20cloud&venue=VIRTUAL&track=ai-ml&speaker=ada-lovelace',
      '?session=ai-berlin',
      '?q=cap&session=cap-virtual',
    ]) {
      const state = parseTechEdUrl(search);
      expect(parseTechEdUrl(toTechEdQuery(state))).toEqual(state);
    }
  });
});
