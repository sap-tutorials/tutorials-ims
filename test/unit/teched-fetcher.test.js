// test/unit/teched-fetcher.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchAllTechEdSessions, parseVenuePayload } from '../../srv/lib/teched/rainfocus-fetcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'fixtures', 'teched', 'rainfocus-search.json'), 'utf8'),
);

// Distinct widget ids per venue → the fake fetch maps them back to fixture keys.
const VENUES = {
  VIRTUAL: { flow: 'tev26', widgetId: 'w-v', apiProfileId: 'p-v' },
  BERLIN: { flow: 'te26', widgetId: 'w-b', apiProfileId: 'p-b' },
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

// Fake fetch: routes on rfWidgetId header + `type` form field to the fixture.
function makeFetch() {
  return async (_url, init) => {
    const widget = init.headers.rfWidgetId;
    const venue = WIDGET_TO_VENUE[widget];
    const params = new URLSearchParams(init.body);
    const type = params.get('type');
    const from = Number(params.get('from'));
    // page 0 returns items; any later page returns empty (terminates pagination)
    if (from > 0) return fakeResponse({ responseCode: '0', sectionList: [{ items: [] }] });
    return fakeResponse(FIXTURE[venue][type]);
  };
}

// now BEFORE the fixture session dates so dropPast keeps everything
const NOW_BEFORE = Date.parse('2026-10-01T00:00:00Z');

describe('fetchAllTechEdSessions', () => {
  it('parses both venues, dedups, and drops invalid rows', async () => {
    const out = await fetchAllTechEdSessions({ _fetch: makeFetch(), venues: VENUES, now: NOW_BEFORE });

    // 2 virtual + 1 berlin valid; the Berlin row with no id/code is dropped
    expect(out.sessions.map((s) => s.sourceId).sort()).toEqual(['s-te-2001', 's-tev-1001', 's-tev-1002']);

    // both DEV101 sessions survive (distinct sourceId, same code)
    const codes = out.sessions.filter((s) => s.sessionCode === 'DEV101');
    expect(codes).toHaveLength(2);

    // speakers deduped across venues (spk-1 appears in all three sessions)
    expect(out.speakers.map((s) => s.sourceId).sort()).toEqual(['spk-1', 'spk-2']);

    // tracks derived from attributevalues
    expect(out.tracks.map((t) => t.sourceId).sort()).toEqual(['trk-ai', 'trk-appdev']);
  });

  it('maps session fields (times, room, track, speakers) correctly', async () => {
    const out = await fetchAllTechEdSessions({ _fetch: makeFetch(), venues: VENUES, now: NOW_BEFORE });
    const s = out.sessions.find((x) => x.sourceId === 's-tev-1001');
    expect(s.venue).toBe('VIRTUAL');
    expect(s.title).toContain('CAP');
    expect(s.scheduledStart).toBe('2026-11-03T09:00:00.000Z');
    expect(s.scheduledEnd).toBe('2026-11-03T10:00:00.000Z');
    expect(s.room).toBe('Virtual Room A');
    expect(s.trackSourceId).toBe('trk-appdev');
    expect(s.speakerSourceIds).toEqual(['spk-1']);
  });

  it('drops past sessions when now is after them', async () => {
    const out = await fetchAllTechEdSessions({
      _fetch: makeFetch(), venues: VENUES, now: Date.parse('2027-01-01T00:00:00Z'),
    });
    expect(out.sessions).toHaveLength(0);
  });

  it('survives one venue failing (Promise.allSettled)', async () => {
    const fetchImpl = async (_url, init) => {
      if (init.headers.rfWidgetId === 'w-b') throw new Error('Berlin down');
      const params = new URLSearchParams(init.body);
      if (Number(params.get('from')) > 0) return fakeResponse({ responseCode: '0', sectionList: [{ items: [] }] });
      return fakeResponse(FIXTURE.VIRTUAL[params.get('type')]);
    };
    const out = await fetchAllTechEdSessions({ _fetch: fetchImpl, venues: VENUES, now: NOW_BEFORE });
    expect(out.sessions.every((s) => s.venue === 'VIRTUAL')).toBe(true);
    expect(out.sessions).toHaveLength(2);
  });
});

describe('parseVenuePayload', () => {
  it('prefers the standalone speaker catalog but backfills from participants', () => {
    const { speakers } = parseVenuePayload({
      venue: 'VIRTUAL',
      sessionItems: FIXTURE.VIRTUAL.session.sectionList[0].items,
      speakerItems: [],
    });
    // no speaker catalog → speakers come from session participants
    expect(speakers.map((s) => s.sourceId).sort()).toEqual(['spk-1', 'spk-2']);
    expect(speakers.find((s) => s.sourceId === 'spk-2').name).toBe('Grace Hopper');
  });
});
