// test/unit/srv/kg-projection-learning-journey.test.js
//
// Phase 4.1 (#447) — unit tests for buildLearningJourneyTriples in
// srv/lib/kg-projection.js. Pulled out as a separate test file from the
// existing kg-projection suites so the per-type TTL gate and the
// FK-resolution drop rules are covered in isolation.
//
// Three rules under test (spec §2.4):
//   1. TTL-stale journey (lastSeenAt older than 365-day TTL) emits no triples.
//   2. Covers link whose journeySlug doesn't resolve to a visible journey
//      is dropped (defends against orphaned link rows after a journey gets
//      TTL-filtered).
//   3. journeyPrerequisite triple is dropped when EITHER side of the bridge
//      (source or prereq journey) is TTL-stale.
//
// Test fixtures are synthetic in-memory rows. `Date.now()` is stubbed via
// vi.useFakeTimers() so the TTL math is deterministic and doesn't drift
// with the wall clock.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildLearningJourneyTriples } from '../../../srv/lib/kg-projection.js';

describe('buildLearningJourneyTriples', () => {
  // Fixed "now" so TTL math is deterministic. learning-journey TTL is 365d.
  const NOW = new Date('2026-06-28T00:00:00Z');
  const IN_WINDOW = new Date('2026-06-01T00:00:00Z').toISOString();      // ~27 days ago — within 365d
  const OUT_OF_WINDOW = new Date('2024-01-01T00:00:00Z').toISOString();   // ~2.5y ago — past 365d

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits no triples for a TTL-stale journey', () => {
    const triples = buildLearningJourneyTriples({
      journeys: [
        { slug: 'stale-journey', title: 'Stale', lastSeenAt: OUT_OF_WINDOW },
      ],
      links: [],
      prereqs: [],
    });
    // Stale journey contributes zero subject triples (type/label/slug).
    expect(triples).toHaveLength(0);
  });

  it('drops covers links whose journeySlug is not in the TTL-visible set', () => {
    const triples = buildLearningJourneyTriples({
      journeys: [
        // Only this in-window journey is visible. The link below points at
        // a different (unknown / TTL-stale) journey and must be dropped.
        { slug: 'visible', title: 'Visible', lastSeenAt: IN_WINDOW },
      ],
      links: [
        { journeySlug: 'ghost-journey', conceptSlug: 'cap-handlers' },
      ],
      prereqs: [],
    });
    // The visible journey emits its 3 baseline triples (type, label, slug).
    // The dropped link must not appear in the output.
    const coversLines = triples.filter((t) => t.includes('/covers>'));
    expect(coversLines).toHaveLength(0);
    expect(triples.some((t) => t.includes('/concept/cap-handlers'))).toBe(false);
  });

  it('drops journeyPrerequisite when the prereq-side journey is TTL-stale', () => {
    const triples = buildLearningJourneyTriples({
      journeys: [
        // Source side is visible (in window). Prereq side is stale, so it
        // never enters visibleJourneySlugs, so the bridge triple drops.
        { slug: 'main',  title: 'Main',  lastSeenAt: IN_WINDOW },
        { slug: 'older', title: 'Older', lastSeenAt: OUT_OF_WINDOW },
      ],
      links: [],
      prereqs: [
        { journeySlug: 'main', prereqSlug: 'older' },
      ],
    });
    const prereqLines = triples.filter((t) => t.includes('/journeyPrerequisite>'));
    expect(prereqLines).toHaveLength(0);
    // Confirm only the visible-side journey contributed baseline triples,
    // and the stale-side one did not.
    expect(triples.some((t) => t.includes('/learning-journey/main>'))).toBe(true);
    expect(triples.some((t) => t.includes('/learning-journey/older>'))).toBe(false);
  });

  // #725 — iriLearningJourney was the only Phase 4 IRI helper that didn't
  // apply iriEscapeSegment to the slug. Latent today (learning-journey
  // slugs are lowercase-only by @assert.unique constraint), but defense-
  // in-depth matches the other 8 helpers and protects against a future
  // bulk feed-pivot landing slugs with reserved IRI characters.
  it('escapes reserved IRI characters in a learning-journey slug (#725)', () => {
    const triples = buildLearningJourneyTriples({
      journeys: [
        // Synthetic slug with `>` (reserved IRI char). Without the escape
        // fix, the emitted IRI would close at `>` and produce broken SPARQL.
        { slug: 'topic>foo', title: 'Topic Foo', lastSeenAt: IN_WINDOW },
      ],
      links: [],
      prereqs: [],
    });
    // Subject IRI is escaped; the slug literal preserves the raw value.
    expect(triples).toContain(
      '<https://developers.sap.com/kg/learning-journey/topic%3Efoo> ' +
      '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ' +
      '<https://developers.sap.com/kg/LearningJourney> .'
    );
    // Defensive: the unescaped form must NOT appear anywhere.
    expect(triples.every((t) => !t.includes('learning-journey/topic>'))).toBe(true);
  });
});
