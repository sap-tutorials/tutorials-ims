import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Regression guard: the three GraphQL services MUST be exposed via
// `@protocol: ['odata', 'graphql']` (dual mount), NOT the `@graphql` shortcut.
// The shortcut is a single-protocol replacement — it removes the OData mount
// and 404's every OData-shaped request (218 unit tests on 2026-07-05, initially
// misdiagnosed as an HCQL regression and reverted in #1004).
//
// We assert via cds.compile.to.serviceinfo(...).endpoints, the same signal the
// @cap-js/graphql plugin's served hook uses to discover graphql services.
// Register the graphql protocol first so serviceinfo recognises it.
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
_require('@cap-js/graphql/cds-plugin.js');

function endpointKindsFor(model, serviceName) {
  const si = cds.compile.to.serviceinfo(model).find(s => s.name === serviceName);
  return (si?.endpoints ?? []).map(e => e.kind);
}

describe('graphql annotation shape', () => {
  let searchCsn;
  let kgCsn;
  let devCsn;
  beforeAll(async () => {
    searchCsn = await cds.load(['srv/search-service.cds']);
    kgCsn = await cds.load(['srv/knowledge-graph-service.cds']);
    devCsn = await cds.load(['srv/developer-service.cds']);
  });

  it('SearchService serves odata AND graphql', () => {
    const kinds = endpointKindsFor(searchCsn, 'SearchService');
    expect(kinds).toContain('odata');
    expect(kinds).toContain('graphql');
  });

  it('KnowledgeGraphService serves odata AND graphql', () => {
    const kinds = endpointKindsFor(kgCsn, 'KnowledgeGraphService');
    expect(kinds).toContain('odata');
    expect(kinds).toContain('graphql');
  });

  it('DeveloperService serves odata AND graphql', () => {
    const kinds = endpointKindsFor(devCsn, 'DeveloperService');
    expect(kinds).toContain('odata');
    expect(kinds).toContain('graphql');
  });

  it('DeveloperService.Tutorials requires Tutorial.API', () => {
    const ent = devCsn.definitions['DeveloperService.Tutorials'];
    const restrict = ent['@restrict'];
    expect(restrict).toBeTruthy();
    const scopes = restrict.flatMap(r => Array.isArray(r.to) ? r.to : [r.to]);
    expect(scopes).toContain('Tutorial.API');
  });

  it('DeveloperService.ChatConfig stays anonymous-readable (@requires: any)', () => {
    const ent = devCsn.definitions['DeveloperService.ChatConfig'];
    const req = ent['@requires'];
    const asArr = Array.isArray(req) ? req : [req];
    expect(asArr).toContain('any');
  });
});
