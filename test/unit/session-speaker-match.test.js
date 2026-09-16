import { describe, it, expect } from 'vitest';
import {
  normalizeName,
  toSessionCard,
  matchDevtoberfestSessions,
  matchTechEdSessions,
  matchAllSessions,
} from '../../srv/lib/session-speaker-match.js';

describe('session-speaker-match', () => {
  describe('normalizeName', () => {
    it('lowercases, trims, collapses whitespace', () => {
      expect(normalizeName('  Thomas   Jung ')).toBe('thomas jung');
    });
    it('strips diacritics', () => {
      expect(normalizeName('José Müller')).toBe('jose muller');
    });
    it('drops punctuation', () => {
      expect(normalizeName('D.J. O’Brien')).toBe('d j o brien');
    });
    it('returns empty string for empty/blank/non-string', () => {
      expect(normalizeName('')).toBe('');
      expect(normalizeName('   ')).toBe('');
      expect(normalizeName(null)).toBe('');
      expect(normalizeName(undefined)).toBe('');
      expect(normalizeName(42)).toBe('');
    });
  });

  describe('toSessionCard', () => {
    it('produces the canonical shape', () => {
      expect(
        toSessionCard(
          { title: 'T', sourceUrl: 'https://x', track: 'ABAP', venue: 'BERLIN', date: '2026-10-05' },
          'teched',
        ),
      ).toEqual({ event: 'teched', title: 'T', sourceUrl: 'https://x', track: 'ABAP', venue: 'BERLIN', date: '2026-10-05' });
    });
    it('fills defaults for missing fields', () => {
      expect(toSessionCard({}, 'devtoberfest')).toEqual({
        event: 'devtoberfest', title: '', sourceUrl: '', track: '', venue: '', date: null,
      });
      expect(toSessionCard(undefined, 'teched')).toEqual({
        event: 'teched', title: '', sourceUrl: '', track: '', venue: '', date: null,
      });
    });
  });

  describe('matchDevtoberfestSessions', () => {
    const feed = {
      sessions: [
        {
          title: 'Intro to CAP', trackName: 'ABAP', scheduledStart: '2026-10-05T09:00:00Z',
          communityEventUrl: 'https://community/1', youtubeUrl: 'https://youtu.be/1',
          speakers: [{ id: 'sp1', name: 'Thomas Jung' }],
        },
        {
          title: 'Other Talk', trackName: 'BTP', scheduledStart: '2026-10-06T09:00:00Z',
          communityEventUrl: '', youtubeUrl: 'https://youtu.be/2',
          speakers: [{ id: 'sp2', name: 'Someone Else' }],
        },
      ],
    };
    const emailById = new Map([['sp1', 'thomas.jung@sap.com'], ['sp2', 'someone@sap.com']]);

    it('matches by email (case/space-insensitive) and builds a card', () => {
      const out = matchDevtoberfestSessions({ email: '  Thomas.Jung@SAP.com ' }, feed, emailById);
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({
        event: 'devtoberfest', title: 'Intro to CAP', sourceUrl: 'https://community/1',
        track: 'ABAP', venue: 'Devtoberfest', date: '2026-10-05T09:00:00Z',
      });
    });

    it('falls back to name match when email absent', () => {
      const out = matchDevtoberfestSessions({ firstName: 'Thomas', lastName: 'Jung' }, feed, new Map());
      expect(out).toHaveLength(1);
      expect(out[0].title).toBe('Intro to CAP');
    });

    it('prefers community URL then youtube', () => {
      const out = matchDevtoberfestSessions({ name: 'Someone Else' }, feed, new Map());
      expect(out[0].sourceUrl).toBe('https://youtu.be/2');
    });

    it('email takes precedence but name still works if email map is missing an entry', () => {
      const out = matchDevtoberfestSessions({ email: 'thomas.jung@sap.com', name: 'Thomas Jung' }, feed);
      expect(out).toHaveLength(1);
    });

    it('fail-open: empty/undefined feed, missing speakers, no identity', () => {
      expect(matchDevtoberfestSessions({ email: 'x@y' }, undefined)).toEqual([]);
      expect(matchDevtoberfestSessions({ email: 'x@y' }, { sessions: [] })).toEqual([]);
      expect(matchDevtoberfestSessions({ email: 'x@y' }, { sessions: [{ title: 'T' }] })).toEqual([]);
      expect(matchDevtoberfestSessions({}, feed, emailById)).toEqual([]);
    });
  });

  describe('matchTechEdSessions', () => {
    const feed = {
      sessions: [
        { title: 'TechEd Keynote', track: 'trk-abap', venue: 'BERLIN', scheduledStart: '2026-11-10T09:00:00Z', url: 'https://catalog/1', youtubeUrl: '', speakers: ['spk-thomas-jung'] },
        { title: 'Virtual Talk', track: 'trk-btp', venue: 'VIRTUAL', scheduledStart: '2026-11-11T09:00:00Z', url: '', youtubeUrl: 'https://youtu.be/9', speakers: ['spk-other'] },
      ],
      speakers: [
        { slug: 'spk-thomas-jung', name: 'Thomas Jung' },
        { slug: 'spk-other', name: 'Someone Else' },
      ],
      tracks: [
        { slug: 'trk-abap', name: 'ABAP Cloud' },
        { slug: 'trk-btp', name: 'BTP' },
      ],
    };

    it('matches by normalized name and resolves track slug → name', () => {
      const out = matchTechEdSessions({ name: 'thomas  jung' }, feed);
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({
        event: 'teched', title: 'TechEd Keynote', sourceUrl: 'https://catalog/1',
        track: 'ABAP Cloud', venue: 'BERLIN', date: '2026-11-10T09:00:00Z',
      });
    });

    it('prefers catalog url then youtube', () => {
      const out = matchTechEdSessions({ name: 'Someone Else' }, feed);
      expect(out[0].sourceUrl).toBe('https://youtu.be/9');
    });

    it('fail-open: empty/undefined feed, no name, no speaker match', () => {
      expect(matchTechEdSessions({ name: 'Thomas Jung' }, undefined)).toEqual([]);
      expect(matchTechEdSessions({ name: 'Thomas Jung' }, { sessions: [] })).toEqual([]);
      expect(matchTechEdSessions({}, feed)).toEqual([]);
      expect(matchTechEdSessions({ name: 'Nobody Here' }, feed)).toEqual([]);
    });

    it('falls back to bare track slug when tracks list is missing', () => {
      const out = matchTechEdSessions({ name: 'Thomas Jung' }, { ...feed, tracks: [] });
      expect(out[0].track).toBe('trk-abap');
    });
  });

  describe('matchAllSessions', () => {
    it('returns both kinds, fail-open when feeds absent', () => {
      expect(matchAllSessions({ name: 'X' }, {})).toEqual({ teched: [], devtoberfest: [] });
    });
  });
});
