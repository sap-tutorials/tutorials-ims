import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('graphql schema shape (#996)', () => {
  let sdl;
  beforeAll(async () => {
    const csn = await cds.load('srv/');
    const { generateSchema4 } = await import('@cap-js/graphql/lib/schema/generateSchema.js').catch(() => ({}));
    if (typeof generateSchema4 === 'function') {
      sdl = generateSchema4(csn);
    } else {
      // Fallback: shell out to the plugin's SDL emit path we build in Task 9.
      const { emitSdl } = await import('../../scripts/emit-graphql-sdl.ts');
      sdl = await emitSdl(csn);
    }
  });

  it('exposes exactly the three services under Query', () => {
    expect(sdl).toMatch(/KnowledgeGraphService/);
    expect(sdl).toMatch(/SearchService/);
    expect(sdl).toMatch(/DeveloperService/);
    // Deny-list of unwanted services.
    expect(sdl).not.toMatch(/\bHomepageService\b/);   // dropped from v1 (Task 1 spike)
    expect(sdl).not.toMatch(/\bAdminService\b/);
    expect(sdl).not.toMatch(/\bAuthorService\b/);
    expect(sdl).not.toMatch(/\bExportsService\b/);
    expect(sdl).not.toMatch(/\bAnalyticsService\b/);
    expect(sdl).not.toMatch(/\bDisplayService\b/);
    expect(sdl).not.toMatch(/\bScannerService\b/);
    expect(sdl).not.toMatch(/\bChatService\b/);
    expect(sdl).not.toMatch(/\bConsolidationService\b/);
    expect(sdl).not.toMatch(/\bCronService\b/);
    expect(sdl).not.toMatch(/\bEventStreamService\b/);
  });

  it('does not leak draft-marker types', () => {
    expect(sdl).not.toMatch(/HasActiveEntity/);
    expect(sdl).not.toMatch(/SiblingEntity/);
    expect(sdl).not.toMatch(/IsActiveEntity/);
    expect(sdl).not.toMatch(/DraftAdministrativeData/);
  });

  it('does not leak KG admin entities', () => {
    // If any of these appear, either the plugin has changed or someone added
    // @graphql to a KG admin entity by accident.
    expect(sdl).not.toMatch(/ConceptClusters/);
    expect(sdl).not.toMatch(/KgCommunities\b/);
    expect(sdl).not.toMatch(/KgCommunityMembers/);
  });

  it('does not expose actions or functions', () => {
    // Plugin doesn't support actions/functions in v1. If any Mutation type
    // appears with an action name, something changed upstream.
    expect(sdl).not.toMatch(/pathBetween/);
    expect(sdl).not.toMatch(/neighborhood/);
    expect(sdl).not.toMatch(/promoteCommunityToMission/);
    expect(sdl).not.toMatch(/vetoEdge/);
    expect(sdl).not.toMatch(/completeStep/);
    expect(sdl).not.toMatch(/resetTutorialProgress/);
  });
});
