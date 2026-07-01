// test/unit/srv/kg-explore-data-iri-types.test.js
//
// Lockstep test: the IRI prefix registry exported by kg-projection.js
// MUST stay in sync with the reverse-mapping in kg-explore-data.js. If
// a new entity type is added to the projection (a new iri* helper) but
// the registry is forgotten, this test fails loudly rather than silently
// dropping rows from /graph/explore-data (issue #446 code-review Fix 3).

import { describe, it, expect } from 'vitest';
import { KG_IRI_PREFIXES } from '../../../srv/lib/kg-projection.js';

const KG = 'https://developers.sap.com/kg/';

describe('IRI prefix lockstep', () => {
  const expectedTypes = ['tutorial', 'concept', 'mission', 'group', 'product', 'category', 'tag', 'learning-journey', 'blog-post', 'discovery-mission', 'video', 'api-doc', 'sample', 'help-doc'];

  it('every prefix in KG_IRI_PREFIXES has a corresponding helper export', () => {
    // Sanity: the registry covers exactly the 14 known entity types
    // (7 Phase 1-3 types + learning-journey from Phase 4.1 + blog-post from
    // Phase 4.2 + discovery-mission from Phase 4.3 + video from Phase 4.4
    // + api-doc from Phase 4.5 + sample from Phase 4.6 + help-doc from
    // Phase 4.7, #447 + #746 + #747 + #748).
    expect(Object.keys(KG_IRI_PREFIXES).sort()).toEqual([...expectedTypes].sort());
  });

  it('every prefix is rooted at the KG namespace', () => {
    for (const [type, prefix] of Object.entries(KG_IRI_PREFIXES)) {
      expect(prefix.startsWith(KG), `prefix for ${type} must start with ${KG}`).toBe(true);
    }
  });

  it('every prefix ends with a trailing slash (path-style IRI)', () => {
    for (const [type, prefix] of Object.entries(KG_IRI_PREFIXES)) {
      expect(prefix.endsWith('/'), `prefix for ${type} must end with /`).toBe(true);
    }
  });

  it('every prefix has the shape "<KG>/<type>/"', () => {
    for (const type of expectedTypes) {
      expect(KG_IRI_PREFIXES[type]).toBe(`${KG}${type}/`);
    }
  });

  it('KG_IRI_PREFIXES is frozen (single source of truth — immutable)', () => {
    expect(Object.isFrozen(KG_IRI_PREFIXES)).toBe(true);
  });
});

describe('iriLearningJourney helper (#447)', () => {
  it('builds an IRI from the registry prefix', async () => {
    const { iriLearningJourney } = await import('../../../srv/lib/kg-projection.js');
    expect(iriLearningJourney('joule-across-landscape')).toBe(
      `${KG}learning-journey/joule-across-landscape`
    );
  });
});

describe('SHORT_BY_TYPE lockstep (#447)', () => {
  it('has a short prefix for every type in KG_IRI_PREFIXES', async () => {
    const { SHORT_BY_TYPE } = await import('../../../srv/lib/kg-explore-data.js');
    for (const type of Object.keys(KG_IRI_PREFIXES)) {
      expect(
        SHORT_BY_TYPE[type],
        `SHORT_BY_TYPE is missing an entry for "${type}"; explore-data would emit "undefined:<slug>"`,
      ).toBeTruthy();
    }
  });

  it('learning-journey shortcut is "lj"', async () => {
    const { SHORT_BY_TYPE } = await import('../../../srv/lib/kg-explore-data.js');
    expect(SHORT_BY_TYPE['learning-journey']).toBe('lj');
  });
});
