// test/unit/teched-seed.test.js
// Seed upsert/skip logic against in-memory SQLite reflecting db/*.cds.
// Fixture is derived from a REAL RainFocus capture (see teched-feed.json).
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import cds from '@sap/cds';
import { runSeed } from '../../srv/lib/teched/seed-core.js';

const NAMESPACE_EXT = 'com.sap.developers.ims.external';

const { test } = cds;
test.in(__dirname, '..', '..');
test('serve', 'all', '--in-memory');

const DATA = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'fixtures', 'teched', 'teched-feed.json'), 'utf8'),
);

// Known ids from the real fixture.
const AD262 = '1786525647304001OTzl';        // Berlin AD track, 4 speakers
const ST134V = '1787735938125001muyh';       // Virtual XP track
const TRACK_AD = '1745939183774002kMU7';

function entities() {
  const { TechEdSessions, TechEdSpeakers, TechEdTracks, TechEdSessionSpeakers } = cds.entities(NAMESPACE_EXT);
  return { TechEdSessions, TechEdSpeakers, TechEdTracks, TechEdSessionSpeakers };
}

async function clean() {
  const e = entities();
  await DELETE.from(e.TechEdSessionSpeakers);
  await DELETE.from(e.TechEdSessions);
  await DELETE.from(e.TechEdSpeakers);
  await DELETE.from(e.TechEdTracks);
}

