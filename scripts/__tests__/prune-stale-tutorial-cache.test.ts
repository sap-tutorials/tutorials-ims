// scripts/__tests__/prune-stale-tutorial-cache.test.ts
//
// Unit tests for the prune helper extracted from fetch-tutorials.ts.
// Spec / regression context: 2026-06-30 orphan-purge run dropped 21 of 24
// ghost tutorials. The 3 survivors were stale `.tutorial-cache/<slug>.md`
// files preserved by actions/cache@v4 across CI runs after their upstream
// sources were deleted from GitHub. This helper deletes them at the end
// of each fetch run so the cache stays self-consistent with discovery.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneStaleTutorialCache } from '../fetch-tutorials.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'prune-cache-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seed(filename: string, content = '# placeholder') {
  writeFileSync(join(tmp, filename), content, 'utf-8');
}

describe('pruneStaleTutorialCache', () => {
  it('deletes <slug>.md files for slugs not in discovery', () => {
    seed('keep-me.md');
    seed('stale-one.md');
    seed('stale-two.md');
    const discovered = new Set(['keep-me']);

    const { stale, failed } = pruneStaleTutorialCache(tmp, discovered);

    expect(stale.sort()).toEqual(['stale-one', 'stale-two']);
    expect(failed).toEqual([]);
    expect(readdirSync(tmp).sort()).toEqual(['keep-me.md']);
  });

  it('returns empty stale[] when every cached slug is in discovery', () => {
    seed('one.md');
    seed('two.md');
    const discovered = new Set(['one', 'two', 'extra-in-discovery-not-on-disk']);

    const { stale, failed } = pruneStaleTutorialCache(tmp, discovered);

    expect(stale).toEqual([]);
    expect(failed).toEqual([]);
    expect(readdirSync(tmp).sort()).toEqual(['one.md', 'two.md']);
  });

  it('does NOT touch sidecar files (.sha / .rules.vr / .ai-quiz-cache.json / .parser-validation.json)', () => {
    // These have independent lifecycles. The 2026-06-30 regression that
    // prompted this helper was strictly about <slug>.md staleness; pruning
    // sidecars would create a different orphan class (a sidecar without
    // its parent .md).
    seed('keep-me.md');
    seed('keep-me.sha');
    seed('keep-me.rules.vr');
    seed('keep-me.ai-quiz-cache.json');
    seed('orphan-sidecar.sha');                   // .md gone, sidecar lingering
    seed('orphan-sidecar.ai-quiz-cache.json');
    seed('stale-one.md');
    const discovered = new Set(['keep-me']);

    const { stale } = pruneStaleTutorialCache(tmp, discovered);

    expect(stale).toEqual(['stale-one']);
    // All sidecars survive — only .md got pruned
    expect(readdirSync(tmp).sort()).toEqual([
      'keep-me.ai-quiz-cache.json',
      'keep-me.md',
      'keep-me.rules.vr',
      'keep-me.sha',
      'orphan-sidecar.ai-quiz-cache.json',
      'orphan-sidecar.sha',
    ]);
  });

  it('skips _*-prefixed files (cache convention: _nav.json, _foo.md drafts)', () => {
    // Mirrors the same prefix check the downstream consumers use
    // (fetch-tutorials.ts line ~576, publish-content.ts source-markdown
    // hash pass).
    seed('_nav.json');
    seed('_draft.md');
    seed('keep-me.md');
    seed('stale-one.md');
    const discovered = new Set(['keep-me']);

    const { stale } = pruneStaleTutorialCache(tmp, discovered);

    expect(stale).toEqual(['stale-one']);
    expect(readdirSync(tmp).includes('_nav.json')).toBe(true);
    expect(readdirSync(tmp).includes('_draft.md')).toBe(true);
  });

  it('case-insensitive slug matching (legacy mixed-case cache file survives if discovery has lowercase)', () => {
    // CLAUDE.md > "Tutorial slugs are lowercase canonical" — the publish
    // path lowercases on write, but legacy cache files may exist in
    // mixed case from earlier days. Don't unintentionally delete a row
    // that IS in discovery just because its on-disk filename casing
    // doesn't match exactly.
    seed('Mixed-Case-Slug.md');
    seed('stale-one.md');
    const discovered = new Set(['mixed-case-slug']);

    const { stale } = pruneStaleTutorialCache(tmp, discovered);

    expect(stale).toEqual(['stale-one']);
    expect(readdirSync(tmp).includes('Mixed-Case-Slug.md')).toBe(true);
  });

  it('returns empty result when cacheDir does not exist (no crash)', () => {
    // Fresh-clone path: no cache yet → nothing to prune.
    const { stale, failed } = pruneStaleTutorialCache(join(tmp, 'does-not-exist'), new Set());
    expect(stale).toEqual([]);
    expect(failed).toEqual([]);
  });

  it('returns empty stale[] when discovery is empty AND cache is empty', () => {
    const { stale, failed } = pruneStaleTutorialCache(tmp, new Set());
    expect(stale).toEqual([]);
    expect(failed).toEqual([]);
  });

  it('prunes EVERY .md file when discovery is empty (with a populated cache)', () => {
    // Degenerate but well-defined: empty discovery = every cache .md is
    // stale. Real-world this only happens if fetch's discovery step ran
    // but found zero repos (e.g. all repos got delisted overnight). Not
    // a normal failure mode but the helper must not surprise here.
    seed('one.md');
    seed('two.md');
    seed('keep.sha');

    const { stale } = pruneStaleTutorialCache(tmp, new Set());

    expect(stale.sort()).toEqual(['one', 'two']);
    expect(readdirSync(tmp)).toEqual(['keep.sha']);
  });
});
