/**
 * Tests for #2727 — render-pipeline version token.
 *
 * Content change-detection keys on per-slug rendered-HTML hashes. A fix that
 * changes the GENERATED HTML but leaves a tutorial's SOURCE markdown identical
 * — a parser (scripts/parsers/**), Hugo template/shortcode, or CSS change —
 * must still re-publish every slug. The pipeline token is a single hash over
 * the render-pipeline inputs; when it changes, the delta plan treats every
 * slug as changed, independent of per-slug hashing.
 *
 * `hashPipelineInputs` is the pure core (no FS): the FS collector
 * `computePipelineToken` layers glob+read on top and is covered by a
 * tmpdir test.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPipelineInputs, computePipelineToken } from '../pipeline-token.ts';

describe('hashPipelineInputs (#2727)', () => {
  it('produces a stable 64-char hex SHA-256 for a fixed input set', () => {
    const token = hashPipelineInputs([
      { path: 'scripts/parsers/options.ts', content: 'export const x = 1;' },
      { path: 'hugo/layouts/tutorial.html', content: '<main>{{ .Content }}</main>' },
    ]);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is order-independent (sorts by path before hashing)', () => {
    const a = hashPipelineInputs([
      { path: 'a.ts', content: 'A' },
      { path: 'b.ts', content: 'B' },
    ]);
    const b = hashPipelineInputs([
      { path: 'b.ts', content: 'B' },
      { path: 'a.ts', content: 'A' },
    ]);
    expect(a).toBe(b);
  });

  it('changes when any file content changes (parser-only fix)', () => {
    const before = hashPipelineInputs([{ path: 'scripts/parsers/options.ts', content: 'old' }]);
    const after = hashPipelineInputs([{ path: 'scripts/parsers/options.ts', content: 'new' }]);
    expect(after).not.toBe(before);
  });

  it('changes when a file is added or removed', () => {
    const one = hashPipelineInputs([{ path: 'a.ts', content: 'A' }]);
    const two = hashPipelineInputs([
      { path: 'a.ts', content: 'A' },
      { path: 'b.ts', content: 'B' },
    ]);
    expect(two).not.toBe(one);
  });

  it('is not confusable by content/path boundary shifting (length-delimited)', () => {
    // Without a length delimiter, {path:'ab', content:'c'} and
    // {path:'a', content:'bc'} could hash identically. They must not.
    const x = hashPipelineInputs([{ path: 'ab', content: 'c' }]);
    const y = hashPipelineInputs([{ path: 'a', content: 'bc' }]);
    expect(x).not.toBe(y);
  });

  it('normalizes path separators so the token is stable cross-platform', () => {
    const win = hashPipelineInputs([{ path: 'scripts\\parsers\\options.ts', content: 'A' }]);
    const posix = hashPipelineInputs([{ path: 'scripts/parsers/options.ts', content: 'A' }]);
    expect(win).toBe(posix);
  });
});

describe('computePipelineToken (#2727) — FS collector', () => {
  it('hashes files matched by the given patterns under root and changes when one edits', () => {
    const root = mkdtempSync(join(tmpdir(), 'piptok-'));
    try {
      mkdirSync(join(root, 'scripts', 'parsers'), { recursive: true });
      mkdirSync(join(root, 'hugo', 'layouts'), { recursive: true });
      writeFileSync(join(root, 'scripts', 'parsers', 'options.ts'), 'export const x = 1;');
      writeFileSync(join(root, 'hugo', 'layouts', 'tutorial.html'), '<main></main>');
      // A file OUTSIDE the pattern set must not affect the token.
      writeFileSync(join(root, 'README.md'), 'ignore me');

      const patterns = ['scripts/parsers/**/*.ts', 'hugo/layouts/**/*.html'];
      const t1 = computePipelineToken({ root, patterns });
      expect(t1).toMatch(/^[0-9a-f]{64}$/);

      // Editing an unrelated file does not change the token.
      writeFileSync(join(root, 'README.md'), 'still ignored, but different');
      expect(computePipelineToken({ root, patterns })).toBe(t1);

      // Editing a tracked parser file DOES change the token.
      writeFileSync(join(root, 'scripts', 'parsers', 'options.ts'), 'export const x = 2;');
      expect(computePipelineToken({ root, patterns })).not.toBe(t1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns a deterministic token for an empty match set', () => {
    const root = mkdtempSync(join(tmpdir(), 'piptok-empty-'));
    try {
      const t = computePipelineToken({ root, patterns: ['does/not/exist/**'] });
      expect(t).toMatch(/^[0-9a-f]{64}$/);
      expect(computePipelineToken({ root, patterns: ['does/not/exist/**'] })).toBe(t);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
