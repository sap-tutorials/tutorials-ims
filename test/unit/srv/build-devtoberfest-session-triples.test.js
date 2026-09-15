// test/unit/srv/build-devtoberfest-session-triples.test.js
//
// #2311: pure-function test for buildDevtoberfestSessionTriples. Mirrors
// build-community-event-triples: TTL gate, link filtering when parent is
// dropped, N-Triples IRI/predicate shape — plus the activity→tutorial
// bridge edge that connects sessions into the tutorial subgraph.

import { describe, it, expect } from 'vitest';
import { buildDevtoberfestSessionTriples } from '../../../srv/lib/kg-projection.js';

describe('buildDevtoberfestSessionTriples', () => {
  const now = new Date();
  const day = 86400000;

  const fresh = {
    slug: 'dtf-s1', title: 'Build AI services using SAP CAP',
    url: 'https://youtu.be/abc', youtubeUrl: 'https://youtu.be/abc',
    sessionCode: 'DEV101', speakerNames: 'Ada Lovelace',
    activityTaskSlug: 'cap-genai-hub', activityTaskType: 'TUTORIAL',
    lastSeenAt: now,
  };
  // 3 years past — beyond the 730-day TTL.
  const stale = { ...fresh, slug: 'dtf-s2', lastSeenAt: new Date(now.getTime() - 1100 * day) };
  const puzzleLinked = {
    ...fresh, slug: 'dtf-s3',
    activityTaskSlug: 'some-puzzle', activityTaskType: 'PUZZLE',
  };
  const link = (slug, conceptSlug) => ({ session_slug: slug, conceptSlug, predicate: 'presents' });

  it('emits a node + slug/title/speaker/youtube literals for a fresh session', () => {
    const triples = buildDevtoberfestSessionTriples({ sessions: [fresh], links: [] });
    expect(triples.some((t) => t.includes('devtoberfest-session/dtf-s1'))).toBe(true);
    expect(triples.some((t) => t.includes('DevtoberfestSession'))).toBe(true);
    expect(triples.some((t) => t.includes('Ada Lovelace'))).toBe(true);
    expect(triples.some((t) => t.includes('https://youtu.be/abc'))).toBe(true);
  });

  it('drops sessions past the TTL', () => {
    const triples = buildDevtoberfestSessionTriples({ sessions: [stale], links: [link('dtf-s2', 'concept-1')] });
    expect(triples.some((t) => t.includes('dtf-s2'))).toBe(false);
  });

  it('emits the presents concept edge for a visible session', () => {
    const triples = buildDevtoberfestSessionTriples({ sessions: [fresh], links: [link('dtf-s1', 'concept-1')] });
    const rel = triples.find((t) => t.includes('presents'));
    expect(rel).toBeDefined();
    expect(rel).toContain('dtf-s1');
    expect(rel).toContain('concept/concept-1');
  });

  it('drops concept links whose parent session was dropped', () => {
    const triples = buildDevtoberfestSessionTriples({ sessions: [stale], links: [link('dtf-s2', 'concept-1')] });
    expect(triples.some((t) => t.includes('presents'))).toBe(false);
  });

  it('emits an aboutTutorial bridge edge for a TUTORIAL-linked session (lowercased slug)', () => {
    const triples = buildDevtoberfestSessionTriples({ sessions: [{ ...fresh, activityTaskSlug: 'CAP-GenAI-Hub' }], links: [] });
    const bridge = triples.find((t) => t.includes('aboutTutorial'));
    expect(bridge).toBeDefined();
    expect(bridge).toContain('devtoberfest-session/dtf-s1');
    expect(bridge).toContain('tutorial/cap-genai-hub');
  });

  it('does NOT emit a bridge edge for a non-tutorial (puzzle) activity', () => {
    const triples = buildDevtoberfestSessionTriples({ sessions: [puzzleLinked], links: [] });
    expect(triples.some((t) => t.includes('aboutTutorial'))).toBe(false);
  });
});
