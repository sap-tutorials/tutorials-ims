import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSourceReposPayload } from '../scripts/publish-content.ts';

describe('buildSourceReposPayload', () => {
  it('reads <slug>.source-repo sidecars (lowercase filename), keyed by original-case slug', () => {
    const dir = mkdtempSync(join(tmpdir(), 'srp-'));
    writeFileSync(join(dir, 'my-slug.source-repo'), 'sap-tutorials/developer-advocates-Contribution\n', 'utf-8');
    const out = buildSourceReposPayload(['My-Slug'], dir);
    expect(out['My-Slug']).toBe('sap-tutorials/developer-advocates-Contribution');
  });

  it('skips slugs with no sidecar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'srp-'));
    const out = buildSourceReposPayload(['absent'], dir);
    expect(out.absent).toBeUndefined();
  });
});
