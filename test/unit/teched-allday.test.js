// test/unit/teched-allday.test.js
//
// All-day activities (e.g. the Developer Garage) from the SEPARATE RainFocus
// all-day tab (issue #2392 item 6). These are ingested into the SAME
// TechEdSessions entity, marked allDay=true, so the feed/UI reuse the session
// plumbing. Proves parsing + normalization + the merged fetch shape from the
// fixture (no live API needed).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  fetchAllTechEdSessions,
  parseAllDayActivity,
  parseVenuePayload,
} from '../../srv/lib/teched/rainfocus-fetcher.js';
import { normalizeSession } from '../../srv/lib/teched/normalize.js';
import { _setLookupForTests } from '../../srv/lib/safe-fetch.js';

// The fetcher routes through safeFetch (SSRF guard) which DNS-resolves the host
// before calling our injected transport — stub the lookup to a public IP.
beforeAll(() => _setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]));
afterAll(() => _setLookupForTests(null));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEARCH = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'fixtures', 'teched', 'rainfocus-search.json'), 'utf8'),
);
const ALLDAY = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'fixtures', 'teched', 'rainfocus-alldayactivities.json'), 'utf8'),
);

const NOW_BEFORE = Date.parse('2026-10-01T00:00:00Z');
const GARAGE_ID = '1786600000000001adgb'; // Developer Garage — has NO code
const EXPO_ID = '1786600000000002expo';   // AI Showfloor Expo — has code EXPO01

describe('parseAllDayActivity', () => {
  it('marks allDay=true, has no scheduledStart/End, and synthesizes a code when absent', () => {
    const parsed = parseAllDayActivity(ALLDAY.BERLIN.sectionList[0].items[0], 'BERLIN');
    expect(parsed.session.allDay).toBe(true);
    expect(parsed.session.title).toBe('Developer Garage');
    expect(parsed.session.scheduledStart).toBeNull();
    expect(parsed.session.scheduledEnd).toBeNull();
    // no upstream `code` ⇒ stable synthetic derived from sourceId
    expect(parsed.session.sessionCode).toBe(`allday-${GARAGE_ID}`);
    // room falls back to top-level room (no times[].room on all-day rows)
    expect(parsed.session.room).toBe('Developer Garage (Ground Floor)');
    // sap.com url carried through when present
    expect(parsed.session.url).toContain('sap.com/events/teched');
  });

  it('keeps an explicit code and reads a top-level location as room', () => {
    const parsed = parseAllDayActivity(ALLDAY.BERLIN.sectionList[0].items[1], 'BERLIN');
    expect(parsed.session.allDay).toBe(true);
    expect(parsed.session.sessionCode).toBe('EXPO01');
    expect(parsed.session.room).toBe('Show Floor Hall B'); // from `location`
  });

  it('drops a row with neither sourceId nor title', () => {
    expect(parseAllDayActivity({ abstract: 'nothing' }, 'BERLIN')).toBeNull();
  });
});

describe('parseVenuePayload with allDayItems', () => {
  it('merges all-day activities alongside timed sessions, marking allDay per row', () => {
    const { sessions } = parseVenuePayload({
      venue: 'BERLIN',
      sessionItems: SEARCH.BERLIN.sectionList[0].items,
      allDayItems: ALLDAY.BERLIN.sectionList[0].items,
    });
    const allDay = sessions.filter((s) => s.allDay === true);
    const timed = sessions.filter((s) => s.allDay === false);
    expect(allDay.map((s) => s.sourceId).sort()).toEqual([GARAGE_ID, EXPO_ID].sort());
    expect(timed.length).toBe(SEARCH.BERLIN.sectionList[0].items.length);
    // every timed session is explicitly allDay=false (never undefined)
    expect(timed.every((s) => s.allDay === false)).toBe(true);
  });

  it('lets a regular session win when a sourceId appears in both tabs', () => {
    const dupId = SEARCH.BERLIN.sectionList[0].items[0].sessionID;
    const { sessions } = parseVenuePayload({
      venue: 'BERLIN',
      sessionItems: SEARCH.BERLIN.sectionList[0].items,
      allDayItems: [{ sessionID: dupId, title: 'Dup as all-day' }],
    });
    const dup = sessions.filter((s) => s.sourceId === dupId);
    expect(dup).toHaveLength(1);
    expect(dup[0].allDay).toBe(false); // the timed session wins
  });
});

