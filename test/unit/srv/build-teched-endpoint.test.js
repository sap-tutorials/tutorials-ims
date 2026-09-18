// test/unit/srv/build-teched-endpoint.test.js
// Public /build/teched feed (issue #2312). Verifies the bounded, LOB-safe
// rewrite: same {sessions,speakers,tracks,buildAt} shape, LOBs present, public
// projection (no source/audit fields), and optional venue/upcoming scoping.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';
import { runSeed } from '../../../srv/lib/teched/seed-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NS = 'com.sap.developers.ims.external';
const project = cds.test('serve', '--project', '.', '--in-memory');

const DATA = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'teched', 'teched-feed.json'), 'utf8'),
);

function entities() {
  const { TechEdSessions, TechEdSpeakers, TechEdTracks, TechEdSessionSpeakers } = cds.entities(NS);
  return { TechEdSessions, TechEdSpeakers, TechEdTracks, TechEdSessionSpeakers };
}

describe('GET /build/teched', () => {
  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const e = entities();
    // clean slate, then seed the real-capture fixture (6 sessions / 10 speakers / 4 tracks)
    await DELETE.from(e.TechEdSessionSpeakers);
    await DELETE.from(e.TechEdSessions);
    await DELETE.from(e.TechEdSpeakers);
    await DELETE.from(e.TechEdTracks);
    await runSeed({ db, entities: e, data: DATA, commit: true });
  });

  it('returns 200 with the {sessions,speakers,tracks,buildAt} shape + 60s public cache', async () => {
    const { status, headers, data } = await project.get('/build/teched');
    expect(status).toBe(200);
    expect(headers['cache-control']).toBe('public, max-age=60');
    expect(Array.isArray(data.sessions)).toBe(true);
    expect(Array.isArray(data.speakers)).toBe(true);
    expect(Array.isArray(data.tracks)).toBe(true);
    expect(typeof data.buildAt).toBe('string');
    expect(data.sessions).toHaveLength(6);
    expect(data.speakers).toHaveLength(10);
    expect(data.tracks).toHaveLength(4);
  });

  it('emits LOBs (abstract/bio/description), venue, and relatedDevtoberfestSessions per session', async () => {
    const { data } = await project.get('/build/teched');
    const key = data.sessions.find((s) => s.sessionCode === 'KEY100');
    expect(key).toBeTruthy();
    expect(key.venue).toBe('BERLIN');
    expect(typeof key.abstract).toBe('string');
    expect(key.abstract.length).toBeGreaterThan(0);
    expect(Array.isArray(key.relatedDevtoberfestSessions)).toBe(true);
    // bio LOB present on at least one speaker
    expect(data.speakers.some((s) => typeof s.bio === 'string' && s.bio.length > 0)).toBe(true);
    // every session carries a venue
    expect(data.sessions.every((s) => s.venue === 'BERLIN' || s.venue === 'VIRTUAL')).toBe(true);
  });

  it('drops source/audit fields from the public projection', async () => {
    const { data } = await project.get('/build/teched');
    const bodyStr = JSON.stringify(data);
    for (const leaked of ['sourceId', 'contentHash', 'lastExtractedHash', 'firstSeenAt', 'lastSeenAt', 'pinUntil', 'createdBy', 'modifiedBy']) {
      expect(bodyStr).not.toMatch(new RegExp(leaked));
    }
  });

  it('is bounded (well under the 1000-session cap for this catalog)', async () => {
    const { data } = await project.get('/build/teched');
    expect(data.sessions.length).toBeLessThanOrEqual(1000);
  });

  it('every emitted session resolves its track and speakers (no dropped dimension rows)', async () => {
    const { data } = await project.get('/build/teched');
    // Fixture: every session references a track and >=1 speaker.
    for (const s of data.sessions) {
      expect(s.track, `session ${s.sessionCode} lost its track`).toBeTruthy();
      expect(s.speakers.length, `session ${s.sessionCode} lost its speakers`).toBeGreaterThan(0);
      // each referenced speaker slug must be present in the emitted speakers array
      for (const slug of s.speakers) {
        expect(data.speakers.some((sp) => sp.slug === slug)).toBe(true);
      }
    }
  });

  it('?venue=VIRTUAL scopes sessions to that venue only', async () => {
    const { data } = await project.get('/build/teched?venue=VIRTUAL');
    expect(data.sessions.length).toBeGreaterThan(0);
    expect(data.sessions.every((s) => s.venue === 'VIRTUAL')).toBe(true);
    // BERLIN keynote must be absent
    expect(data.sessions.some((s) => s.sessionCode === 'KEY100')).toBe(false);
  });

  it('?upcoming=true keeps not-yet-ended sessions (fixture is in 2026-10)', async () => {
    const { data } = await project.get('/build/teched?upcoming=true');
    expect(data.sessions.length).toBe(6);
  });
});
