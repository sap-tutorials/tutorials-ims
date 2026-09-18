// test/unit/teched-devtoberfest-crosslink.test.js
//
// Unit 9 of #2312 — bidirectional TechEd ↔ Devtoberfest related-session
// cross-linking. Covers the pure ranking helpers, the assembleFeed wiring, and
// the flag-gated / fail-open orchestrators against in-memory SQLite. Both
// session types are first-class KG nodes (#2311): the match is session↔session
// via their own concept-link tables (no activity/tutorial walk).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';
import {
  buildRelatedTechEdByDtfSession,
  buildRelatedDevtoberfestByTechEd,
  computeRelatedTechEdByDtfSession,
  computeRelatedDevtoberfestByTechEd,
  MAX_RELATED_SESSIONS,
  __bustTechEdCacheForTest,
} from '../../srv/lib/teched-devtoberfest-crosslink.js';
import { assembleFeed } from '../../srv/lib/devtoberfest-feed.js';
import { __setFlagForTest, __resetFlagsForTest } from '../../srv/lib/feature-flags/db-flags.js';

const FLAG = 'TECHED_DEVTOBERFEST_CROSSLINK_ENABLED';
const EXT_NS = 'com.sap.developers.ims.external';

const project = cds.test('serve', '--project', '.', '--in-memory');
void project;

// ── PURE helpers ────────────────────────────────────────────────────────────

describe('buildRelatedTechEdByDtfSession (pure)', () => {
  const techEd = [
    { slug: 'te-a', title: 'TechEd A', sessionCode: 'A1', venue: 'BERLIN', url: 'u/a', conceptIds: new Set(['c1', 'c2']) },
    { slug: 'te-b', title: 'TechEd B', sessionCode: 'B1', venue: 'VIRTUAL', url: 'u/b', conceptIds: new Set(['c1']) },
    { slug: 'te-c', title: 'TechEd C', sessionCode: 'C1', venue: 'BERLIN', url: 'u/c', conceptIds: new Set(['c9']) },
  ];

  it('ranks by concept-overlap count and excludes zero-overlap sessions', () => {
    const dtf = [{ id: 'd1', slug: 'dtf-1', title: 'DTF 1', conceptIds: new Set(['c1', 'c2']) }];
    const out = buildRelatedTechEdByDtfSession(dtf, techEd);
    const related = out.get('d1');
    expect(related.map((r) => r.slug)).toEqual(['te-a', 'te-b']); // te-c has 0 overlap
    expect(related[0].sharedConceptCount).toBe(2);
    expect(related[1].sharedConceptCount).toBe(1);
  });

  it('caps at MAX_RELATED_SESSIONS', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      slug: `te-${i}`, title: `T${i}`, conceptIds: new Set(['c1']),
    }));
    const dtf = [{ id: 'd1', conceptIds: new Set(['c1']) }];
    const out = buildRelatedTechEdByDtfSession(dtf, many);
    expect(out.get('d1')).toHaveLength(MAX_RELATED_SESSIONS);
  });

  it('returns an empty map for empty / absent inputs (fail-open shape)', () => {
    expect(buildRelatedTechEdByDtfSession([], techEd).size).toBe(0);
    expect(buildRelatedTechEdByDtfSession([{ id: 'd1', conceptIds: new Set(['c1']) }], []).size).toBe(0);
    expect(buildRelatedTechEdByDtfSession(null, techEd).size).toBe(0);
  });
});

describe('buildRelatedDevtoberfestByTechEd (pure)', () => {
  it('ranks Devtoberfest sessions by overlap and excludes zero-overlap', () => {
    const techEd = [{ slug: 'te-a', conceptIds: new Set(['c1', 'c2']) }];
    const dtf = [
      { id: 'd1', title: 'DTF 1', sessionCode: 'D1', taskSlug: 't1', conceptIds: new Set(['c1', 'c2']) },
      { id: 'd2', title: 'DTF 2', sessionCode: 'D2', taskSlug: 't2', conceptIds: new Set(['c2']) },
      { id: 'd3', title: 'DTF 3', sessionCode: 'D3', taskSlug: 't3', conceptIds: new Set(['c9']) },
    ];
    const out = buildRelatedDevtoberfestByTechEd(techEd, dtf);
    const related = out.get('te-a');
    expect(related.map((r) => r.sessionId)).toEqual(['d1', 'd2']);
    expect(related[0].sharedConceptCount).toBe(2);
  });
});

// ── assembleFeed wiring ─────────────────────────────────────────────────────

describe('assembleFeed relatedTechEdSessions wiring', () => {
  const tracks = [{ ID: 't1', NAME: 'ABAP' }];
  const sessions = [{ ID: 's1', TITLE: 'Intro', TRACK_ID: 't1', STATUS: 'Confirmed', ACTIVITY_ID: 'a1' }];
  const activities = [{ ID: 'a1', TITLE: 'Do Intro', STATUS: 'Confirmed', TASKTYPE: 'TUTORIAL', TASKSLUG: 'Intro-Slug', TRACK_ID: 't1' }];

  it('attaches related TechEd sessions keyed by Devtoberfest session ID', () => {
    const relatedTechEdBySession = new Map([['s1', [{ slug: 'te-a', title: 'TechEd A', sharedConceptCount: 2 }]]]);
    const out = assembleFeed({ sessions, activities, tracks, editions: [], activeEditionId: null, relatedTechEdBySession });
    expect(out.sessions[0].relatedTechEdSessions).toHaveLength(1);
    expect(out.sessions[0].relatedTechEdSessions[0].slug).toBe('te-a');
  });

  it('defaults to an empty array when no cross-link map is supplied (flag OFF / absent)', () => {
    const out = assembleFeed({ sessions, activities, tracks, editions: [], activeEditionId: null });
    expect(out.sessions[0].relatedTechEdSessions).toEqual([]);
  });
});