describe('fetchAllTechEdSessions — all-day tab', () => {
  // Route on the body: the all-day request carries the tab param.
  function makeFetch({ withAllDay = true } = {}) {
    return async (_url, init) => {
      const params = new URLSearchParams(init.body);
      const from = Number(params.get('from'));
      const isAllDay = init.body.includes('tab.alldayactivities');
      const isBerlin = init.headers.rfapiprofileid === 'p-b';
      const venueKey = isBerlin ? 'BERLIN' : 'VIRTUAL';
      const src = isAllDay ? ALLDAY : SEARCH;
      const total = src[venueKey].totalSearchItems;
      const items = from > 0 ? [] : src[venueKey].sectionList[0].items;
      const fakeResponse = (json) => ({
        ok: true, status: 200, headers: { get: () => null },
        arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(json)).buffer,
      });
      if (isAllDay && !withAllDay) throw new Error('all-day endpoint down');
      return fakeResponse({ responseCode: '0', totalSearchItems: total, sectionList: [{ items }] });
    };
  }

  const VENUES_WITH_FILTER = {
    BERLIN: { widgetId: 'w-b', profileId: 'p-b', allDayFilter: 'FILTER_B' },
    VIRTUAL: { widgetId: 'w-v', profileId: 'p-v', allDayFilter: '' }, // no all-day for virtual
  };

  it('fetches the all-day tab and merges the activities into the feed', async () => {
    const out = await fetchAllTechEdSessions({ _fetch: makeFetch(), venues: VENUES_WITH_FILTER, now: NOW_BEFORE });
    const allDay = out.sessions.filter((s) => s.allDay === true);
    expect(allDay.map((s) => s.sourceId).sort()).toEqual([GARAGE_ID, EXPO_ID].sort());
    // timed sessions (3 Berlin + 3 Virtual from the search fixture) all present
    expect(out.sessions.filter((s) => s.allDay === false)).toHaveLength(6);
    // all-day activities survive dropPast even though they have no scheduledEnd
    expect(allDay.every((s) => s.scheduledStart === null)).toBe(true);
  });

  it('does NOT fetch all-day activities for a venue with an empty allDayFilter', async () => {
    const out = await fetchAllTechEdSessions({ _fetch: makeFetch(), venues: VENUES_WITH_FILTER, now: NOW_BEFORE });
    // The Virtual venue has allDayFilter:'' — no all-day rows should be Virtual.
    expect(out.sessions.filter((s) => s.allDay && s.venue === 'VIRTUAL')).toHaveLength(0);
  });

  it('keeps timed sessions when the all-day fetch fails (best-effort, fail-soft)', async () => {
    const out = await fetchAllTechEdSessions({ _fetch: makeFetch({ withAllDay: false }), venues: VENUES_WITH_FILTER, now: NOW_BEFORE });
    // all-day fetch threw for Berlin → no all-day rows, but timed sessions intact
    expect(out.sessions.filter((s) => s.allDay === true)).toHaveLength(0);
    expect(out.sessions.filter((s) => s.allDay === false)).toHaveLength(6);
  });

  it('all-day activities normalize with allDay=true through normalizeSession', () => {
    const parsed = parseAllDayActivity(ALLDAY.BERLIN.sectionList[0].items[0], 'BERLIN');
    const row = normalizeSession(parsed.session, new Set());
    expect(row.allDay).toBe(true);
    expect(row.slug).toBe(`allday-${GARAGE_ID}`); // slug from the synthetic code
    expect(row.scheduledStart).toBeNull();
    expect(row.contentHash).toHaveLength(64);
  });
});
