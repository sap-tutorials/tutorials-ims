// test/unit/srv/kg-neighborhood-result-shape.test.js
//
// Regression guard for the Phase 4 chassis (#447): asserts that
// `NeighborhoodResult.otherResources` is declared on the CDS type so the
// OData layer preserves the field on the wire. CAP strips fields that
// aren't declared on the response type, so JS returning `otherResources: []`
// (in knowledge-graph-service.js) is necessary but not sufficient — the CDS
// type definition must declare it too.
//
// If this test fails after a CDS edit, check srv/knowledge-graph-service.cds
// `type NeighborhoodResult` and the `OtherResource` element type.

import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { join } from 'node:path';

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
});
