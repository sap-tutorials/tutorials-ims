import { describe, it, expect } from 'vitest';
import { extractMetadata } from '../../scripts/publish-content.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('publish-content metadata payload', () => {
  it('carries frontmatter author display name as frontmatterAuthorName', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-'));
    writeFileSync(
      join(dir, 'my-slug.md'),
      '---\ntitle: My Slug\nauthor: "Matthäus Schüle"\ngithubLogin: MatthaeusSchuele\nsteps: []\n---\nbody\n'
    );
    const payload = extractMetadata(dir, ['my-slug']);
    expect(payload['my-slug'].frontmatterAuthorName).toBe('Matthäus Schüle');
  });

  it('sets frontmatterAuthorName null when author is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-'));
    writeFileSync(
      join(dir, 'no-author.md'),
      '---\ntitle: No Author\nsteps: []\n---\nbody\n'
    );
    const payload = extractMetadata(dir, ['no-author']);
    expect(payload['no-author'].frontmatterAuthorName).toBeNull();
  });

  it('sets frontmatterAuthorName null when author is empty string', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-'));
    writeFileSync(
      join(dir, 'empty-author.md'),
      '---\ntitle: Empty Author\nauthor: "   "\nsteps: []\n---\nbody\n'
    );
    const payload = extractMetadata(dir, ['empty-author']);
    expect(payload['empty-author'].frontmatterAuthorName).toBeNull();
  });
});
