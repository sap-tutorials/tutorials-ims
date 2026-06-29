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

  describe('VerbDefinitions annotations', () => {
    it('declares LineItem with verbKey + label + sortOrder + authoringStatus', () => {
      expect(CDS).toMatch(/annotate\s+AdminService\.VerbDefinitions[\s\S]{0,500}UI\.LineItem[\s\S]{0,500}Value\s*:\s*verbKey[\s\S]{0,400}Value\s*:\s*label[\s\S]{0,400}Value\s*:\s*sortOrder[\s\S]{0,400}Value\s*:\s*authoringStatus/);
    });
    it('declares CRUD lockdown — Insertable: false + Deletable: false', () => {
      expect(CDS).toMatch(/annotate\s+AdminService\.VerbDefinitions[\s\S]{0,2000}Capabilities\.InsertRestrictions\.Insertable\s*:\s*false/);
      expect(CDS).toMatch(/annotate\s+AdminService\.VerbDefinitions[\s\S]{0,2000}Capabilities\.DeleteRestrictions\.Deletable\s*:\s*false/);
    });
    it('marks verbKey as @Common.FieldControl: #ReadOnly', () => {
      expect(CDS).toMatch(/annotate\s+AdminService\.VerbDefinitions\s*\{[\s\S]{0,500}verbKey\s+@Common\.FieldControl\s*:\s*#ReadOnly/);
    });
  });

  describe('ShelfDefinitions annotations', () => {
    it('declares LineItem with shelfKey + label + sortOrder + authoringStatus', () => {
      expect(CDS).toMatch(/annotate\s+AdminService\.ShelfDefinitions[\s\S]{0,500}UI\.LineItem[\s\S]{0,500}Value\s*:\s*shelfKey[\s\S]{0,400}Value\s*:\s*label[\s\S]{0,400}Value\s*:\s*sortOrder[\s\S]{0,400}Value\s*:\s*authoringStatus/);
    });
    it('declares CRUD lockdown', () => {
      expect(CDS).toMatch(/annotate\s+AdminService\.ShelfDefinitions[\s\S]{0,2000}Capabilities\.InsertRestrictions\.Insertable\s*:\s*false/);
      expect(CDS).toMatch(/annotate\s+AdminService\.ShelfDefinitions[\s\S]{0,2000}Capabilities\.DeleteRestrictions\.Deletable\s*:\s*false/);
    });
    it('marks shelfKey as @Common.FieldControl: #ReadOnly', () => {
      expect(CDS).toMatch(/annotate\s+AdminService\.ShelfDefinitions\s*\{[\s\S]{0,500}shelfKey\s+@Common\.FieldControl\s*:\s*#ReadOnly/);
    });
  });
});
