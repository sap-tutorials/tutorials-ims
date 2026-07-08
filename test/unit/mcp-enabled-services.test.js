import { expect, describe, it } from 'vitest';
import cds from '@sap/cds';

// Each MCP-enabled service must declare its protocol list explicitly. The
// single-protocol shortcut (`@mcp` on its own) REPLACES the OData mount — same
// trap as `@graphql`. See memory-fact cap-graphql-shortcut-replaces-odata and
// cap-mcp-adapter-separate-package.
//
// SearchService + KnowledgeGraphService: ['odata', 'graphql', 'mcp'] (they
// have GraphQL enabled). HomepageService: ['odata', 'mcp'] (no GraphQL).
const REQUIRED_PROTOCOLS_SEARCH_KG = ['odata', 'graphql', 'mcp'];

function hasMcpProtocol(svcDef) {
  const p = svcDef?.['@protocol'];
  if (!Array.isArray(p)) return false;
  return p.includes('mcp');
}

describe('MCP enablement (Phase 1)', () => {
  it('SearchService includes mcp in its @protocol list', async () => {
    const csn = await cds.load('srv/search-service.cds');
    const svc = csn.definitions['SearchService'];
    expect(hasMcpProtocol(svc), `@protocol was ${JSON.stringify(svc['@protocol'])}`).toBe(true);
    // Also verify OData + GraphQL stay in the list — single-protocol shortcut regression guard.
    for (const p of REQUIRED_PROTOCOLS_SEARCH_KG) {
      expect(svc['@protocol']).toContain(p);
    }
  });

  it('SearchService.SearchableItems has @cds.query.limit', async () => {
    const csn = await cds.load('srv/search-service.cds');
    const ent = csn.definitions['SearchService.SearchableItems'];
    expect(ent['@cds.query.limit']).toBe(200);
  });

  it('HomepageService includes mcp in its @protocol list', async () => {
    const csn = await cds.load('srv/homepage-service.cds');
    const svc = csn.definitions['HomepageService'];
    expect(hasMcpProtocol(svc), `@protocol was ${JSON.stringify(svc['@protocol'])}`).toBe(true);
    // Homepage does NOT adopt GraphQL — only assert odata + mcp.
    expect(svc['@protocol']).toContain('odata');
    expect(svc['@protocol']).toContain('mcp');
  });

  it('KnowledgeGraphService includes mcp in its @protocol list', async () => {
    const csn = await cds.load('srv/knowledge-graph-service.cds');
    const svc = csn.definitions['KnowledgeGraphService'];
    expect(hasMcpProtocol(svc), `@protocol was ${JSON.stringify(svc['@protocol'])}`).toBe(true);
    for (const p of REQUIRED_PROTOCOLS_SEARCH_KG) {
      expect(svc['@protocol']).toContain(p);
    }
  });

  it('KnowledgeGraphService.PublishedConcepts has @cds.query.limit', async () => {
    const csn = await cds.load('srv/knowledge-graph-service.cds');
    const ent = csn.definitions['KnowledgeGraphService.PublishedConcepts'];
    expect(ent['@cds.query.limit']).toBe(200);
  });
});
