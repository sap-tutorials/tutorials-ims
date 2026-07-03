// test/unit/srv/build-community-event-triples.test.js
//
// Phase 4.8 (#765): pure-function test for buildCommunityEventTriples.
// Mirrors the shape of build-help-doc-triples tests: TTL gate, link
// filtering when parent is dropped, N-Triples IRI/predicate shape.

import { describe, it, expect } from 'vitest';
import { buildCommunityEventTriples } from '../../../srv/lib/kg-projection.js';

describe('buildCommunityEventTriples', () => {
  const now = new Date();
  const day = 86400000;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);

  const fresh = {
    slug: 'ce-c1', title: 'Fresh', url: 'https://x', eventType: 'codejam',
    source: 'khoros', location: 'Berlin', scope: 'local',
    virtualOrInPerson: 'in-person',
    startDate: iso(now.getTime() + 30 * day),
    endDate:   iso(now.getTime() + 30 * day),
    lastSeenAt: now,
  };
  const past = {
    ...fresh, slug: 'ce-c2',
    endDate: iso(now.getTime() - 45 * day),
    startDate: iso(now.getTime() - 45 * day),
  };
  const nullEnd = {
    ...fresh, slug: 'ce-c3',
    endDate: null,
    startDate: iso(now.getTime() - 45 * day),
  };
  const link = (slug, conceptSlug) => ({ event_slug: slug, conceptSlug, predicate: 'covers' });

  it('emits triples for events whose endDate is still within TTL', () => {
    const triples = buildCommunityEventTriples({ events: [fresh], links: [link('ce-c1', 'concept-1')] });
    expect(triples.some(t => t.includes('ce-c1'))).toBe(true);
  });

  it('drops events whose endDate is past the 30-day grace window', () => {
    const triples = buildCommunityEventTriples({ events: [past], links: [link('ce-c2', 'concept-1')] });
    expect(triples.some(t => t.includes('ce-c2'))).toBe(false);
  });

  it('when endDate is null, falls back to startDate for TTL', () => {
    const triples = buildCommunityEventTriples({ events: [nullEnd], links: [link('ce-c3', 'concept-1')] });
    // startDate is 45 days past — beyond 30-day grace -> dropped
    expect(triples.some(t => t.includes('ce-c3'))).toBe(false);
  });

  it('emits <community-event/ce-...> covers <concept/...> triple with the predicate literal', () => {
    const triples = buildCommunityEventTriples({ events: [fresh], links: [link('ce-c1', 'concept-1')] });
    const rel = triples.find(t => t.includes('covers'));
    expect(rel).toBeDefined();
    expect(rel).toContain('ce-c1');
  });
});
