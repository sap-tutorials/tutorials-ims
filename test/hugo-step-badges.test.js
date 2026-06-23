// test/hugo-step-badges.test.js
//
// Source-string tests for the three-slot step-navigation indicator badges
// (quiz, codecheck, branch). The spec at
// docs/superpowers/specs/2026-06-23-step-nav-codecheck-branch-indicators-design.md
// covers the design rationale.
//
// We assert against the template/CSS source rather than rendering Hugo because:
//   (a) the repo has no Hugo render harness;
//   (b) Vitest in jsdom stubs imported CSS (returns empty getComputedStyle), so
//       layout assertions via the DOM would be tautological — see the
//       feedback_vitest_skips_imported_css memory; and
//   (c) the change is ~150 LOC of HTML+CSS that's easy to scan in source.
// A manual visual-smoke step in the spec test plan covers what the source-string
// tests cannot (e.g. that the SVG masks actually render).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');

const CSS_PATH      = join(REPO_ROOT, 'hugo/assets/css/sap-fundamental.css');
const SIDEBAR_PATH  = join(REPO_ROOT, 'hugo/layouts/partials/tutorial-sidebar.html');
const U1_PATH       = join(REPO_ROOT, 'hugo/layouts/tutorials/u1-object-page.html');

const css     = readFileSync(CSS_PATH,     'utf8');
const sidebar = readFileSync(SIDEBAR_PATH, 'utf8');
const u1      = readFileSync(U1_PATH,      'utf8');

describe('step-nav indicator badges — CSS', () => {
  it('defines the generic .step-badge rule', () => {
    expect(css).toMatch(/\.step-badge\s*\{[^}]*?border-radius:\s*50%/);
  });

  it('defines all three indicator modifiers', () => {
    expect(css).toMatch(/\.step-badge--quiz\b/);
    expect(css).toMatch(/\.step-badge--codecheck\b/);
    expect(css).toMatch(/\.step-badge--branch\b/);
  });

  it('tints each modifier with the correct Horizon token', () => {
    // currentColor pattern: each modifier sets `color: var(--sapXxx, #hex)`.
    expect(css).toMatch(/\.step-badge--quiz[\s\S]*?--sapPositiveColor/);
    expect(css).toMatch(/\.step-badge--codecheck[\s\S]*?--sapInformativeColor/);
    expect(css).toMatch(/\.step-badge--branch[\s\S]*?--sapAccentColor6/);
  });

  it('embeds the three SAP v5 icon glyph paths as CSS mask data-URIs', () => {
    // A short, distinctive substring from each pathData (extracted verbatim
    // from @ui5/webcomponents-icons/dist/v5/<name>.js at design time).
    // If the icon font is ever migrated to a new version, these substrings
    // will fail and force the author to re-extract.
    const QUIZ_PATH_FRAGMENT      = 'M8 0a8 8 0 1 1 0 16';        // question-mark
    const CODECHECK_PATH_FRAGMENT = 'M3.742 4.2a.75.75 0 0 1';    // source-code
    const BRANCH_PATH_FRAGMENT    = 'M12.821 3.999c.492.4 1.045'; // decision
    expect(css).toContain(QUIZ_PATH_FRAGMENT);
    expect(css).toContain(CODECHECK_PATH_FRAGMENT);
    expect(css).toContain(BRANCH_PATH_FRAGMENT);
  });

  it('declares the .step-badge-row wrapper with row-reverse stacking', () => {
    // row-reverse is what anchors the rightmost slot at right:-4px regardless
    // of how many slots are present — see spec "Stacking" section.
    expect(css).toMatch(/\.step-badge-row[\s\S]*?flex-direction:\s*row-reverse/);
  });

  it('positions .step-badge-row absolutely inside .step-toc-circle (desktop)', () => {
    expect(css).toMatch(/\.step-toc-circle\s+\.step-badge-row[\s\S]*?position:\s*absolute/);
  });

  it('no longer defines the obsolete .step-toc-quiz-dot rule', () => {
    // PR #568's bare-dot rule is replaced wholesale by .step-badge--quiz.
    expect(css).not.toMatch(/\.step-toc-quiz-dot\b/);
  });
});

describe('step-nav indicator badges — desktop sidebar partial', () => {
  it('emits the badge row inside .step-toc-circle', () => {
    expect(sidebar).toMatch(/<span class="step-toc-circle">[\s\S]*?step-badge-row[\s\S]*?<\/span>/);
  });

  it('guards each badge with the correct frontmatter field', () => {
    expect(sidebar).toMatch(/\{\{\s*with\s+\.validation\s*\}\}[\s\S]*?step-badge--quiz/);
    expect(sidebar).toMatch(/\{\{\s*with\s+\.codeCheck\s*\}\}[\s\S]*?step-badge--codecheck/);
    expect(sidebar).toMatch(/\{\{\s*with\s+\.branchGroup\s*\}\}[\s\S]*?step-badge--branch/);
  });

  it('emits badges in DOM order branch → codecheck → quiz (matches row-reverse → visual quiz/codecheck/branch L→R)', () => {
    // Spec mandates left-to-right visual order: quiz, codecheck, branch.
    // With `flex-direction: row-reverse`, the FIRST DOM child renders rightmost.
    // So DOM must be branch → codecheck → quiz to produce visual L→R quiz/codecheck/branch.
    // This also means a step with only `branchGroup` correctly anchors at right:-4px,
    // matching the spec's "rightmost slot fills first" rationale.
    expect(sidebar).toMatch(/step-badge--branch[\s\S]*?step-badge--codecheck[\s\S]*?step-badge--quiz/);
  });

  it('wraps the badge row in an outer presence guard', () => {
    // {{ if or .validation .codeCheck .branchGroup }} — prevents an empty
    // .step-badge-row from shipping when a step has zero indicators.
    expect(sidebar).toMatch(/\{\{\s*if\s+or\s+\.validation\s+\.codeCheck\s+\.branchGroup\s*\}\}/);
  });

  it('no longer references the obsolete .step-toc-quiz-dot class', () => {
    expect(sidebar).not.toMatch(/step-toc-quiz-dot/);
  });
});

describe('step-nav indicator badges — mobile step-sheet (u1-object-page)', () => {
  it('emits the badge row before the step number text in the ui5-li slot', () => {
    // The badges precede `{{ .number }}. {{ .title }}` in the default slot.
    expect(u1).toMatch(/<ui5-li[^>]*>[\s\S]*?step-badge-row[\s\S]*?\{\{\s*\.number\s*\}\}\.\s+\{\{\s*\.title\s*\}\}/);
  });

  it('no longer carries the PR #568 additional-text attributes', () => {
    // The mobile path moves from additional-text="Question" to inline badges
    // for parity with desktop.
    expect(u1).not.toMatch(/additional-text="Question"/);
    expect(u1).not.toMatch(/additional-text-state="Positive"/);
  });

  it('guards each badge with the correct frontmatter field', () => {
    expect(u1).toMatch(/\{\{\s*with\s+\.validation\s*\}\}[\s\S]*?step-badge--quiz/);
    expect(u1).toMatch(/\{\{\s*with\s+\.codeCheck\s*\}\}[\s\S]*?step-badge--codecheck/);
    expect(u1).toMatch(/\{\{\s*with\s+\.branchGroup\s*\}\}[\s\S]*?step-badge--branch/);
  });

  it('emits badges in DOM order branch → codecheck → quiz (same as desktop, for visual L→R quiz/codecheck/branch under row-reverse)', () => {
    expect(u1).toMatch(/step-badge--branch[\s\S]*?step-badge--codecheck[\s\S]*?step-badge--quiz/);
  });
});
