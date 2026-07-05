import { expect, describe, it } from 'vitest';
import cds from '@sap/cds';

describe('MCP enablement (Phase 1)', () => {
  it('SearchService is annotated with @mcp', async () => {
    const csn = await cds.load('srv/search-service.cds');
    const svc = csn.definitions['SearchService'];
    expect(svc['@mcp']).toBe(true);
  });

  it('SearchService.SearchableItems has @cds.query.limit', async () => {
    const csn = await cds.load('srv/search-service.cds');
    const ent = csn.definitions['SearchService.SearchableItems'];
    expect(ent['@cds.query.limit']).toBe(200);
  });

  it('HomepageService is annotated with @mcp', async () => {
    const csn = await cds.load('srv/homepage-service.cds');
    const svc = csn.definitions['HomepageService'];
    expect(svc['@mcp']).toBe(true);
  });

  it('KnowledgeGraphService is annotated with @mcp', async () => {
    const csn = await cds.load('srv/knowledge-graph-service.cds');
    const svc = csn.definitions['KnowledgeGraphService'];
    expect(svc['@mcp']).toBe(true);
  });

  it('KnowledgeGraphService.PublishedConcepts has @cds.query.limit', async () => {
    const csn = await cds.load('srv/knowledge-graph-service.cds');
    const ent = csn.definitions['KnowledgeGraphService.PublishedConcepts'];
    expect(ent['@cds.query.limit']).toBe(200);
  });
});
