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
});
