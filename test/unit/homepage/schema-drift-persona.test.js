// test/unit/homepage/schema-drift-persona.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('HomepageShelves + HomepageForYouCandidates persona fields', () => {
  let model;
  beforeAll(async () => {
    model = await cds.load(['db/schema.cds', 'db/homepage.cds']);
  });

  it('HomepageShelves has personaTags, personaWeight, personaHidden', () => {
    const e = model.definitions['com.sap.developers.ims.HomepageShelves'];
    expect(e).toBeDefined();
    expect(e.elements.personaTags).toBeDefined();
    expect(e.elements.personaTags.items?.type).toBe('cds.String');
    expect(e.elements.personaWeight?.type).toBe('cds.Integer');
    expect(e.elements.personaHidden).toBeDefined();
    expect(e.elements.personaHidden.items?.type).toBe('cds.String');
  });

  it('HomepageForYouCandidates exists with required fields', () => {
    const e = model.definitions['com.sap.developers.ims.HomepageForYouCandidates'];
    expect(e).toBeDefined();
    for (const f of ['kind', 'targetSlug', 'title', 'description', 'imageUrl',
                     'personaTags', 'personaWeight', 'personaHidden',
                     'sortOrder', 'active']) {
      expect(e.elements[f], `field ${f} missing`).toBeDefined();
    }
  });
});
