import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CDS = readFileSync(join(import.meta.dirname, '../../../srv/admin-service.cds'), 'utf8');

describe('srv/admin-service.cds — explainer-generation actions (issue #759 PR 3a)', () => {
  it('declares generateVerbExplainers with ids array + mode string', () => {
    expect(CDS).toMatch(/action\s+generateVerbExplainers\s*\(\s*ids\s*:\s*array\s+of\s+String,\s*mode\s*:\s*String\s*\)/);
  });
  it('declares generateShelfExplainers with the same signature', () => {
    expect(CDS).toMatch(/action\s+generateShelfExplainers\s*\(\s*ids\s*:\s*array\s+of\s+String,\s*mode\s*:\s*String\s*\)/);
  });
  it('declares generateShelfEntryExplainers with the same signature', () => {
    expect(CDS).toMatch(/action\s+generateShelfEntryExplainers\s*\(\s*ids\s*:\s*array\s+of\s+String,\s*mode\s*:\s*String\s*\)/);
  });
  it('all three return { processed: Integer; skipped: Integer; cost: String }', () => {
    for (const action of ['generateVerbExplainers', 'generateShelfExplainers', 'generateShelfEntryExplainers']) {
      const re = new RegExp(`${action}[\\s\\S]{0,500}returns\\s+ExplainerActionResult`);
      expect(CDS, action).toMatch(re);
    }
    expect(CDS).toMatch(/type\s+ExplainerActionResult\s*:\s*\{[\s\S]{0,200}processed\s*:\s*Integer;[\s\S]{0,200}skipped\s*:\s*Integer;[\s\S]{0,200}cost\s*:\s*String;[\s\S]{0,50}\}/);
  });
});
