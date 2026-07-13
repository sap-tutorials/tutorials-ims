import { expect, describe, it } from 'vitest';
import cds from '@sap/cds';

// Each MCP-enabled service must declare its protocol list explicitly. The
// single-protocol shortcut (`@mcp` on its own) REPLACES the OData mount — same
// trap as `@graphql`. See memory-fact cap-graphql-shortcut-replaces-odata and
// cap-mcp-adapter-separate-package.
//
// #1105: the list uses the OBJECT form for OData — `{ kind: 'odata', path: '/x' }`
// — so ONLY OData inherits the legacy service path and mcp/graphql get their own
// prefix mounts (`/mcp/<svc>`, `/graphql`). A flat `@path` + string-array
// `@protocol` collapsed all adapters onto one path and shadowed MCP (see
// cap-mcp-shadowed-by-odata-shared-path). Entries may therefore be strings OR
// `{kind}` objects — normalize before asserting.
//
// SearchService + KnowledgeGraphService: odata + graphql + mcp (GraphQL enabled).
// HomepageService: odata + graphql + mcp.
const REQUIRED_PROTOCOLS_SEARCH_KG = ['odata', 'graphql', 'mcp'];

// Normalize a @protocol entry (string like 'mcp' or object like
// { kind: 'odata', path: '/search' }) to its protocol kind.
function protocolKinds(svcDef) {
  const p = svcDef?.['@protocol'];
  if (!Array.isArray(p)) return [];
  return p.map((e) => (typeof e === 'string' ? e : e?.kind)).filter(Boolean);
}

function hasMcpProtocol(svcDef) {
  return protocolKinds(svcDef).includes('mcp');
}

describe('MCP enablement (Phase 1)', () => {
  it('SearchService includes mcp in its @protocol list', async () => {
    const csn = await cds.load('srv/search-service.cds');
    const svc = csn.definitions['SearchService'];
    expect(hasMcpProtocol(svc), `@protocol was ${JSON.stringify(svc['@protocol'])}`).toBe(true);
    // Also verify OData + GraphQL stay in the list — single-protocol shortcut regression guard.
    for (const p of REQUIRED_PROTOCOLS_SEARCH_KG) {
      expect(protocolKinds(svc)).toContain(p);
    }
    // #1105 guard: OData must carry an explicit path (object form) so mcp/graphql
    // are NOT collapsed onto it. A bare string 'odata' here would re-introduce the
    // shadowing bug.
    expect(svc['@protocol']).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'odata', path: '/search' })])
    );
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
    expect(protocolKinds(svc)).toContain('odata');
    expect(protocolKinds(svc)).toContain('mcp');
    expect(svc['@protocol']).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'odata', path: '/homepage' })])
    );
  });

  it('KnowledgeGraphService includes mcp in its @protocol list', async () => {
    const csn = await cds.load('srv/knowledge-graph-service.cds');
    const svc = csn.definitions['KnowledgeGraphService'];
    expect(hasMcpProtocol(svc), `@protocol was ${JSON.stringify(svc['@protocol'])}`).toBe(true);
    for (const p of REQUIRED_PROTOCOLS_SEARCH_KG) {
      expect(protocolKinds(svc)).toContain(p);
    }
    expect(svc['@protocol']).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'odata', path: '/graph' })])
    );
  });

  it('KnowledgeGraphService.PublishedConcepts has @cds.query.limit', async () => {
    const csn = await cds.load('srv/knowledge-graph-service.cds');
    const ent = csn.definitions['KnowledgeGraphService.PublishedConcepts'];
    expect(ent['@cds.query.limit']).toBe(200);
  });
});
