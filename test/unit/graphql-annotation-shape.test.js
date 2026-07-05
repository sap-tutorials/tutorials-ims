import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('graphql annotation shape', () => {
  let csn;
  let kg;
  let dev;
  beforeAll(async () => {
    csn = await cds.load(['srv/search-service.cds']);
    kg = await cds.load(['srv/knowledge-graph-service.cds']);
    dev = await cds.load(['srv/developer-service.cds']);
  });

  it('SearchService carries @graphql', () => {
    const svc = csn.definitions['SearchService'];
    expect(svc?.['@graphql']).toBe(true);
  });

  it('KnowledgeGraphService carries @graphql at the service level', async () => {
    const kg = await cds.load('srv/knowledge-graph-service.cds');
    const svc = kg.definitions['KnowledgeGraphService'];
    expect(svc?.['@graphql']).toBe(true);
  });

  it('DeveloperService is @graphql', async () => {
    const svc = dev.definitions['DeveloperService'];
    expect(svc?.['@graphql']).toBe(true);
  });

  it('DeveloperService.Tutorials requires Tutorial.API', async () => {
    const ent = dev.definitions['DeveloperService.Tutorials'];
    const restrict = ent['@restrict'];
    expect(restrict).toBeTruthy();
    const scopes = restrict.flatMap(r => Array.isArray(r.to) ? r.to : [r.to]);
    expect(scopes).toContain('Tutorial.API');
  });

  it('DeveloperService.ChatConfig stays anonymous-readable (@requires: any)', async () => {
    const ent = dev.definitions['DeveloperService.ChatConfig'];
    const req = ent['@requires'];
    const asArr = Array.isArray(req) ? req : [req];
    expect(asArr).toContain('any');
  });
});
