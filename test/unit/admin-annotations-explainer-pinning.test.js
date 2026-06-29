import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CDS = readFileSync(join(import.meta.dirname, '../../app/admin-annotations.cds'), 'utf8');

describe('app/admin-annotations.cds — explainer admin UI pinning (#759 PR 3b)', () => {
  describe('HomepageShelves Explainer facet', () => {
    it('adds an Explainer ReferenceFacet pointing to FieldGroup#Explainer', () => {
      // The existing block already has a 'General' facet; we add a second referencing FieldGroup#Explainer.
      expect(CDS).toMatch(/HomepageShelves[\s\S]{0,3000}UI\.Facets\s*:\s*\[[\s\S]{0,800}Target\s*:\s*'@UI\.FieldGroup#Explainer'/);
    });
    it('defines FieldGroup#Explainer containing tagline, whyItMatters, authoringStatus', () => {
      expect(CDS).toMatch(/HomepageShelves[\s\S]{0,5000}UI\.FieldGroup\s*#Explainer\s*:\s*\{\s*Data\s*:\s*\[[\s\S]{0,500}Value\s*:\s*tagline[\s\S]{0,300}Value\s*:\s*whyItMatters[\s\S]{0,300}Value\s*:\s*authoringStatus/);
    });
  });
});
