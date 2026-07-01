// test/unit/srv/kg-neighborhood-result-shape.test.js
//
// Regression guard for the Phase 4 chassis (#447) + Task 4 of #850
// (KG-widget redesign): asserts that `NeighborhoodResult.otherResources`
// and `typeConfig` are declared on the CDS type so the OData layer
// preserves the fields on the wire, and that the JS mutation step stamps
// `metaText` correctly on every row via RESOURCE_TYPE_CONFIG.renderMeta.
//
// CAP strips fields that aren't declared on the response type, so JS
// returning `otherResources: []` (in knowledge-graph-service.js) is
// necessary but not sufficient — the CDS type definition must declare it
// too.
//
// If this test fails after a CDS edit, check srv/knowledge-graph-service.cds
// `type NeighborhoodResult` and the `OtherResource` / `TypeConfigEntry`
// element types. If it fails after a JS edit, check
// srv/lib/kg-stamp-meta-text.js and the neighborhood handler in
// srv/knowledge-graph-service.js (the same helper is used there).

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  stampMetaText,
  typeConfigForWire,
} from '../../../srv/lib/kg-stamp-meta-text.js';
import { RESOURCE_TYPE_CONFIG } from '../../../srv/lib/kg-resource-type-config.js';

describe('KnowledgeGraphService.NeighborhoodResult CDS type', () => {
  it('declares otherResources on the wire shape (#447 chassis)', async () => {
    const csn = await cds.load(join(process.cwd(), 'srv/knowledge-graph-service.cds'));
    const neighborhood = csn.definitions['KnowledgeGraphService.NeighborhoodResult'];
    expect(neighborhood).toBeDefined();
    expect(neighborhood.elements).toHaveProperty('otherResources');
    // Should be an array (items typed via the OtherResource sub-type).
    const el = neighborhood.elements.otherResources;
    expect(el.items).toBeDefined();
  });

  it('OtherResource sub-type carries the columns Phase 4.2 needs', async () => {
    const csn = await cds.load(join(process.cwd(), 'srv/knowledge-graph-service.cds'));
    const otherResource = csn.definitions['KnowledgeGraphService.OtherResource'];
    expect(otherResource).toBeDefined();
    // Sub-phases 4.2-4.6 each add a `type` discriminator; ranking surfaces
    // an `overlapCount`; learning-journey rows carry level + durationHours.
    for (const field of ['type', 'slug', 'title', 'url', 'level', 'durationHours', 'overlapCount']) {
      expect(otherResource.elements).toHaveProperty(field);
    }
  });

  it('OtherResource declares `metaText` (Task 4 of #850)', async () => {
    const csn = await cds.load(join(process.cwd(), 'srv/knowledge-graph-service.cds'));
    const otherResource = csn.definitions['KnowledgeGraphService.OtherResource'];
    expect(otherResource.elements).toHaveProperty('metaText');
  });

  it('NeighborhoodResult declares `typeConfig` array (Task 4 of #850)', async () => {
    const csn = await cds.load(join(process.cwd(), 'srv/knowledge-graph-service.cds'));
    const neighborhood = csn.definitions['KnowledgeGraphService.NeighborhoodResult'];
    expect(neighborhood.elements).toHaveProperty('typeConfig');
    expect(neighborhood.elements.typeConfig.items).toBeDefined();
  });

  it('TypeConfigEntry carries the wire-side registry columns (no renderMeta)', async () => {
    const csn = await cds.load(join(process.cwd(), 'srv/knowledge-graph-service.cds'));
    const entry = csn.definitions['KnowledgeGraphService.TypeConfigEntry'];
    expect(entry).toBeDefined();
    for (const field of ['type', 'icon', 'singular', 'plural', 'priority', 'metaTemplate']) {
      expect(entry.elements).toHaveProperty(field);
    }
    // renderMeta is a JS function; MUST NOT be declared on the wire type.
    expect(entry.elements).not.toHaveProperty('renderMeta');
  });
});