// ── flag-gated / fail-open orchestrators (in-memory SQLite) ─────────────────

describe('cross-link orchestrators (SQLite)', () => {
  async function seed() {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const {
      TechEdSessions, TechEdSessionConceptLinks,
      DevtoberfestSessions, DevtoberfestSessionConceptLinks,
    } = cds.entities(EXT_NS);
    await DELETE.from(TechEdSessionConceptLinks);
    await DELETE.from(TechEdSessions);
    await DELETE.from(DevtoberfestSessionConceptLinks);
    await DELETE.from(DevtoberfestSessions);
    await DELETE.from(Concepts);
    await INSERT.into(Concepts).entries([
      { ID: 'c1', slug: 'concept-1', status: 'ACTIVE' },
      { ID: 'c2', slug: 'concept-2', status: 'ACTIVE' },
      { ID: 'c3', slug: 'concept-3', status: 'ACTIVE' },
    ]);
    await INSERT.into(TechEdSessions).entries([
      { ID: 'te1', slug: 'teched-a', title: 'TechEd A', sessionCode: 'A1', venue: 'BERLIN', url: 'u/a', sourceId: 'src-a' },
      { ID: 'te2', slug: 'teched-b', title: 'TechEd B', sessionCode: 'B1', venue: 'VIRTUAL', url: 'u/b', sourceId: 'src-b' },
      { ID: 'te3', slug: 'teched-c', title: 'TechEd C', sessionCode: 'C1', venue: 'BERLIN', url: 'u/c', sourceId: 'src-c' },
    ]);
    await INSERT.into(TechEdSessionConceptLinks).entries([
      { ID: 'k1', session_ID: 'te1', concept_ID: 'c1' },
      { ID: 'k2', session_ID: 'te1', concept_ID: 'c2' }, // te-a overlap 2 with d1
      { ID: 'k3', session_ID: 'te2', concept_ID: 'c1' }, // te-b overlap 1 with d1
      { ID: 'k4', session_ID: 'te3', concept_ID: 'c3' }, // te-c overlap 0 with d1
    ]);
    await INSERT.into(DevtoberfestSessions).entries([
      { ID: 'd1', slug: 'dtf-a', title: 'DTF A', sessionCode: 'DA', activityTaskSlug: 'my-tutorial', sourceId: 'psrc-a' },
      { ID: 'd2', slug: 'dtf-b', title: 'DTF B', sessionCode: 'DB', activityTaskSlug: 'other', sourceId: 'psrc-b' },
    ]);
    await INSERT.into(DevtoberfestSessionConceptLinks).entries([
      { ID: 'p1', session_ID: 'd1', concept_ID: 'c1' },
      { ID: 'p2', session_ID: 'd1', concept_ID: 'c2' }, // d1 overlaps te-a(2), te-b(1)
      { ID: 'p3', session_ID: 'd2', concept_ID: 'c3' }, // d2 overlaps te-c only
    ]);
  }

  beforeEach(async () => {
    await cds.connect.to('db');
    await seed();
    __bustTechEdCacheForTest();
  });
  afterEach(() => __resetFlagsForTest());

  it('computeRelatedTechEdByDtfSession ranks related TechEd sessions by overlap when flag ON', async () => {
    __setFlagForTest(FLAG, true);
    const out = await computeRelatedTechEdByDtfSession();
    const related = out.get('d1');
    expect(related.map((r) => r.slug)).toEqual(['teched-a', 'teched-b']);
    expect(related[0].sharedConceptCount).toBe(2);
    expect(related[1].sharedConceptCount).toBe(1);
    expect(out.get('d2').map((r) => r.slug)).toEqual(['teched-c']);
  });

  it('computeRelatedTechEdByDtfSession returns empty map when flag OFF', async () => {
    __setFlagForTest(FLAG, false);
    const out = await computeRelatedTechEdByDtfSession();
    expect(out.size).toBe(0);
  });

  it('computeRelatedDevtoberfestByTechEd ranks related Devtoberfest sessions by overlap when flag ON', async () => {
    __setFlagForTest(FLAG, true);
    const out = await computeRelatedDevtoberfestByTechEd();
    const related = out.get('teched-a');
    expect(related.map((r) => r.sessionId)).toEqual(['d1']);
    expect(related[0].sharedConceptCount).toBe(2);
    expect(out.get('teched-c').map((r) => r.sessionId)).toEqual(['d2']);
  });

  it('computeRelatedDevtoberfestByTechEd returns empty map when flag OFF', async () => {
    __setFlagForTest(FLAG, false);
    const out = await computeRelatedDevtoberfestByTechEd();
    expect(out.size).toBe(0);
  });
});
