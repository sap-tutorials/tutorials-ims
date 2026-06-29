import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = readFileSync(join(import.meta.dirname, '../../../db/homepage.cds'), 'utf8');

describe('db/homepage.cds — explainer additions (issue #759 PR 1)', () => {
  describe('AuthoringStatus enum', () => {
    it('declares the type with three values', () => {
      expect(SCHEMA).toMatch(/type\s+AuthoringStatus\s*:\s*String\s+enum\s*\{/);
      expect(SCHEMA).toMatch(/BLANK\s*;/);
      expect(SCHEMA).toMatch(/AI_SEEDED\s*;/);
      expect(SCHEMA).toMatch(/REVIEWED\s*;/);
    });
  });

  describe('HomepageShelves new fields', () => {
    it('declares tagline : String(140) nullable', () => {
      expect(SCHEMA).toMatch(/tagline\s*:\s*String\(140\)\s*;/);
    });
    it('declares whyItMatters : String(800) nullable', () => {
      expect(SCHEMA).toMatch(/whyItMatters\s*:\s*String\(800\)\s*;/);
    });
    it('declares authoringStatus with default BLANK and @assert.range', () => {
      expect(SCHEMA).toMatch(/authoringStatus\s*:\s*AuthoringStatus\s+default\s+'BLANK'\s+@assert\.range\s*;/);
    });
  });

  describe('VerbDefinitions entity', () => {
    it('declares the entity with verbKey unique constraint', () => {
      expect(SCHEMA).toMatch(/@assert\.unique\.verbKey:\s*\[verbKey\]/);
      expect(SCHEMA).toMatch(/entity\s+VerbDefinitions\s*:\s*cuid,\s*managed\s*\{/);
    });
    it('declares verbKey : HomepageVerb mandatory with @assert.range', () => {
      expect(SCHEMA).toMatch(/verbKey\s*:\s*HomepageVerb\s+@mandatory\s+@assert\.range\s*;/);
    });
    it('declares label : String(40) mandatory', () => {
      expect(SCHEMA).toMatch(/label\s*:\s*String\(40\)\s+@mandatory\s*;/);
    });
    it('declares iconName : String(40)', () => {
      expect(SCHEMA).toMatch(/iconName\s*:\s*String\(40\)\s*;/);
    });
    it('declares sortOrder : Integer default 100', () => {
      expect(SCHEMA).toMatch(/sortOrder\s*:\s*Integer\s+default\s+100\s*;/);
    });
  });

  describe('ShelfDefinitions entity', () => {
    it('declares the entity with shelfKey unique constraint', () => {
      expect(SCHEMA).toMatch(/@assert\.unique\.shelfKey:\s*\[shelfKey\]/);
      expect(SCHEMA).toMatch(/entity\s+ShelfDefinitions\s*:\s*cuid,\s*managed\s*\{/);
    });
    it('declares shelfKey : HomepageShelf mandatory with @assert.range', () => {
      expect(SCHEMA).toMatch(/shelfKey\s*:\s*HomepageShelf\s+@mandatory\s+@assert\.range\s*;/);
    });
  });

  describe('VerbDefinitions seed CSV', () => {
    const csv = readFileSync(
      join(import.meta.dirname, '../../../db/data/com.sap.developers.ims-VerbDefinitions.csv'),
      'utf8'
    );
    const lines = csv.trim().split(/\r?\n/);
    it('has header + 6 rows', () => {
      expect(lines.length).toBe(7);
    });
    it('header uses ID;verbKey;label;iconName;sortOrder;tagline;whyItMatters;authoringStatus', () => {
      expect(lines[0]).toBe('ID;verbKey;label;iconName;sortOrder;tagline;whyItMatters;authoringStatus');
    });
    it.each([
      ['LEARN', 'Learn', 'learning-assistant', 10],
      ['BUILD', 'Build', 'developer-settings', 20],
      ['INTEGRATE', 'Integrate', 'chain-link', 30],
      ['OPERATE', 'Operate', 'settings', 40],
      ['AI', 'Extend with AI', 'da', 50],
      ['CONNECT', 'Connect', 'customer-and-contacts', 60],
    ])('row for %s has correct label + icon + sortOrder', (verbKey, label, icon, sort) => {
      const row = lines.find(l => l.includes(`;${verbKey};`));
      expect(row).toBeDefined();
      expect(row).toContain(`;${verbKey};${label};${icon};${sort};`);
    });
    it('every row has authoringStatus=BLANK and empty tagline/whyItMatters', () => {
      lines.slice(1).forEach(line => {
        expect(line).toMatch(/;;;BLANK$/);
      });
    });
  });

  describe('ShelfDefinitions seed CSV', () => {
    const csv = readFileSync(
      join(import.meta.dirname, '../../../db/data/com.sap.developers.ims-ShelfDefinitions.csv'),
      'utf8'
    );
    const lines = csv.trim().split(/\r?\n/);
    it('has header + 4 rows', () => {
      expect(lines.length).toBe(5);
    });
    it('header uses ID;shelfKey;label;sortOrder;tagline;whyItMatters;authoringStatus', () => {
      expect(lines[0]).toBe('ID;shelfKey;label;sortOrder;tagline;whyItMatters;authoringStatus');
    });
    it.each([
      ['START_HERE', 'Start here', 10],
      ['REFERENCE', 'Reference', 20],
      ['TOOLS', 'Tools & samples', 30],
      ['KEEP_CURRENT', 'Keep current', 40],
    ])('row for %s has correct label + sortOrder', (shelfKey, label, sort) => {
      const row = lines.find(l => l.includes(`;${shelfKey};`));
      expect(row).toBeDefined();
      expect(row).toContain(`;${shelfKey};${label};${sort};`);
    });
    it('every row has authoringStatus=BLANK and empty tagline/whyItMatters', () => {
      lines.slice(1).forEach(line => {
        expect(line).toMatch(/;;;BLANK$/);
      });
    });
  });
});
