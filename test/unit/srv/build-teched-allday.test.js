// test/unit/srv/build-teched-allday.test.js
// Public /build/teched feed — all-day activities (issue #2392 item 6). Proves
// the `allDay` boolean flows sourceId → normalize → seed → the public feed, and
// that timed sessions carry allDay=false. Seeds the base capture PLUS the
// derived all-day fixture so the feed contains both kinds.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';
import { runSeed } from '../../../srv/lib/teched/seed-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NS = 'com.sap.developers.ims.external';
const project = cds.test('serve', '--project', '.', '--in-memory');

const fx = (name) => JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'teched', name), 'utf8'),
);
const BASE = fx('teched-feed.json');
const ALLDAY = fx('teched-allday-feed.json');
// Merge: base timed sessions + all-day rows in one seed batch.
const MERGED = {
  sessions: [...BASE.sessions, ...ALLDAY.sessions],
  speakers: [...BASE.speakers, ...ALLDAY.speakers],
  tracks: [...BASE.tracks, ...ALLDAY.tracks],
};

const GARAGE_CODE = 'allday-1786600000000001adgb';

function entities() {
  const { TechEdSessions, TechEdSpeakers, TechEdTracks, TechEdSessionSpeakers } = cds.entities(NS);
  return { TechEdSessions, TechEdSpeakers, TechEdTracks, TechEdSessionSpeakers };
}

describe('GET /build/teched — all-day activities', () => {
  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const e = entities();
    await DELETE.from(e.TechEdSessionSpeakers);
    await DELETE.from(e.TechEdSessions);
    await DELETE.from(e.TechEdSpeakers);
    await DELETE.from(e.TechEdTracks);
    await runSeed({ db, entities: e, data: MERGED, commit: true });
  });

  it('emits the allDay boolean on every session', async () => {
    const { data } = await project.get('/build/teched');
    // 6 timed (base) + 2 all-day
    expect(data.sessions).toHaveLength(8);
    // Every session has a strict boolean allDay (never undefined/null/0/1)
    for (const s of data.sessions) {
      expect(typeof s.allDay).toBe('boolean');
    }
  });

  it('marks the Developer Garage all-day and timed sessions not-all-day', async () => {
    const { data } = await project.get('/build/teched');
    const garage = data.sessions.find((s) => s.sessionCode === GARAGE_CODE);
    expect(garage).toBeTruthy();
    expect(garage.allDay).toBe(true);
    expect(garage.title).toBe('Developer Garage');
    // all-day activities have no scheduled start
    expect(garage.scheduledStart == null).toBe(true);

    const timed = data.sessions.find((s) => s.sessionCode === 'KEY100');
    expect(timed).toBeTruthy();
    expect(timed.allDay).toBe(false);
  });

  it('the all-day set is exactly the two seeded activities', async () => {
    const { data } = await project.get('/build/teched');
    const allDayTitles = data.sessions.filter((s) => s.allDay).map((s) => s.title).sort();
    expect(allDayTitles).toEqual(['AI Showfloor Expo', 'Developer Garage']);
  });

  it('?upcoming=true keeps all-day activities (NULL scheduledEnd must not drop them)', async () => {
    const { data } = await project.get('/build/teched?upcoming=true');
    // Both all-day activities survive the upcoming filter despite a NULL
    // scheduledEnd (issue #2392 — matches the fetcher dropPast carve-out).
    const allDay = data.sessions.filter((s) => s.allDay);
    expect(allDay.map((s) => s.title).sort()).toEqual(['AI Showfloor Expo', 'Developer Garage']);
    // timed sessions (fixture dated 2026-10) are still present too
    expect(data.sessions.some((s) => s.sessionCode === 'KEY100')).toBe(true);
  });

  it('?upcoming=true + ?venue=BERLIN still keeps the (Berlin) all-day activities', async () => {
    const { data } = await project.get('/build/teched?upcoming=true&venue=BERLIN');
    const allDay = data.sessions.filter((s) => s.allDay);
    expect(allDay.map((s) => s.title).sort()).toEqual(['AI Showfloor Expo', 'Developer Garage']);
    expect(data.sessions.every((s) => s.venue === 'BERLIN')).toBe(true);
  });
});
