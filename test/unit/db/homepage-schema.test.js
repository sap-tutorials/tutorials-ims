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
});
