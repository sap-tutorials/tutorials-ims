// test/unit/teched-seed.test.js
// Seed upsert/skip logic against in-memory SQLite reflecting db/*.cds.
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
    expect(summary.sessions.inserted).toBe(3);
    const rows = await SELECT.from(entities().TechEdSessions);
    expect(rows).toHaveLength(0);
  });

  it('commit inserts sessions/speakers/tracks/links and resolves associations', async () => {
    const db = await cds.connect.to('db');
    const e = entities();
    const summary = await runSeed({ db, entities: e, data: DATA, commit: true });
    expect(summary.tracks.inserted).toBe(2);
    expect(summary.speakers.inserted).toBe(2);
    expect(summary.sessions.inserted).toBe(3);
    expect(summary.links.inserted).toBe(3); // s1→spk-1, s2→spk-2, s3→spk-1

    const sessions = await SELECT.from(e.TechEdSessions);
    expect(sessions).toHaveLength(3);

    // slug dedup on the duplicate DEV101 code
    const slugs = sessions.map((s) => s.slug).sort();
    expect(slugs).toContain('dev101');
    expect(slugs).toContain('dev101-2');

    // track association resolved
    const tracks = await SELECT.from(e.TechEdTracks);
    const appdev = tracks.find((t) => t.sourceId === 'trk-appdev');
    const dev = sessions.find((s) => s.sourceId === 's-tev-1001');
    expect(dev.track_ID).toBe(appdev.ID);

    // junction rows
    const links = await SELECT.from(e.TechEdSessionSpeakers);
    expect(links).toHaveLength(3);
  });

  it('second run with unchanged data skips everything (idempotent)', async () => {
    const db = await cds.connect.to('db');
    const e = entities();
    await runSeed({ db, entities: e, data: DATA, commit: true });
    const second = await runSeed({ db, entities: e, data: DATA, commit: true });
    expect(second.sessions.skipped).toBe(3);
    expect(second.sessions.inserted).toBe(0);
    expect(second.sessions.updated).toBe(0);
    expect(second.speakers.skipped).toBe(2);
    expect(second.tracks.skipped).toBe(2);
    expect(second.links.inserted).toBe(0); // links already present
  });

  it('changed source field updates the row but preserves pinUntil', async () => {
    const db = await cds.connect.to('db');
    const e = entities();
    await runSeed({ db, entities: e, data: DATA, commit: true });

    // pin one session (curated/lifecycle column)
    const pin = new Date('2099-01-01T00:00:00Z').toISOString();
    await UPDATE(e.TechEdSessions).set({ pinUntil: pin }).where({ sourceId: 's-tev-1002' });

    // change the title of that session
    const mutated = structuredClone(DATA);
    mutated.sessions.find((s) => s.sourceId === 's-tev-1002').title = 'Generative AI on SAP BTP (v2)';

    const summary = await runSeed({ db, entities: e, data: mutated, commit: true });
    expect(summary.sessions.updated).toBe(1);
    expect(summary.sessions.skipped).toBe(2);

    const row = await SELECT.one.from(e.TechEdSessions).where({ sourceId: 's-tev-1002' });
    expect(row.title).toBe('Generative AI on SAP BTP (v2)');
    // pinUntil must NOT be wiped by the source-owned update
    expect(row.pinUntil).toBeTruthy();
    expect(new Date(row.pinUntil).toISOString()).toBe(pin);
  });

  it('--force re-updates even when contentHash is unchanged', async () => {
    const db = await cds.connect.to('db');
    const e = entities();
    await runSeed({ db, entities: e, data: DATA, commit: true });
    const forced = await runSeed({ db, entities: e, data: DATA, commit: true, force: true });
    expect(forced.sessions.updated).toBe(3);
    expect(forced.sessions.skipped).toBe(0);
  });

  it('prunes a junction link when a speaker is dropped from a session upstream', async () => {
    const db = await cds.connect.to('db');
    const e = entities();
    await runSeed({ db, entities: e, data: DATA, commit: true });

    // drop spk-1 from the Berlin session (s-te-2001) upstream
    const mutated = structuredClone(DATA);
    const berlin = mutated.sessions.find((s) => s.sourceId === 's-te-2001');
    berlin.speakerSourceIds = [];
    berlin.title = `${berlin.title} (no speaker)`; // force a re-write so the row updates

    const summary = await runSeed({ db, entities: e, data: mutated, commit: true });
    expect(summary.links.removed).toBe(1);

    const links = await SELECT.from(e.TechEdSessionSpeakers);
    expect(links).toHaveLength(2); // was 3, one pruned
  });
});
