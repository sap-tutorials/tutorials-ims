// test/unit/teched-devtoberfest-crosslink.test.js
//
// Unit 9 of #2312 — bidirectional TechEd ↔ Devtoberfest related-session
// cross-linking. Covers the pure ranking helpers, the assembleFeed wiring, and
// the flag-gated / fail-open orchestrators against in-memory SQLite.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';
import {
  buildRelatedTechEdBySlug,
  buildRelatedDevtoberfestByTechEd,
  computeRelatedTechEdBySlug,
  computeRelatedDevtoberfestByTechEd,
  MAX_RELATED_SESSIONS,
  __bustTechEdCacheForTest,
} from '../../srv/lib/teched-devtoberfest-crosslink.js';
import { assembleFeed } from '../../srv/lib/devtoberfest-feed.js';
import { __setFlagForTest, __resetFlagsForTest } from '../../srv/lib/feature-flags/db-flags.js';

const FLAG = 'TECHED_DEVTOBERFEST_CROSSLINK_ENABLED';
const KG_NS = 'com.sap.developers.ims';
const EXT_NS = 'com.sap.developers.ims.external';

const project = cds.test('serve', '--project', '.', '--in-memory');
void project;

// ── PURE helpers ────────────────────────────────────────────────────────────

describe('buildRelatedTechEdBySlug (pure)', () => {
  const techEd = [
    { slug: 'te-a', title: 'TechEd A', sessionCode: 'A1', venue: 'BERLIN', url: 'u/a', conceptIds: new Set(['c1', 'c2']) },
    { slug: 'te-b', title: 'TechEd B', sessionCode: 'B1', venue: 'VIRTUAL', url: 'u/b', conceptIds: new Set(['c1']) },
    { slug: 'te-c', title: 'TechEd C', sessionCode: 'C1', venue: 'BERLIN', url: 'u/c', conceptIds: new Set(['c9']) },
  ];

  it('ranks by concept-overlap count and excludes zero-overlap sessions', () => {
    const tut = new Map([['my-tut', new Set(['c1', 'c2'])]]);
    const out = buildRelatedTechEdBySlug(tut, techEd);
    const related = out.get('my-tut');
    expect(related.map((r) => r.slug)).toEqual(['te-a', 'te-b']); // te-c has 0 overlap
    expect(related[0].sharedConceptCount).toBe(2);
    expect(related[1].sharedConceptCount).toBe(1);
  });

  it('caps at MAX_RELATED_SESSIONS', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      slug: `te-${i}`, title: `T${i}`, conceptIds: new Set(['c1']),
    }));
    const tut = new Map([['my-tut', new Set(['c1'])]]);
    const out = buildRelatedTechEdBySlug(tut, many);
    expect(out.get('my-tut')).toHaveLength(MAX_RELATED_SESSIONS);
  });

  it('returns an empty map for empty / absent inputs (fail-open shape)', () => {
    expect(buildRelatedTechEdBySlug(new Map(), techEd).size).toBe(0);
    expect(buildRelatedTechEdBySlug(new Map([['s', new Set(['c1'])]]), []).size).toBe(0);
    expect(buildRelatedTechEdBySlug(null, techEd).size).toBe(0);
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

  it('attaches related TechEd sessions resolved via the activity task slug (lowercased)', () => {
    const relatedTechEdBySlug = new Map([['intro-slug', [{ slug: 'te-a', title: 'TechEd A', sharedConceptCount: 2 }]]]);
    const out = assembleFeed({ sessions, activities, tracks, editions: [], activeEditionId: null, relatedTechEdBySlug });
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
    const { Tutorials, Concepts, TutorialConceptLinks } = cds.entities(KG_NS);
    const { TechEdSessions, TechEdSessionConceptLinks } = cds.entities(EXT_NS);
    await DELETE.from(TutorialConceptLinks);
    await DELETE.from(TechEdSessionConceptLinks);
    await DELETE.from(TechEdSessions);
    await DELETE.from(Tutorials);
    await DELETE.from(Concepts);
    await INSERT.into(Concepts).entries([
      { ID: 'c1', slug: 'concept-1', status: 'ACTIVE' },
      { ID: 'c2', slug: 'concept-2', status: 'ACTIVE' },
      { ID: 'c3', slug: 'concept-3', status: 'ACTIVE' },
    ]);
    await INSERT.into(Tutorials).entries([{ ID: 'tut1', slug: 'my-tutorial', title: 'My Tutorial' }]);
    await INSERT.into(TutorialConceptLinks).entries([
      { ID: 'l1', tutorial_ID: 'tut1', concept_ID: 'c1', predicate: 'teaches' },
      { ID: 'l2', tutorial_ID: 'tut1', concept_ID: 'c2', predicate: 'teaches' },
    ]);
    await INSERT.into(TechEdSessions).entries([
      { ID: 'te1', slug: 'teched-a', title: 'TechEd A', sessionCode: 'A1', venue: 'BERLIN', url: 'u/a', sourceId: 'src-a' },
      { ID: 'te2', slug: 'teched-b', title: 'TechEd B', sessionCode: 'B1', venue: 'VIRTUAL', url: 'u/b', sourceId: 'src-b' },
      { ID: 'te3', slug: 'teched-c', title: 'TechEd C', sessionCode: 'C1', venue: 'BERLIN', url: 'u/c', sourceId: 'src-c' },
    ]);
    await INSERT.into(TechEdSessionConceptLinks).entries([
      { ID: 'k1', session_ID: 'te1', concept_ID: 'c1' },
      { ID: 'k2', session_ID: 'te1', concept_ID: 'c2' }, // te-a overlap 2
      { ID: 'k3', session_ID: 'te2', concept_ID: 'c1' }, // te-b overlap 1
      { ID: 'k4', session_ID: 'te3', concept_ID: 'c3' }, // te-c overlap 0
    ]);
  }

  beforeEach(async () => {
    await cds.connect.to('db');
    await seed();
    __bustTechEdCacheForTest();
  });
  afterEach(() => __resetFlagsForTest());

  it('computeRelatedTechEdBySlug populates related sessions ranked by overlap when flag ON', async () => {
    __setFlagForTest(FLAG, true);
    const out = await computeRelatedTechEdBySlug(new Set(['my-tutorial']));
    const related = out.get('my-tutorial');
    expect(related.map((r) => r.slug)).toEqual(['teched-a', 'teched-b']);
    expect(related[0].sharedConceptCount).toBe(2);
    expect(related[1].sharedConceptCount).toBe(1);
  });

  it('computeRelatedTechEdBySlug returns empty map when flag OFF', async () => {
    __setFlagForTest(FLAG, false);
    const out = await computeRelatedTechEdBySlug(new Set(['my-tutorial']));
    expect(out.size).toBe(0);
  });

  it('computeRelatedDevtoberfestByTechEd fails soft to empty map when planner facades absent (SQLite)', async () => {
    __setFlagForTest(FLAG, true);
    const out = await computeRelatedDevtoberfestByTechEd();
    expect(out).toBeInstanceOf(Map);
    expect(out.size).toBe(0); // DTF facades are @cds.persistence.exists — not created on SQLite
  });
});
