// test/unit/teched-fetcher.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchAllTechEdSessions, parseVenuePayload } from '../../srv/lib/teched/rainfocus-fetcher.js';
import { _setLookupForTests } from '../../srv/lib/safe-fetch.js';

// The fetcher routes through safeFetch (SSRF guard), which DNS-resolves the
// host before calling our injected transport. Stub the lookup to a public IP so
// the tests stay hermetic (no real DNS) and the SSRF guard passes.
beforeAll(() => _setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]));
afterAll(() => _setLookupForTests(null));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// REAL capture (trimmed) from POST events.rainfocus.com/api/sessions on
// 2026-09-15 — both venues. See srv/lib/teched/README.md.
const FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'fixtures', 'teched', 'rainfocus-search.json'), 'utf8'),
);

// Distinct widget ids per venue → the fake fetch maps them back to fixture keys.
const VENUES = {
  BERLIN: { widgetId: 'w-b', profileId: 'p-b' },
  VIRTUAL: { widgetId: 'w-v', profileId: 'p-v' },
};
const WIDGET_TO_VENUE = { 'w-v': 'VIRTUAL', 'w-b': 'BERLIN' };

function fakeResponse(json) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(json)).buffer,
  };
}

// Fake fetch: routes on the rfwidgetid header to the per-venue fixture. Page 0
// returns the real items; any later `from` returns empty (terminates paging).
function makeFetch() {
  return async (_url, init) => {
    const widget = init.headers.rfwidgetid;
    const venue = WIDGET_TO_VENUE[widget];
    const params = new URLSearchParams(init.body);
    const from = Number(params.get('from'));
    if (from > 0) {
      return fakeResponse({ responseCode: '0', totalSearchItems: FIXTURE[venue].totalSearchItems, sectionList: [{ items: [] }] });
    }
    return fakeResponse(FIXTURE[venue]);
  };
}

// now BEFORE the fixture session dates so dropPast keeps everything
const NOW_BEFORE = Date.parse('2026-10-01T00:00:00Z');

// Known ids from the real fixture.
const BERLIN_KEYNOTE = '1786103955856001msiq'; // KEY100
const HERZIG_BERLIN = '1734109533258001oaQ3_1773259901317001te26';
const TRACK_KEYNOTE = '1745939183774010keFq';
const TRACK_AD = '1745939183774002kMU7'; // shared across both venues

describe('fetchAllTechEdSessions', () => {
  it('parses both venues and dedups sessions/speakers/tracks', async () => {
    const out = await fetchAllTechEdSessions({ _fetch: makeFetch(), venues: VENUES, now: NOW_BEFORE });

    // 3 Berlin + 3 Virtual real sessions, all distinct sourceIds
    expect(out.sessions).toHaveLength(6);
    expect(new Set(out.sessions.map((s) => s.sourceId)).size).toBe(6);

    // speakers embedded per session, deduped by speakerId within a venue
    // (Berlin 6 distinct + Virtual 4 distinct = 10; Herzig has a venue-suffixed
    // id so he is a distinct row per venue)
    expect(out.speakers).toHaveLength(10);

    // tracks derived from attributevalues[attribute==='Track'], deduped by
    // rf_attributevalue_id (Keynote + AD are shared across venues)
    expect(out.tracks.map((t) => t.sourceId).sort()).toEqual(
      [TRACK_KEYNOTE, '1745939183774003kz40', TRACK_AD, '1780572314128002OZdN'].sort(),
    );
  });

  it('maps session fields (times → start/end/room, track, speakers) correctly', async () => {
    const out = await fetchAllTechEdSessions({ _fetch: makeFetch(), venues: VENUES, now: NOW_BEFORE });
    const s = out.sessions.find((x) => x.sourceId === BERLIN_KEYNOTE);
    expect(s.venue).toBe('BERLIN');
    expect(s.sessionCode).toBe('KEY100');
    expect(s.title).toBe('Built for the ones who build');
    // utcStartTime "2026/10/27 08:00:00" (UTC, non-ISO) → ISO Z
    expect(s.scheduledStart).toBe('2026-10-27T08:00:00.000Z');
    expect(s.scheduledEnd).toBe('2026-10-27T09:30:00.000Z');
    expect(s.room).toBe('Keynote Theater');
    expect(s.trackSourceId).toBe(TRACK_KEYNOTE);
    expect(s.speakerSourceIds).toEqual([HERZIG_BERLIN]);
  });

  it('extracts speaker attributes from embedded participants', async () => {
    const out = await fetchAllTechEdSessions({ _fetch: makeFetch(), venues: VENUES, now: NOW_BEFORE });
    const herzig = out.speakers.find((sp) => sp.sourceId === HERZIG_BERLIN);
    expect(herzig.name).toBe('Philipp Herzig');
    expect(herzig.title).toBe('Chief Technology Officer'); // globalJobtitle
    expect(herzig.company).toBe('SAP');
    expect(herzig.photoUrl).toContain('rainfocus.com');
  });

  it('drops past sessions when now is after them', async () => {
    const out = await fetchAllTechEdSessions({
      _fetch: makeFetch(), venues: VENUES, now: Date.parse('2027-01-01T00:00:00Z'),
    });
    expect(out.sessions).toHaveLength(0);
  });

  it('survives one venue failing (Promise.allSettled)', async () => {
    const fetchImpl = async (_url, init) => {
      if (init.headers.rfwidgetid === 'w-b') throw new Error('Berlin down');
      const params = new URLSearchParams(init.body);
      if (Number(params.get('from')) > 0) {
        return fakeResponse({ responseCode: '0', totalSearchItems: FIXTURE.VIRTUAL.totalSearchItems, sectionList: [{ items: [] }] });
      }
      return fakeResponse(FIXTURE.VIRTUAL);
    };
    const out = await fetchAllTechEdSessions({ _fetch: fetchImpl, venues: VENUES, now: NOW_BEFORE });
    expect(out.sessions.every((s) => s.venue === 'VIRTUAL')).toBe(true);
    expect(out.sessions).toHaveLength(3);
  });

  it('fails a venue softly on a non-"0" responseCode', async () => {
    const fetchImpl = async (_url, init) => {
      if (init.headers.rfwidgetid === 'w-b') {
        return fakeResponse({ responseCode: '1', responseMessage: 'Invalid API Profile' });
      }
      const params = new URLSearchParams(init.body);
      if (Number(params.get('from')) > 0) {
        return fakeResponse({ responseCode: '0', totalSearchItems: FIXTURE.VIRTUAL.totalSearchItems, sectionList: [{ items: [] }] });
      }
      return fakeResponse(FIXTURE.VIRTUAL);
    };
    const out = await fetchAllTechEdSessions({ _fetch: fetchImpl, venues: VENUES, now: NOW_BEFORE });
    // Berlin failed (bad responseCode) → only Virtual survived
    expect(out.sessions.every((s) => s.venue === 'VIRTUAL')).toBe(true);
    expect(out.sessions).toHaveLength(3);
  });
});

describe('parseVenuePayload', () => {
  it('derives speakers from embedded participants', () => {
    const { speakers } = parseVenuePayload({
      venue: 'VIRTUAL',
      sessionItems: FIXTURE.VIRTUAL.sectionList[0].items,
    });
    // Virtual: Herzig + Pietsch + Narayanan + Gall = 4 distinct participants
    expect(speakers).toHaveLength(4);
    expect(speakers.find((s) => s.name === 'Philipp Herzig')).toBeTruthy();
  });
});
