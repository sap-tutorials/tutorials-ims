// test/unit/srv/build-teched-session-triples.test.js
//
// #2312: pure-function test for buildTechEdSessionTriples. Mirrors
// build-community-event-triples / build-devtoberfest-session-triples: the
// date-aware TTL gate (scheduledEnd + 30-day grace), link/edge filtering when
// the parent session is dropped, and the N-Triples IRI/predicate shape — plus
// the structural inTrack + presentedBy edges and the track/speaker nodes they
// point at.

import { describe, it, expect } from 'vitest';
import { buildTechEdSessionTriples } from '../../../srv/lib/kg-projection.js';

describe('buildTechEdSessionTriples', () => {
  const now = new Date();
  const day = 86400000;

  const fresh = {
    slug: 'te-s1', title: 'Build side-by-side extensions with SAP BTP',
    sessionCode: 'DEV201', venue: 'BERLIN', room: 'Hall A3',
    url: 'https://www.sap.com/teched/te-s1',
    youtubeUrl: 'https://youtu.be/teched1',
    scheduledStart: now, scheduledEnd: now,
    track_slug: 'te-track-extensions',
    speakerSlugs: ['sp-ada', 'sp-grace'],
    lastSeenAt: now,
  };
  // scheduledEnd 60 days past — beyond the endDate + 30-day grace window.
  const stale = {
    ...fresh, slug: 'te-s2',
    scheduledStart: new Date(now.getTime() - 61 * day),
    scheduledEnd: new Date(now.getTime() - 60 * day),
  };
  // No dates at all — date-aware TTL degrades to "always within" (finite
  // lastSeenAt only), like a still-scheduled event with no end.
  const undated = {
    ...fresh, slug: 'te-s3', scheduledStart: null, scheduledEnd: null,
  };

  const tracks = [{ slug: 'te-track-extensions', name: 'Extensions & Integration' }];
  const speakers = [
    { slug: 'sp-ada', name: 'Ada Lovelace' },
    { slug: 'sp-grace', name: 'Grace Hopper' },
  ];
  const link = (slug, conceptSlug) => ({ session_slug: slug, conceptSlug, predicate: 'covers' });

  it('emits a node + slug/title/sessionCode/venue/room/url literals for a fresh session', () => {
    const triples = buildTechEdSessionTriples({ sessions: [fresh], links: [], tracks, speakers });
    expect(triples.some((t) => t.includes('teched-session/te-s1'))).toBe(true);
    expect(triples.some((t) => t.includes('TechEdSession'))).toBe(true);
    expect(triples.some((t) => t.includes('DEV201'))).toBe(true);
    expect(triples.some((t) => t.includes('Hall A3'))).toBe(true);
    expect(triples.some((t) => t.includes('BERLIN'))).toBe(true);
    expect(triples.some((t) => t.includes('https://youtu.be/teched1'))).toBe(true);
  });

  it('emits an inTrack edge + a track node with its name', () => {
    const triples = buildTechEdSessionTriples({ sessions: [fresh], links: [], tracks, speakers });
    const edge = triples.find((t) => t.includes('inTrack'));
    expect(edge).toBeDefined();
    expect(edge).toContain('teched-session/te-s1');
    expect(edge).toContain('teched-track/te-track-extensions');
    // track node + label
    expect(triples.some((t) => t.includes('TechEdTrack'))).toBe(true);
    expect(triples.some((t) => t.includes('Extensions & Integration'))).toBe(true);
  });

  it('emits a presentedBy edge + speaker nodes for each speaker', () => {
    const triples = buildTechEdSessionTriples({ sessions: [fresh], links: [], tracks, speakers });
    const edges = triples.filter((t) => t.includes('presentedBy'));
    expect(edges).toHaveLength(2);
    expect(triples.some((t) => t.includes('teched-speaker/sp-ada'))).toBe(true);
    expect(triples.some((t) => t.includes('teched-speaker/sp-grace'))).toBe(true);
    expect(triples.some((t) => t.includes('TechEdSpeaker'))).toBe(true);
    expect(triples.some((t) => t.includes('Ada Lovelace'))).toBe(true);
    expect(triples.some((t) => t.includes('Grace Hopper'))).toBe(true);
  });

  it('emits the covers concept edge for a visible session', () => {
    const triples = buildTechEdSessionTriples({ sessions: [fresh], links: [link('te-s1', 'concept-1')], tracks, speakers });
    const rel = triples.find((t) => t.includes('covers'));
    expect(rel).toBeDefined();
    expect(rel).toContain('teched-session/te-s1');
    expect(rel).toContain('concept/concept-1');
  });

  it('projects an undated session (date-aware TTL degrades to always-within)', () => {
    const triples = buildTechEdSessionTriples({ sessions: [undated], links: [], tracks, speakers });
    expect(triples.some((t) => t.includes('teched-session/te-s3'))).toBe(true);
  });

  it('drops sessions past the endDate + 30-day grace window', () => {
    const triples = buildTechEdSessionTriples({ sessions: [stale], links: [link('te-s2', 'concept-1')], tracks, speakers });
    expect(triples.some((t) => t.includes('te-s2'))).toBe(false);
  });

  it('drops concept links + track/speaker nodes whose parent session was dropped', () => {
    const triples = buildTechEdSessionTriples({ sessions: [stale], links: [link('te-s2', 'concept-1')], tracks, speakers });
    expect(triples.some((t) => t.includes('covers'))).toBe(false);
    // track/speaker nodes are only emitted when referenced by a VISIBLE session
    expect(triples.some((t) => t.includes('TechEdTrack'))).toBe(false);
    expect(triples.some((t) => t.includes('TechEdSpeaker'))).toBe(false);
  });

  it('returns an empty array for empty input (additive/safe until Unit 2 populates links)', () => {
    expect(buildTechEdSessionTriples({})).toEqual([]);
    expect(buildTechEdSessionTriples({ sessions: [], links: [] })).toEqual([]);
  });

  it('does not emit a track node when no session references a track', () => {
    const noTrack = { ...fresh, track_slug: null, speakerSlugs: [] };
    const triples = buildTechEdSessionTriples({ sessions: [noTrack], links: [], tracks, speakers });
    expect(triples.some((t) => t.includes('TechEdTrack'))).toBe(false);
    expect(triples.some((t) => t.includes('inTrack'))).toBe(false);
  });
});
