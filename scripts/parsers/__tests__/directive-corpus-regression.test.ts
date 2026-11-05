// scripts/parsers/__tests__/directive-corpus-regression.test.ts
//
// Test harness for the directive corpus regression check.
//
// Invokes the pure `runCorpusRegression()` function (from
// scripts/check-directive-corpus-regression.ts) against the bundled
// multi-construct fixture and asserts:
//   1. Two independent composeTutorial runs on the same source produce
//      BYTE-IDENTICAL output — strict `toBe`, not `toContain`.
//   2. The :::directive-looking text inside the fenced code block survives
//      verbatim (not mangled by expandDirectives).
//   3. The check reports zero failures.
//
// The bundled fixture combines:
//   - [OPTION BEGIN [Windows/Mac]] … [OPTION END] OS option blocks
//   - [BRANCH_BEGIN] … [BRANCH_END] branch blocks
//   - {{var:groupNumber}} variable tokens with matching `variables:` frontmatter
//   - Blockquotes (> lines)
//   - Nested lists
//   - A fenced code block containing `:::directive-looking[label]{attr=value}`
//     text (must survive byte-identical — the fence masker guards it)
//
// Real .tutorial-cache/ loop:
//   If .tutorial-cache/ is populated, runCorpusRegression() iterates real
//   tutorials and asserts byte-identity there too. Absence is a graceful skip,
//   not a failure — mirroring the step-attrs-corpus-regression pattern.

import { describe, it, expect, beforeEach } from 'vitest';
import { resetRegistry } from '../directive-registry.js';
import {
  runCorpusRegression,
  BUNDLED_FIXTURE,
} from '../../check-directive-corpus-regression.js';
import { composeTutorial } from '../compose.js';

describe('directive-corpus-regression: empty registry → expandDirectives is identity', () => {
  beforeEach(() => {
    resetRegistry();
  });

  // ── 1. runCorpusRegression reports zero failures ───────────────────────────

  it('runCorpusRegression() reports zero failures on the bundled fixture', () => {
    const result = runCorpusRegression();
    // If there were failures, surface them as the assertion message
    expect(result.failures, result.messages.join('\n')).toBe(0);
    expect(result.checked).toBeGreaterThan(0);
  });

  // ── 2. Bundled fixture: two runs are byte-identical ───────────────────────

  it('two composeTutorial runs on the bundled fixture are byte-identical (strict toBe)', () => {
    const run1 = composeTutorial(BUNDLED_FIXTURE, {
      repo: 'test-repo',
      branch: 'main',
      slug: 'corpus-regression-run-1',
      target: 'hugo',
      rewriteImages: false,
    });
    const run2 = composeTutorial(BUNDLED_FIXTURE, {
      repo: 'test-repo',
      branch: 'main',
      slug: 'corpus-regression-run-2',
      target: 'hugo',
      rewriteImages: false,
    });
    // Strict byte equality — not toContain or toEqual on a subset.
    // Any difference here means expandDirectives mangled something in one run.
    expect(run1.body).toBe(run2.body);
  });

  // ── 3. Code fence :::directive content survives verbatim ──────────────────

  it(':::directive-looking text inside a fenced code block survives verbatim in composed body', () => {
    const result = composeTutorial(BUNDLED_FIXTURE, {
      repo: 'test-repo',
      branch: 'main',
      slug: 'corpus-regression-fence-guard',
      target: 'hugo',
      rewriteImages: false,
    });
    // The fenced code block contains this exact string — it must not be
    // transformed, mangled, or removed by expandDirectives.
    expect(result.body).toContain(':::directive-looking[label]{attr=value}');
    // Leaf directive syntax inside the fence must also survive
    expect(result.body).toContain('::leaf-directive[label]');
    // Inline directive inside the fence must survive
    expect(result.body).toContain(':inline-directive[text]');
  });

  // ── 4. Step count and structure intact after empty-registry pass ──────────

  it('composeTutorial still produces steps and title correctly (not destroyed by empty registry)', () => {
    const result = composeTutorial(BUNDLED_FIXTURE, {
      repo: 'test-repo',
      branch: 'main',
      slug: 'corpus-regression-structure',
      target: 'hugo',
      rewriteImages: false,
    });
    expect(result.title).toBe('Corpus Regression Fixture');
    // The fixture has 6 `### Step N` headings (some with branches).
    // Branch sub-steps count as additional steps after extraction.
    // Just verify at least the 6 top-level steps are present.
    expect(result.steps.length).toBeGreaterThanOrEqual(6);
  });

  // ── 5. Option block structure intact ─────────────────────────────────────

  it('hasOsOptions is true when the bundled fixture has [OPTION BEGIN] blocks', () => {
    const result = composeTutorial(BUNDLED_FIXTURE, {
      repo: 'test-repo',
      branch: 'main',
      slug: 'corpus-regression-options',
      target: 'hugo',
      rewriteImages: false,
    });
    expect(result.hasOsOptions).toBe(true);
  });
});
