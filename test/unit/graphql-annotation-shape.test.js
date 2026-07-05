import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('graphql annotation shape', () => {
  let csn;
  let kg;
  beforeAll(async () => {
    csn = await cds.load(['srv/search-service.cds']);
    kg = await cds.load(['srv/knowledge-graph-service.cds']);
  });

  it('SearchService carries @graphql', () => {
    const svc = csn.definitions['SearchService'];
    expect(svc?.['@graphql']).toBe(true);
  });

  it('KnowledgeGraphService public entities carry @protocol: graphql', async () => {
    for (const name of ['Concepts', 'ConceptEdges', 'TutorialConceptLinks', 'PublishedConcepts']) {
      const ent = kg.definitions[`KnowledgeGraphService.${name}`];
      const proto = ent?.['@protocol'];
      const asArr = Array.isArray(proto) ? proto : [proto];
      expect(asArr).toContain('graphql');
    }
  });

  it('KnowledgeGraphService as a whole is NOT @graphql (mixed surface)', async () => {
    const svc = kg.definitions['KnowledgeGraphService'];
    expect(svc?.['@graphql']).toBeFalsy();
  });
});