describe('typeConfigForWire — Task 4 of #850', () => {
  it('returns 6 entries sorted by priority ascending', () => {
    const cfg = typeConfigForWire();
    expect(cfg).toHaveLength(6);
    const priorities = cfg.map((c) => c.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });

  it('strips renderMeta from every entry', () => {
    const cfg = typeConfigForWire();
    for (const entry of cfg) {
      expect(entry).not.toHaveProperty('renderMeta');
    }
  });

  it('preserves the six registry fields on every entry', () => {
    const cfg = typeConfigForWire();
    for (const entry of cfg) {
      for (const field of ['type', 'icon', 'singular', 'plural', 'priority', 'metaTemplate']) {
        expect(entry).toHaveProperty(field);
      }
    }
  });

  it('covers the six known types from RESOURCE_TYPE_CONFIG', () => {
    const cfg = typeConfigForWire();
    const types = cfg.map((c) => c.type).sort();
    const expected = RESOURCE_TYPE_CONFIG.map((c) => c.type).sort();
    expect(types).toEqual(expected);
  });
});

describe('stampMetaText — Task 4 of #850', () => {
  it('stamps a string metaText on every row', () => {
    const rows = [
      { type: 'learning-journey', slug: 'j1', level: 'BEGINNER', durationHours: 2 },
      { type: 'blog-post',        slug: 'bp-1', authorName: 'Alice' },
      { type: 'api-doc',          slug: 'api-1' },
    ];
    stampMetaText(rows);
    for (const row of rows) {
      expect(typeof row.metaText).toBe('string');
    }
  });

  it('renders blog-post meta as " · by Alice · Jun 3, 2026" for a populated row', () => {
    const rows = [{
      type: 'blog-post',
      slug: 'bp-1',
      authorName: 'Alice',
      postedAt: '2026-06-03T12:00:00Z',
    }];
    stampMetaText(rows);
    expect(rows[0].metaText).toBe(' · by Alice · Jun 3, 2026');
  });

  it('renders api-doc meta as unconditional " · Official reference" even without metadata', () => {
    const rows = [{ type: 'api-doc', slug: 'api-1' }];
    stampMetaText(rows);
    expect(rows[0].metaText).toBe(' · Official reference');
  });

  it('preserves other per-row fields alongside metaText (backward compat)', () => {
    const rows = [{
      type: 'learning-journey',
      slug: 'j1',
      title: 'Test',
      level: 'BEGINNER',
      durationHours: 2,
      overlapCount: 3,
    }];
    stampMetaText(rows);
    expect(rows[0]).toMatchObject({
      type: 'learning-journey',
      slug: 'j1',
      title: 'Test',
      level: 'BEGINNER',
      durationHours: 2,
      overlapCount: 3,
    });
    expect(typeof rows[0].metaText).toBe('string');
  });

  it('assigns empty string for unknown types (defensive)', () => {
    const rows = [{ type: 'unknown-type', slug: 'x' }];
    stampMetaText(rows);
    expect(rows[0].metaText).toBe('');
  });

  it('returns the same array reference', () => {
    const rows = [];
    expect(stampMetaText(rows)).toBe(rows);
  });
});

describe('neighborhood cold-start empty envelope — typeConfig regression', () => {
  // Regression guard for the "cold-start missing typeConfig" bug — when
  // GraphMetadata.graphVersion is null (fresh deploy, consolidator hasn't
  // run yet), the neighborhood + neighborhoodFull handlers return an
  // empty envelope. That envelope MUST carry typeConfig so new clients
  // don't fire the legacy-fallback warning on cold-start pages.
  //
  // The handlers are invoked with a live cds runtime; exercising them
  // in a pure unit test is heavy. This structural check reads the
  // service source and asserts both empty-envelope literals emit
  // `typeConfig: typeConfigForWire()`. Cheap, and catches the regression.
  const svcSource = readFileSync(
    join(process.cwd(), 'srv/knowledge-graph-service.js'),
    'utf8',
  );

  it('neighborhood empty envelope includes typeConfig: typeConfigForWire()', () => {
    // Find the block starting with `if (!graphVersion)` in the neighborhood
    // handler; assert typeConfigForWire() is present before the closing brace.
    const idx = svcSource.indexOf(
      "kg-service: neighborhood(${slug}) — no graphVersion yet",
    );
    expect(idx, 'cold-start log line not found in neighborhood handler').toBeGreaterThan(-1);
    // Look ~600 chars ahead for the typeConfig field.
    const window = svcSource.slice(idx, idx + 800);
    expect(window).toMatch(/typeConfig:\s*typeConfigForWire\(\)/);
  });

  it('neighborhoodFull empty envelope helper includes typeConfig: typeConfigForWire()', () => {
    // neighborhoodFull uses an emptyEnvelope helper. Grep for its literal.
    const idx = svcSource.indexOf('const emptyEnvelope = (tutorialInfo, gv)');
    expect(idx, 'emptyEnvelope helper not found in neighborhoodFull').toBeGreaterThan(-1);
    const window = svcSource.slice(idx, idx + 500);
    expect(window).toMatch(/typeConfig:\s*typeConfigForWire\(\)/);
  });

  it('typeConfigForWire() returns a non-empty array so cold-start clients get a real registry', () => {
    const cfg = typeConfigForWire();
    expect(Array.isArray(cfg)).toBe(true);
    expect(cfg.length).toBeGreaterThan(0);
  });
});
