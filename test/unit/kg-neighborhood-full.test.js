// test/unit/kg-neighborhood-full.test.js
//
// Task 5 of #850 (KG-widget redesign): unit tests for the new
// /graph/neighborhoodFull surface that powers the ExpandedPanel dialog.
//
// Scope: the pure helper (`buildOtherResourcesByType`) that composes the
// per-type buckets from a loader's byType Map, plus CDS-type shape guards,
// plus cache-bucket assertions. The full handler is exercised at the
// hybrid layer (deferred to Task 16 e2e verification).

import { describe, it, expect, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { join } from 'node:path';
import {
  buildOtherResourcesByType,
  KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT_DEFAULT,
} from '../../srv/lib/kg-neighborhood-full-helpers.js';
import { RESOURCE_TYPE_CONFIG } from '../../srv/lib/kg-resource-type-config.js';
import {
  getCachedNeighborhood,
  setCachedNeighborhood,
  bustNeighborhoodCache,
  _makeKey,
} from '../../srv/lib/kg-neighborhood-cache.js';

// Build a byType Map matching the loader's return shape. Each corpus has
// small rows shaped like the actual OtherResource wire shape.
function makeByType({
  learningJourney = 0,
  blogPost = 0,
  discoveryMission = 0,
  video = 0,
  apiDoc = 0,
  sample = 0,
  helpDoc = 0,
} = {}) {
  const m = new Map();
  m.set(
    'learning-journey',
    Array.from({ length: learningJourney }, (_, i) => ({
      type: 'learning-journey',
      slug: `j${i}`,
      title: `Journey ${i}`,
      url: `https://example.com/j${i}`,
      level: 'BEGINNER',
      durationHours: 2,
      overlapCount: learningJourney - i,
    })),
  );
  m.set(
    'blog-post',
    Array.from({ length: blogPost }, (_, i) => ({
      type: 'blog-post',
      slug: `bp-${i}`,
      title: `Blog ${i}`,
      url: `https://example.com/bp-${i}`,
      authorName: 'Alice',
      postedAt: '2026-06-03T12:00:00Z',
      overlapCount: blogPost - i,
    })),
  );
  m.set(
    'discovery-mission',
    Array.from({ length: discoveryMission }, (_, i) => ({
      type: 'discovery-mission',
      slug: `dm-${i}`,
      title: `Mission ${i}`,
      url: `https://example.com/dm-${i}`,
      effortLevel: 3,
      categoryLabel: 'Integration',
      overlapCount: discoveryMission - i,
    })),
  );
  m.set(
    'video',
    Array.from({ length: video }, (_, i) => ({
      type: 'video',
      slug: `v-${i}`,
      title: `Video ${i}`,
      url: `https://example.com/v-${i}`,
      channelTitle: 'SAP Developers',
      publishedAt: '2026-05-01T00:00:00Z',
      thumbnailUrl: 'https://img.example.com/t.jpg',
      overlapCount: video - i,
    })),
  );
  m.set(
    'api-doc',
    Array.from({ length: apiDoc }, (_, i) => ({
      type: 'api-doc',
      slug: `api-${i}`,
      title: `API ${i}`,
      url: `https://example.com/api-${i}`,
      category: 'Business',
      apiType: 'ODATA',
      overlapCount: apiDoc - i,
    })),
  );
  m.set(
    'sample',
    Array.from({ length: sample }, (_, i) => ({
      type: 'sample',
      slug: `s-${i}`,
      title: `Sample ${i}`,
      url: `https://example.com/s-${i}`,
      language: 'JavaScript',
      stars: 42,
      lastCommitAt: '2026-06-01T00:00:00Z',
      overlapCount: sample - i,
    })),
  );
  m.set(
    'help-doc',
    Array.from({ length: helpDoc }, (_, i) => ({
      type: 'help-doc',
      slug: `hd-${i}`,
      title: `HelpDoc ${i}`,
      url: `https://example.com/hd-${i}`,
      source: 'cap-cloud-sap',
      sourceLabel: 'CAP',
      anchor: null,
      anchorLabel: null,
      product: 'cap',
      overlapCount: helpDoc - i,
    })),
  );
  return m;
}

describe('buildOtherResourcesByType — Task 5 of #850', () => {
  it('returns 7 entries when all corpora have rows, ordered by priority ascending', () => {
    const byType = makeByType({
      learningJourney: 2,
      blogPost: 2,
      discoveryMission: 2,
      video: 2,
      apiDoc: 2,
      sample: 2,
      helpDoc: 2,
    });
    const result = buildOtherResourcesByType(byType, 15);
    // Fixture seeds 7 of the 8 corpora (community-event omitted), so 7 is
    // the fixture count — NOT derivable from RESOURCE_TYPE_CONFIG.length.
    // Priorities [10..70] pin the render-order contract for the 7 seeded
    // corpora. #1089 audit reclassified this as FIXTURE, not vocab-derived.
    expect(result).toHaveLength(7);
    const priorities = result.map((e) => e.config.priority);
    expect(priorities).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it('each entry has shape { type, config, items }; config lacks renderMeta', () => {
    const byType = makeByType({ learningJourney: 1 });
    const result = buildOtherResourcesByType(byType, 15);
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry).toHaveProperty('type', 'learning-journey');
    expect(entry).toHaveProperty('config');
    expect(entry).toHaveProperty('items');
    expect(Array.isArray(entry.items)).toBe(true);
    for (const field of ['type', 'icon', 'singular', 'plural', 'priority', 'metaTemplate']) {
      expect(entry.config).toHaveProperty(field);
    }
    expect(entry.config).not.toHaveProperty('renderMeta');
  });

  it('caps each entry.items at KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT (default 15)', () => {
    const byType = makeByType({ learningJourney: 25 });
    const result = buildOtherResourcesByType(byType, 15);
    expect(result).toHaveLength(1);
    expect(result[0].items).toHaveLength(15);
  });

  it('honours a custom per-type limit', () => {
    const byType = makeByType({ learningJourney: 10 });
    const result = buildOtherResourcesByType(byType, 3);
    expect(result[0].items).toHaveLength(3);
  });

  it('omits empty corpora from the array (no entry with items: [])', () => {
    const byType = makeByType({
      learningJourney: 2,
      blogPost: 0,
      discoveryMission: 2,
      video: 0,
      apiDoc: 2,
      sample: 0,
    });
    const result = buildOtherResourcesByType(byType, 15);
    expect(result).toHaveLength(3);
    const types = result.map((e) => e.type);
    expect(types).toEqual(['learning-journey', 'discovery-mission', 'api-doc']);
    for (const entry of result) {
      expect(entry.items.length).toBeGreaterThan(0);
    }
  });

  it('stamps a string metaText on every row', () => {
    const byType = makeByType({ learningJourney: 2, blogPost: 2, apiDoc: 1 });
    const result = buildOtherResourcesByType(byType, 15);
    for (const entry of result) {
      for (const row of entry.items) {
        expect(typeof row.metaText).toBe('string');
      }
    }
  });

  it('metaText follows RESOURCE_TYPE_CONFIG.renderMeta for known types', () => {
    const byType = new Map();
    // Ensure the map contains all six keys — buildOtherResourcesByType
    // iterates RESOURCE_TYPE_CONFIG so the caller doesn't need to pre-seed
    // empties, but explicit empties keep the test intent obvious.
    for (const cfg of RESOURCE_TYPE_CONFIG) byType.set(cfg.type, []);
    byType.set('api-doc', [{ type: 'api-doc', slug: 'api-1' }]);
    const result = buildOtherResourcesByType(byType, 15);
    expect(result).toHaveLength(1);
    // api-doc metaText is unconditional per RESOURCE_TYPE_CONFIG.
    expect(result[0].items[0].metaText).toBe(' · Official reference');
  });

  it('empty byType map yields an empty array', () => {
    const result = buildOtherResourcesByType(new Map(), 15);
    expect(result).toEqual([]);
  });

  it('handles a byType map missing some keys (no crash; treated as empty)', () => {
    const byType = new Map();
    byType.set('learning-journey', [{ type: 'learning-journey', slug: 'j0' }]);
    const result = buildOtherResourcesByType(byType, 15);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('learning-journey');
  });

  it('exports a documented default limit constant', () => {
    expect(KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT_DEFAULT).toBe(15);
  });
});

describe('KnowledgeGraphService.NeighborhoodFullResult CDS type — Task 5 of #850', () => {
  let csn;
  it('loads the CDS model', async () => {
    csn = await cds.load(join(process.cwd(), 'srv/knowledge-graph-service.cds'));
    expect(csn.definitions['KnowledgeGraphService.NeighborhoodFullResult']).toBeDefined();
  });

  it('declares neighborhoodFull as a function returning NeighborhoodFullResult', async () => {
    const model = csn || (await cds.load(join(process.cwd(), 'srv/knowledge-graph-service.cds')));
    const fn = model.definitions['KnowledgeGraphService.neighborhoodFull'];
    expect(fn).toBeDefined();
    expect(fn.kind).toBe('function');
  });

  it('has tutorial, graphVersion, prerequisitesOf, sharedConcepts, whatToLearnNext, otherResourcesByType, typeConfig — but NO teaches', async () => {
    const model = csn || (await cds.load(join(process.cwd(), 'srv/knowledge-graph-service.cds')));
    const t = model.definitions['KnowledgeGraphService.NeighborhoodFullResult'];
    expect(t).toBeDefined();
    for (const field of [
      'tutorial',
      'graphVersion',
      'prerequisitesOf',
      'sharedConcepts',
      'whatToLearnNext',
      'otherResourcesByType',
      'typeConfig',
    ]) {
      expect(t.elements, field).toHaveProperty(field);
    }
    // Spec explicitly removes teaches from the expanded panel.
    expect(t.elements).not.toHaveProperty('teaches');
  });

  it('OtherResourcesByTypeEntry sub-type carries type + config + items', async () => {
    const model = csn || (await cds.load(join(process.cwd(), 'srv/knowledge-graph-service.cds')));
    const t = model.definitions['KnowledgeGraphService.OtherResourcesByTypeEntry'];
    expect(t).toBeDefined();
    for (const field of ['type', 'config', 'items']) {
      expect(t.elements).toHaveProperty(field);
    }
    // items must be an array (of OtherResource).
    expect(t.elements.items.items).toBeDefined();
  });

  it('neighborhoodFull carries no @requires (anonymous-allowed reader)', async () => {
    const model = csn || (await cds.load(join(process.cwd(), 'srv/knowledge-graph-service.cds')));
    const fn = model.definitions['KnowledgeGraphService.neighborhoodFull'];
    expect(fn['@requires']).toBeUndefined();
  });
});

describe('kg-neighborhood-cache — full bucket isolation for Task 5', () => {
  beforeEach(() => bustNeighborhoodCache());

  it('the `full` bucket is isolated from `default` for the same (slug, graphVersion)', () => {
    const sidebar = { flavour: 'sidebar' };
    const expanded = { flavour: 'expanded' };
    setCachedNeighborhood('a', 'v1', sidebar, 'default');
    setCachedNeighborhood('a', 'v1', expanded, 'full');
    expect(getCachedNeighborhood('a', 'v1', 'default')).toBe(sidebar);
    expect(getCachedNeighborhood('a', 'v1', 'full')).toBe(expanded);
  });

  it('_makeKey includes the bucket prefix so `full` cannot collide with `default`', () => {
    const kFull = _makeKey('a', 'v1', 'full');
    const kDefault = _makeKey('a', 'v1', 'default');
    expect(kFull).not.toBe(kDefault);
    expect(kFull.startsWith('full')).toBe(true);
    expect(kDefault.startsWith('default')).toBe(true);
  });
});