describe('runSeed', () => {
  beforeEach(async () => {
    await cds.connect.to('db');
    await clean();
  });

  it('dry-run writes nothing', async () => {
    const db = await cds.connect.to('db');
    const summary = await runSeed({ db, entities: entities(), data: DATA, commit: false });
    expect(summary.sessions.inserted).toBe(6);
    const rows = await SELECT.from(entities().TechEdSessions);
    expect(rows).toHaveLength(0);
  });

  it('commit inserts sessions/speakers/tracks/links and resolves associations', async () => {
    const db = await cds.connect.to('db');
    const e = entities();
    const summary = await runSeed({ db, entities: e, data: DATA, commit: true });
    expect(summary.tracks.inserted).toBe(4);
    expect(summary.speakers.inserted).toBe(10);
    expect(summary.sessions.inserted).toBe(6);
    // 1 + 1 + 4 + 1 + 1 + 2 = 10 session↔speaker links
    expect(summary.links.inserted).toBe(10);

    const sessions = await SELECT.from(e.TechEdSessions);
    expect(sessions).toHaveLength(6);

    // track association resolved (AD track shared across two sessions)
    const tracks = await SELECT.from(e.TechEdTracks);
    const ad = tracks.find((t) => t.sourceId === TRACK_AD);
    const ad262 = sessions.find((s) => s.sourceId === AD262);
    expect(ad262.track_ID).toBe(ad.ID);

    const links = await SELECT.from(e.TechEdSessionSpeakers);
    expect(links).toHaveLength(10);
  });

  it('second run with unchanged data skips everything (idempotent)', async () => {
    const db = await cds.connect.to('db');
    const e = entities();
    await runSeed({ db, entities: e, data: DATA, commit: true });
    const second = await runSeed({ db, entities: e, data: DATA, commit: true });
    expect(second.sessions.skipped).toBe(6);
    expect(second.sessions.inserted).toBe(0);
    expect(second.sessions.updated).toBe(0);
    expect(second.speakers.skipped).toBe(10);
    expect(second.tracks.skipped).toBe(4);
    expect(second.links.inserted).toBe(0); // links already present
  });

  it('changed source field updates the row but preserves pinUntil', async () => {
    const db = await cds.connect.to('db');
    const e = entities();
    await runSeed({ db, entities: e, data: DATA, commit: true });

    // pin one session (curated/lifecycle column)
    const pin = new Date('2099-01-01T00:00:00Z').toISOString();
    await UPDATE(e.TechEdSessions).set({ pinUntil: pin }).where({ sourceId: ST134V });

    // change the title of that session
    const mutated = structuredClone(DATA);
    mutated.sessions.find((s) => s.sourceId === ST134V).title = 'SAP Business AI Platform (v2)';

    const summary = await runSeed({ db, entities: e, data: mutated, commit: true });
    expect(summary.sessions.updated).toBe(1);
    expect(summary.sessions.skipped).toBe(5);

    const row = await SELECT.one.from(e.TechEdSessions).where({ sourceId: ST134V });
    expect(row.title).toBe('SAP Business AI Platform (v2)');
    // pinUntil must NOT be wiped by the source-owned update
    expect(row.pinUntil).toBeTruthy();
    expect(new Date(row.pinUntil).toISOString()).toBe(pin);
  });

  it('--force re-updates even when contentHash is unchanged', async () => {
    const db = await cds.connect.to('db');
    const e = entities();
    await runSeed({ db, entities: e, data: DATA, commit: true });
    const forced = await runSeed({ db, entities: e, data: DATA, commit: true, force: true });
    expect(forced.sessions.updated).toBe(6);
    expect(forced.sessions.skipped).toBe(0);
  });

  it('prunes a junction link when a speaker is dropped from a session upstream', async () => {
    const db = await cds.connect.to('db');
    const e = entities();
    await runSeed({ db, entities: e, data: DATA, commit: true });

    // drop one speaker from AD262 (has 4) upstream
    const mutated = structuredClone(DATA);
    const ad = mutated.sessions.find((s) => s.sourceId === AD262);
    ad.speakerSourceIds = ad.speakerSourceIds.slice(0, 3); // 4 → 3
    ad.title = `${ad.title} (updated)`; // force a re-write so the row updates

    const summary = await runSeed({ db, entities: e, data: mutated, commit: true });
    expect(summary.links.removed).toBe(1);

    const links = await SELECT.from(e.TechEdSessionSpeakers);
    expect(links).toHaveLength(9); // was 10, one pruned
  });

  it('retains existing links when a re-seed omits a session\'s speakers (incomplete input)', async () => {
    const db = await cds.connect.to('db');
    const e = entities();
    await runSeed({ db, entities: e, data: DATA, commit: true });

    const before = await SELECT.from(e.TechEdSessionSpeakers).where({
      session_ID: { in: SELECT.from(e.TechEdSessions).columns('ID').where({ sourceId: AD262 }) },
    });
    expect(before.length).toBe(4); // AD262 has 4 speakers

    // partial/subset re-seed: AD262 comes back with no speakers at all
    const mutated = structuredClone(DATA);
    const ad = mutated.sessions.find((s) => s.sourceId === AD262);
    ad.speakerSourceIds = []; // omitted upstream
    ad.title = `${ad.title} (updated)`; // force a re-write so the row updates

    const summary = await runSeed({ db, entities: e, data: mutated, commit: true });
    expect(summary.links.removed).toBe(0); // nothing pruned on empty input

    const after = await SELECT.from(e.TechEdSessionSpeakers).where({
      session_ID: { in: SELECT.from(e.TechEdSessions).columns('ID').where({ sourceId: AD262 }) },
    });
    expect(after.length).toBe(4); // links RETAINED, not wiped
  });

  it('retains links when a session still carries speakers but the batch omits those speaker rows (subset seed)', async () => {
    const db = await cds.connect.to('db');
    const e = entities();
    await runSeed({ db, entities: e, data: DATA, commit: true });

    const sessionLinks = () =>
      SELECT.from(e.TechEdSessionSpeakers).where({
        session_ID: { in: SELECT.from(e.TechEdSessions).columns('ID').where({ sourceId: AD262 }) },
      });
    expect((await sessionLinks()).length).toBe(4);

    // subset seed: AD262 still carries its speakerSourceIds, but data.speakers
    // omits those speaker rows entirely (so none resolve in this batch).
    const mutated = structuredClone(DATA);
    const ad = mutated.sessions.find((s) => s.sourceId === AD262);
    const adSpeakerIds = new Set(ad.speakerSourceIds);
    mutated.speakers = mutated.speakers.filter((sp) => !adSpeakerIds.has(sp.sourceId));

    const summary = await runSeed({ db, entities: e, data: mutated, commit: true });
    expect(summary.links.removed).toBe(0); // unresolved speakers are not confirmed removals

    expect((await sessionLinks()).length).toBe(4); // links RETAINED
  });
});
