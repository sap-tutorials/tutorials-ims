// test/unit/mcp-teched-search.test.js
//
// Unit tests for the search_teched MCP tool handler (Tier 2). Deploys the db
// model to in-memory SQLite, seeds TechEd sessions/tracks/speakers/links, and
// drives the handler directly with a minimal fake req — no MCP adapter, no HTTP.

import { expect, describe, it, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { handleSearchTechEd } from '../../srv/lib/mcp-teched-search.js';

const NS = 'com.sap.developers.ims.external';

// Distinct instants so ordering is deterministic: s1 < s3 < s2.
const T1 = '2026-11-03T09:00:00Z';
const T2 = '2026-11-03T15:00:00Z';
const T3 = '2026-11-03T11:00:00Z';

let TechEdSessions, TechEdTracks, TechEdSpeakers, TechEdSessionSpeakers;

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db')).to('sqlite::memory:');
  ({ TechEdSessions, TechEdTracks, TechEdSpeakers, TechEdSessionSpeakers } = cds.entities(NS));

  const uid = () => cds.utils.uuid();
  const capTrackId = uid();
  const abapTrackId = uid();
  const s1 = uid(), s2 = uid(), s3 = uid();
  const spkAlice = uid(), spkBob = uid();

  await INSERT.into(TechEdTracks).entries([
    { ID: capTrackId, sourceId: 'trk-cap', slug: 'track-cap', name: 'CAP & BTP', venue: 'BERLIN', description: 'CAP track' },
    { ID: abapTrackId, sourceId: 'trk-abap', slug: 'track-abap', name: 'ABAP Cloud', venue: 'VIRTUAL', description: 'ABAP track' },
  ]);

  await INSERT.into(TechEdSpeakers).entries([
    { ID: spkAlice, sourceId: 'spk-1', slug: 'alice-dev', name: 'Alice Dev', title: 'Architect', company: 'SAP' },
    { ID: spkBob, sourceId: 'spk-2', slug: 'bob-eng', name: 'Bob Eng', title: 'Engineer', company: 'SAP' },
  ]);

  await INSERT.into(TechEdSessions).entries([
    { ID: s1, sourceId: 'src-1', slug: 'cap-deep-dive', venue: 'BERLIN', sessionCode: 'DEV101',
      title: 'CAP Deep Dive', abstract: 'Learn CAP on BTP with hands-on exercises.',
      scheduledStart: T1, room: 'Hall A', url: 'https://teched.sap.com/cap-deep-dive', track_ID: capTrackId },
    { ID: s2, sourceId: 'src-2', slug: 'abap-cloud-clean-core', venue: 'VIRTUAL', sessionCode: 'DEV202',
      title: 'ABAP Cloud', abstract: 'Clean core ABAP for the cloud era.',
      scheduledStart: T2, room: 'Virtual Room 2', url: 'https://teched.sap.com/abap-cloud', track_ID: abapTrackId },
    { ID: s3, sourceId: 'src-3', slug: 'fiori-elements', venue: 'BERLIN', sessionCode: 'UX303',
      title: 'Fiori Elements', abstract: 'Build UIs fast with annotations.',
      scheduledStart: T3, room: 'Hall B', url: 'https://teched.sap.com/fiori-elements', track_ID: capTrackId },
  ]);

  await INSERT.into(TechEdSessionSpeakers).entries([
    { ID: uid(), session_ID: s1, speaker_ID: spkAlice },
    { ID: uid(), session_ID: s1, speaker_ID: spkBob },
    { ID: uid(), session_ID: s2, speaker_ID: spkBob },
  ]);
});

afterAll(async () => {
  await cds.disconnect();
  delete cds.db;
  delete cds.model;
});

const call = (data) => handleSearchTechEd({ data });
const slugs = (rows) => rows.map((r) => r.slug).sort();

describe('search_teched', () => {
  it('returns all sessions ordered by scheduledStart when no filter is given', async () => {
    const rows = await call({});
    expect(rows.map((r) => r.slug)).toEqual(['cap-deep-dive', 'fiori-elements', 'abap-cloud-clean-core']);
  });

  it('filters by venue BERLIN', async () => {
    expect(slugs(await call({ venue: 'BERLIN' }))).toEqual(['cap-deep-dive', 'fiori-elements']);
  });

  it('filters by venue VIRTUAL (case-insensitive input)', async () => {
    expect(slugs(await call({ venue: 'virtual' }))).toEqual(['abap-cloud-clean-core']);
  });

  it('ignores an unknown venue (no filter applied)', async () => {
    expect(await call({ venue: 'MARS' })).toHaveLength(3);
  });

  it('filters by track slug', async () => {
    expect(slugs(await call({ track: 'track-cap' }))).toEqual(['cap-deep-dive', 'fiori-elements']);
  });

  it('filters by track name substring (case-insensitive)', async () => {
    expect(slugs(await call({ track: 'abap' }))).toEqual(['abap-cloud-clean-core']);
  });

  it('returns [] for a named-but-unknown track', async () => {
    expect(await call({ track: 'no-such-track' })).toEqual([]);
  });

  it('does a case-insensitive free-text match on title', async () => {
    expect(slugs(await call({ query: 'fiori' }))).toEqual(['fiori-elements']);
    expect(await call({ query: 'zzzz-no-match' })).toEqual([]);
  });

  it('matches free-text against the abstract LOB column', async () => {
    // "clean core" only appears in the abstract of the ABAP session.
    expect(slugs(await call({ query: 'clean core' }))).toEqual(['abap-cloud-clean-core']);
  });

  it('returns the abstract LOB in the wire shape', async () => {
    const [row] = await call({ venue: 'VIRTUAL' });
    expect(row.abstract).toBe('Clean core ABAP for the cloud era.');
  });

  it('clamps limit to [1,50]', async () => {
    expect(await call({ limit: 1 })).toHaveLength(1);
    expect((await call({ limit: 0 })).length).toBe(1); // explicit 0 clamps to floor 1
    expect((await call({})).length).toBe(3); // omitted → default 20; all rows fit
  });

  it('returns the documented wire shape with resolved track and speakers', async () => {
    const [row] = await call({ query: 'CAP Deep Dive' });
    expect(row).toMatchObject({
      slug: 'cap-deep-dive',
      title: 'CAP Deep Dive',
      venue: 'BERLIN',
      track: 'track-cap',
      room: 'Hall A',
      url: 'https://teched.sap.com/cap-deep-dive',
    });
    expect(row).toHaveProperty('scheduledStart');
    expect(row.speakers).toEqual(['Alice Dev', 'Bob Eng']); // sorted
  });

  it('combines venue + query filters', async () => {
    // 'build' is only in the Fiori abstract, which is a BERLIN session.
    expect(slugs(await call({ venue: 'BERLIN', query: 'build' }))).toEqual(['fiori-elements']);
    // Same query with VIRTUAL venue yields nothing.
    expect(await call({ venue: 'VIRTUAL', query: 'build' })).toEqual([]);
  });
});
