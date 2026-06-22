// test/unit/kg-enrich-live-tutorials.test.js
// Tests for the title-enrichment + dead-reference filter in
// srv/knowledge-graph-service.js. PR #558 — Tom hit a KG sidebar link
// pointing at slug `devtoberfest-2025-create-business-configuration-
// maintenance-object` which had zero rows in Tutorials (was DELETED or
// renamed). The original enrichment fell through to slug-as-title
// silently; now we filter such dead refs out so the UI never surfaces
// them.

import { describe, it, expect } from 'vitest';
import { buildLiveTitleMap, enrichLiveTutorials } from '../../srv/knowledge-graph-service.js';

describe('buildLiveTitleMap', () => {
  it('includes rows with status=ACTIVE', () => {
    const map = buildLiveTitleMap([
      { slug: 'a', title: 'Tutorial A', status: 'ACTIVE' },
      { slug: 'b', title: 'Tutorial B', status: 'ACTIVE' },
    ]);
    expect(map.size).toBe(2);
    expect(map.get('a')).toBe('Tutorial A');
    expect(map.get('b')).toBe('Tutorial B');
  });

  it('includes rows with NULL/missing status (defaults to ACTIVE)', () => {
    const map = buildLiveTitleMap([
      { slug: 'a', title: 'Tutorial A', status: null },
      { slug: 'b', title: 'Tutorial B' },  // status undefined
    ]);
    expect(map.size).toBe(2);
    expect(map.get('a')).toBe('Tutorial A');
    expect(map.get('b')).toBe('Tutorial B');
  });

  it('EXCLUDES rows with status=DELETED', () => {
    const map = buildLiveTitleMap([
      { slug: 'alive', title: 'Live', status: 'ACTIVE' },
      { slug: 'dead',  title: 'Dead', status: 'DELETED' },
    ]);
    expect(map.size).toBe(1);
    expect(map.has('alive')).toBe(true);
    expect(map.has('dead')).toBe(false);
  });

  it('EXCLUDES rows with status=INACTIVE', () => {
    const map = buildLiveTitleMap([
      { slug: 'alive',    title: 'Live',    status: 'ACTIVE' },
      { slug: 'inactive', title: 'Old',     status: 'INACTIVE' },
    ]);
    expect(map.size).toBe(1);
    expect(map.has('inactive')).toBe(false);
  });

  it('falls back to slug-as-title when title is null', () => {
    const map = buildLiveTitleMap([
      { slug: 'no-title', title: null, status: 'ACTIVE' },
    ]);
    expect(map.get('no-title')).toBe('no-title');
  });

  it('returns an empty map for no input', () => {
    expect(buildLiveTitleMap([])).toEqual(new Map());
  });
});

describe('enrichLiveTutorials', () => {
  const titles = new Map([
    ['a', 'Tutorial A'],
    ['b', 'Tutorial B'],
  ]);

  it('attaches title from the map', () => {
    const out = enrichLiveTutorials(
      [{ slug: 'a', weight: 0.9, reason: 'shares concepts with this tutorial' }],
      titles
    );
    expect(out).toEqual([
      { slug: 'a', title: 'Tutorial A', weight: 0.9, reason: 'shares concepts with this tutorial' },
    ]);
  });

  it('filters out items whose slug is missing from the title map (dead refs)', () => {
    const out = enrichLiveTutorials(
      [
        { slug: 'a',    weight: 0.9, reason: 'shares concepts with this tutorial' },
        { slug: 'gone', weight: 0.8, reason: 'shares concepts with this tutorial' },  // dead ref
        { slug: 'b',    weight: 0.7, reason: 'shares concepts with this tutorial' },
      ],
      titles
    );
    expect(out.map((i) => i.slug)).toEqual(['a', 'b']);
  });

  it('returns an empty array when ALL items are dead refs', () => {
    const out = enrichLiveTutorials(
      [
        { slug: 'gone1', weight: 0.9, reason: 'next step — builds on what this tutorial teaches' },
        { slug: 'gone2', weight: 0.8, reason: 'next step — builds on what this tutorial teaches' },
      ],
      titles
    );
    expect(out).toEqual([]);
  });

  it('preserves item shape (weight, reason, type) when enriching', () => {
    const out = enrichLiveTutorials(
      [{ slug: 'a', weight: 0.9, reason: 'teaches a prerequisite concept', type: 'prerequisitesOf' }],
      titles
    );
    expect(out[0]).toMatchObject({
      slug: 'a',
      title: 'Tutorial A',
      weight: 0.9,
      reason: 'teaches a prerequisite concept',
      type: 'prerequisitesOf',
    });
  });

  // The KG ranker returns items with .slug + .weight + .reason. The
  // 2026-06-22 production case was: handler enrichment dropped 'title'
  // entirely when no row matched, so the UI rendered the slug as the
  // link text. This test pins that behavior to the new filter.
  it('regression — drops the 2026-06-22 stale-KG case', () => {
    const ghost = { slug: 'devtoberfest-2025-create-business-configuration-maintenance-object', weight: 0.7, reason: 'shares concepts with this tutorial' };
    const real  = { slug: 'a', weight: 0.9, reason: 'shares concepts with this tutorial' };
    const out = enrichLiveTutorials([ghost, real], titles);
    expect(out).toEqual([{ ...real, title: 'Tutorial A' }]);
  });
});
