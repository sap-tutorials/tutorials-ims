# Step-Nav Indicator Badges (Codecheck + Branch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the PR #568 quiz-dot skeleton in the step-navigation TOC to three slot indicators (quiz, codecheck, branch), each rendered as a colored 14px badge with a distinct SAP-icon glyph; upgrade the existing quiz dot to share the same visual; achieve visual parity on desktop sidebar and mobile bottom-sheet.

**Architecture:** Pure build-time-static change. Per-step frontmatter fields `validation`, `codeCheck`, `branchGroup` (already emitted) drive three Hugo `{{ with }}` guards inside a shared `.step-badge-row` wrapper. CSS paints each badge via `mask-image: url("data:image/svg+xml;…")` with `background-color: currentColor`, scoped per-modifier (`--quiz`, `--codecheck`, `--branch`). Three SAP v5/Horizon icon paths (`question-mark`, `source-code`, `decision`) extracted verbatim from `@ui5/webcomponents-icons/dist/v5/` are embedded inline in the CSS. Zero runtime JS; zero parser changes.

**Tech Stack:** Hugo templates, CSS (mask-image data-URIs), Vitest (source-string assertions only — no jsdom layout, no Hugo render harness).

**Spec:** `docs/superpowers/specs/2026-06-23-step-nav-codecheck-branch-indicators-design.md`
**Branch:** `feat/step-nav-codecheck-branch-indicators` (already created; spec already committed)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `hugo/assets/css/sap-fundamental.css` | **Modify** lines 988-1006 (`.step-toc-quiz-dot` rule from PR #568) | Replace single-purpose `.step-toc-quiz-dot` with the generic `.step-badge` + 3 modifier rules + `.step-badge-row` wrapper + desktop/mobile positioning rules. |
| `hugo/layouts/partials/tutorial-sidebar.html` | **Modify** lines 6, 8 | Replace single `{{ with .validation }}` block on line 8 with 3-condition badge row inside `.step-toc-circle`. Update `data-has-quiz` attribute on line 6 (keep as-is — it's only set when `.validation` is truthy; nothing else uses it, but PR #568 added it as a CSS hook). |
| `hugo/layouts/tutorials/u1-object-page.html` | **Modify** line 408 | Drop `additional-text="Question"` + `additional-text-state="Positive"`. Prepend `<span class="step-badge-row" aria-hidden="true">…</span>` into `ui5-li` default slot. |
| `test/hugo-step-badges.test.js` | **Create** | Vitest source-string tests against the partial, the u1-object-page template, and the CSS file — assert all three modifier classes are defined, all three template guards are present, mobile path no longer carries `additional-text="Question"`. |
| `docs/superpowers/plans/2026-06-23-step-nav-codecheck-branch-indicators.md` | **(this file)** | The plan itself. |

**Test location decision:** `test/hugo-step-badges.test.js` lives directly under `test/` to match the existing convention (e.g. `test/admin-service.test.js`, `test/build-catalog-groups.test.js`). The unit project's `include` pattern in [vitest.config.ts](../../../vitest.config.ts) globs `test/**/*.test.{js,ts}` — verified.

**Test approach decision:** Source-string assertions only. Reading the partial/template/CSS files as strings with `fs.readFileSync` and asserting key substrings/regex matches. We do **not** stand up a Hugo render harness (no precedent in the repo; overkill for ~150 lines of HTML+CSS). The trade-off: a templating typo that compiles in Hugo but produces wrong output is not caught by the test. Mitigation: manual visual-smoke check in the local dev server, documented in the spec test plan #5.

---

## Constraint: Glyph SVG paths (use verbatim — already extracted from @ui5/webcomponents-icons v5)

The three glyph paths below were copied from `node_modules/@ui5/webcomponents-icons/dist/v5/{question-mark,source-code,decision}.js` at design time. Use these exact strings. All three are `viewBox="0 0 16 16"`. Wrap each in single-quoted-attribute SVG to avoid escaping inside the `data:` URI.

**question-mark** (quiz):
```
M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm0 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 11a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm0-8a2.99 2.99 0 0 1 .75 5.884v.366a.75.75 0 0 1-1.5 0V8.231c0-.547.407-.716.904-.757.498-.042 1.346-.54 1.346-1.483A1.49 1.49 0 0 0 8 4.5c-.883 0-1.414.582-1.504 1.567A.75.75 0 0 1 5 5.991 2.99 2.99 0 0 1 8 3Z
```

**source-code** (codecheck):
```
M3.742 4.2a.75.75 0 0 1 1.02 1.1L1.853 7.997l2.91 2.704a.75.75 0 0 1-1.022 1.1L.239 8.546A.757.757 0 0 1 .24 7.45L3.742 4.2Zm7.463.04a.75.75 0 0 1 1.06-.04l3.502 3.249a.757.757 0 0 1 0 1.098l-3.5 3.253a.752.752 0 0 1-1.023-1.1l2.91-2.703L11.245 5.3a.75.75 0 0 1-.04-1.06Z
```

**decision** (branch):
```
M12.821 3.999c.492.4 1.045.991 1.145 1.647.176 1.16-.256 2.314-1.03 3.172a5.2 5.2 0 0 1-.536.511c.665.77.775 1.812.115 2.647a1.943 1.943 0 0 1-1.89.698 1.5 1.5 0 0 1-.524.763h.001c-.45.381-1.033.57-1.617.462-.264.613-.86.974-1.51 1.077a1.799 1.799 0 0 1-1.593-.522l-.012-.012-3.445-3.6C1.325 10.174 1 9.275 1 8.322c0-1.05.379-1.853 1.024-2.625l.828-.908A.75.75 0 0 1 3.961 5.8l-.828.909C2.72 7.188 2.5 7.77 2.5 8.322c0 .659.238 1.219.608 1.59l.012.01 3.323 3.473c.287.289.857.083.66-.34-.189-.313-.1-.8.17-1.007.314-.242.752-.222 1.012.077.153.175.312.306.565.306.283 0 .425-.364.239-.55a.75.75 0 0 1 .945-1.155l.455.302c.258.162.597.277.85.017.142-.146.202-.42.06-.582-.682-.776-1.392-1.522-2.101-2.272l-.598.961-.013.02a1.753 1.753 0 0 1-1.452.778h-.869a.75.75 0 0 1-.75-.75V6.213c0-1.28.878-2.373 2.106-2.676l2.18-.531c1.01-.122 2.153.368 2.92.993Zm-4.74.994c-.57.141-.965.643-.965 1.22V8.45c.122 0 .247.005.323-.11l1.148-1.837a.758.758 0 0 1 1.132-.049l1.67 1.765c.137-.11.288-.245.433-.406.437-.483.981-1.504.54-2.134-.513-.734-1.41-1.155-2.293-1.176l-1.988.49ZM2.22 1.22a.75.75 0 1 1 1.06 1.06l-2 2A.75.75 0 0 1 .22 3.22l2-2Zm10.5 0a.75.75 0 0 1 1.06 0l2 2a.75.75 0 1 1-1.06 1.06l-2-2a.75.75 0 0 1 0-1.06Z
```

> **Why CSS mask + currentColor + data-URI:** decouples color from glyph (one path, three tints); avoids upgrading ~50 `<ui5-icon>` Web Components per long TOC; no extra HTTP request for the glyph asset. Confirmed in spec section "Visual design — Badge specification."

---

## Task 1: Sanity-check the branch & current working tree

**Files:** none (verification only)

- [ ] **Step 1: Confirm branch and clean tree**

```bash
git branch --show-current
git status --short
```

Expected output:
- branch: `feat/step-nav-codecheck-branch-indicators`
- status: shows only the spec file already committed plus possibly the plan file in flight (no other staged/unstaged changes to the source files we'll touch). If unrelated changes are present, stash them before starting.

- [ ] **Step 2: Confirm the spec is committed and readable**

```bash
git log --oneline -3 -- docs/superpowers/specs/2026-06-23-step-nav-codecheck-branch-indicators-design.md
```

Expected: at least one commit touching the spec file.

---

## Task 2: Write the failing test file

**Files:**
- Create: `test/hugo-step-badges.test.js`

The test file goes in **first**, with failing assertions that drive the implementation. Source-string assertions only — see "Test approach decision" above.

- [ ] **Step 1: Write the test file**

```javascript
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
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npx vitest run test/hugo-step-badges.test.js
```

Expected: all tests fail. The CSS file has `.step-toc-quiz-dot` (which our new tests assert is gone) and lacks `.step-badge*`; the partial uses `.step-toc-quiz-dot` not the new classes; the u1 template still has `additional-text="Question"`. This is the red phase.

- [ ] **Step 3: Commit the failing test**

```bash
git add test/hugo-step-badges.test.js
git commit -m "test(steps): failing source-string assertions for codecheck+branch badges"
```

---

## Task 3: CSS — replace `.step-toc-quiz-dot` with the generic badge system

**Files:**
- Modify: `hugo/assets/css/sap-fundamental.css` lines 988-1006 (the PR #568 `.step-toc-quiz-dot` rule block)

- [ ] **Step 1: Replace the PR #568 block with the generic badge system**

Locate lines 988-1006 (the `/* Issue #568: notification-style dot ... */` comment through the closing `}` of `.step-toc-quiz-dot`). Replace that entire block with:

```css
/* Issue #568 (extended): step-nav indicator badges. Three slot indicators
   (quiz, codecheck, branch) sharing one visual treatment so a user can scan
   the step TOC and tell at a glance which steps demand which kind of work.
   See docs/superpowers/specs/2026-06-23-step-nav-codecheck-branch-indicators-design.md.

   Each badge is a 14px-outer circle (11px inner color + 1.5px background-colored
   border so the badge stays legible when overlapping an .active (blue-filled)
   or .completed (green-filled) circle). The glyph is rendered via CSS
   `mask-image` with `background-color: currentColor`, so each modifier only
   needs to override `color:` and `--mask-image:`. */

.step-badge-row {
  display: inline-flex;
  flex-direction: row-reverse; /* rightmost slot fills first; cluster anchors right edge */
  pointer-events: none;
}

/* Desktop right-column TOC: float over the bubble's top-right corner. */
.step-toc-circle .step-badge-row {
  position: absolute;
  top: -4px;
  right: -4px;
}

/* Mobile step-sheet: sit inline before the step number text. */
ui5-li .step-badge-row {
  vertical-align: middle;
  margin-right: 6px;
}

.step-badge {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.5px solid var(--sapList_Background, var(--sapBackgroundColor, #fff));
  background-color: currentColor;
  -webkit-mask-position: center;
          mask-position: center;
  -webkit-mask-repeat: no-repeat;
          mask-repeat: no-repeat;
  -webkit-mask-size: 9px 9px;
          mask-size: 9px 9px;
  margin-left: -3px; /* overlap previous sibling in the row */
  box-sizing: content-box;
  flex: 0 0 auto;
}
.step-badge:last-child { margin-left: 0; } /* leftmost-in-row-reverse has no overlap */

/* question-mark (SAP-icons-v5) — copied verbatim from
   @ui5/webcomponents-icons/dist/v5/question-mark.js */
.step-badge--quiz {
  color: var(--sapPositiveColor, #30914c);
  -webkit-mask-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm0 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 11a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm0-8a2.99 2.99 0 0 1 .75 5.884v.366a.75.75 0 0 1-1.5 0V8.231c0-.547.407-.716.904-.757.498-.042 1.346-.54 1.346-1.483A1.49 1.49 0 0 0 8 4.5c-.883 0-1.414.582-1.504 1.567A.75.75 0 0 1 5 5.991 2.99 2.99 0 0 1 8 3Z'/></svg>");
          mask-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm0 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 11a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm0-8a2.99 2.99 0 0 1 .75 5.884v.366a.75.75 0 0 1-1.5 0V8.231c0-.547.407-.716.904-.757.498-.042 1.346-.54 1.346-1.483A1.49 1.49 0 0 0 8 4.5c-.883 0-1.414.582-1.504 1.567A.75.75 0 0 1 5 5.991 2.99 2.99 0 0 1 8 3Z'/></svg>");
}

/* source-code (SAP-icons-v5) — copied verbatim from
   @ui5/webcomponents-icons/dist/v5/source-code.js */
.step-badge--codecheck {
  color: var(--sapInformativeColor, #0070f2);
  -webkit-mask-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M3.742 4.2a.75.75 0 0 1 1.02 1.1L1.853 7.997l2.91 2.704a.75.75 0 0 1-1.022 1.1L.239 8.546A.757.757 0 0 1 .24 7.45L3.742 4.2Zm7.463.04a.75.75 0 0 1 1.06-.04l3.502 3.249a.757.757 0 0 1 0 1.098l-3.5 3.253a.752.752 0 0 1-1.023-1.1l2.91-2.703L11.245 5.3a.75.75 0 0 1-.04-1.06Z'/></svg>");
          mask-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M3.742 4.2a.75.75 0 0 1 1.02 1.1L1.853 7.997l2.91 2.704a.75.75 0 0 1-1.022 1.1L.239 8.546A.757.757 0 0 1 .24 7.45L3.742 4.2Zm7.463.04a.75.75 0 0 1 1.06-.04l3.502 3.249a.757.757 0 0 1 0 1.098l-3.5 3.253a.752.752 0 0 1-1.023-1.1l2.91-2.703L11.245 5.3a.75.75 0 0 1-.04-1.06Z'/></svg>");
}

/* decision (SAP-icons-v5) — copied verbatim from
   @ui5/webcomponents-icons/dist/v5/decision.js */
.step-badge--branch {
  color: var(--sapAccentColor6, #df9941);
  -webkit-mask-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M12.821 3.999c.492.4 1.045.991 1.145 1.647.176 1.16-.256 2.314-1.03 3.172a5.2 5.2 0 0 1-.536.511c.665.77.775 1.812.115 2.647a1.943 1.943 0 0 1-1.89.698 1.5 1.5 0 0 1-.524.763h.001c-.45.381-1.033.57-1.617.462-.264.613-.86.974-1.51 1.077a1.799 1.799 0 0 1-1.593-.522l-.012-.012-3.445-3.6C1.325 10.174 1 9.275 1 8.322c0-1.05.379-1.853 1.024-2.625l.828-.908A.75.75 0 0 1 3.961 5.8l-.828.909C2.72 7.188 2.5 7.77 2.5 8.322c0 .659.238 1.219.608 1.59l.012.01 3.323 3.473c.287.289.857.083.66-.34-.189-.313-.1-.8.17-1.007.314-.242.752-.222 1.012.077.153.175.312.306.565.306.283 0 .425-.364.239-.55a.75.75 0 0 1 .945-1.155l.455.302c.258.162.597.277.85.017.142-.146.202-.42.06-.582-.682-.776-1.392-1.522-2.101-2.272l-.598.961-.013.02a1.753 1.753 0 0 1-1.452.778h-.869a.75.75 0 0 1-.75-.75V6.213c0-1.28.878-2.373 2.106-2.676l2.18-.531c1.01-.122 2.153.368 2.92.993Zm-4.74.994c-.57.141-.965.643-.965 1.22V8.45c.122 0 .247.005.323-.11l1.148-1.837a.758.758 0 0 1 1.132-.049l1.67 1.765c.137-.11.288-.245.433-.406.437-.483.981-1.504.54-2.134-.513-.734-1.41-1.155-2.293-1.176l-1.988.49ZM2.22 1.22a.75.75 0 1 1 1.06 1.06l-2 2A.75.75 0 0 1 .22 3.22l2-2Zm10.5 0a.75.75 0 0 1 1.06 0l2 2a.75.75 0 1 1-1.06 1.06l-2-2a.75.75 0 0 1 0-1.06Z'/></svg>");
          mask-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M12.821 3.999c.492.4 1.045.991 1.145 1.647.176 1.16-.256 2.314-1.03 3.172a5.2 5.2 0 0 1-.536.511c.665.77.775 1.812.115 2.647a1.943 1.943 0 0 1-1.89.698 1.5 1.5 0 0 1-.524.763h.001c-.45.381-1.033.57-1.617.462-.264.613-.86.974-1.51 1.077a1.799 1.799 0 0 1-1.593-.522l-.012-.012-3.445-3.6C1.325 10.174 1 9.275 1 8.322c0-1.05.379-1.853 1.024-2.625l.828-.908A.75.75 0 0 1 3.961 5.8l-.828.909C2.72 7.188 2.5 7.77 2.5 8.322c0 .659.238 1.219.608 1.59l.012.01 3.323 3.473c.287.289.857.083.66-.34-.189-.313-.1-.8.17-1.007.314-.242.752-.222 1.012.077.153.175.312.306.565.306.283 0 .425-.364.239-.55a.75.75 0 0 1 .945-1.155l.455.302c.258.162.597.277.85.017.142-.146.202-.42.06-.582-.682-.776-1.392-1.522-2.101-2.272l-.598.961-.013.02a1.753 1.753 0 0 1-1.452.778h-.869a.75.75 0 0 1-.75-.75V6.213c0-1.28.878-2.373 2.106-2.676l2.18-.531c1.01-.122 2.153.368 2.92.993Zm-4.74.994c-.57.141-.965.643-.965 1.22V8.45c.122 0 .247.005.323-.11l1.148-1.837a.758.758 0 0 1 1.132-.049l1.67 1.765c.137-.11.288-.245.433-.406.437-.483.981-1.504.54-2.134-.513-.734-1.41-1.155-2.293-1.176l-1.988.49ZM2.22 1.22a.75.75 0 1 1 1.06 1.06l-2 2A.75.75 0 0 1 .22 3.22l2-2Zm10.5 0a.75.75 0 0 1 1.06 0l2 2a.75.75 0 1 1-1.06 1.06l-2-2a.75.75 0 0 1 0-1.06Z'/></svg>");
}
```

> **Note on rendered badge size:** 11px content + 1.5px border × 2 = 14px outer. Spec says "14px outer." Matches.

> **Why `margin-left: -3px` on `.step-badge` and `margin-left: 0` on `:last-child`:** with `flex-direction: row-reverse`, the **last** DOM child is visually leftmost. We want the leftmost-visual badge to NOT overlap anything (there's nothing to its left), so `:last-child` resets the negative margin. The 2-badge and 3-badge cases get one and two `-3px` overlaps respectively. Verified math from the spec stacking section: 14px × 3 − (3px × 2) = 36px cluster.

- [ ] **Step 2: Verify CSS tests now pass (template tests still fail)**

```bash
npx vitest run test/hugo-step-badges.test.js
```

Expected: the 7 CSS describe-block tests all PASS. The template describe-blocks for sidebar and u1-object-page still FAIL (template work hasn't happened yet).

- [ ] **Step 3: Commit**

```bash
git add hugo/assets/css/sap-fundamental.css
git commit -m "feat(steps): generic step-badge CSS with quiz/codecheck/branch modifiers"
```

---

## Task 4: Hugo desktop sidebar — replace single `{{ with .validation }}` with 3-condition badge row

**Files:**
- Modify: `hugo/layouts/partials/tutorial-sidebar.html` lines 6 and 8

- [ ] **Step 1: Update the partial**

Replace line 8:

```html
          <span class="step-toc-circle">{{ .number }}{{ with .validation }}<span class="step-toc-quiz-dot" aria-label="This step has a question" title="This step has a question"></span>{{ end }}</span>
```

with:

```html
          <span class="step-toc-circle">{{ .number }}{{ if or .validation .codeCheck .branchGroup }}<span class="step-badge-row">{{ with .branchGroup }}<span class="step-badge step-badge--branch" title="This step has a branch point"></span>{{ end }}{{ with .codeCheck }}<span class="step-badge step-badge--codecheck" title="This step has a code check"></span>{{ end }}{{ with .validation }}<span class="step-badge step-badge--quiz" title="This step has a question"></span>{{ end }}</span>{{ end }}</span>
```

> **DOM order is `branch → codecheck → quiz` on purpose.** Under `flex-direction: row-reverse`, the first DOM child renders rightmost. So this DOM ordering produces visual left-to-right `quiz, codecheck, branch` — the order the spec mandates ("Order of slots (left-to-right when all three present): **quiz, codecheck, branch**"). Tests in Task 2 lock this order with `expect(...).toMatch(/step-badge--branch[\s\S]*?step-badge--codecheck[\s\S]*?step-badge--quiz/)`.

Also update line 6 to drop the obsolete `data-has-quiz` attribute (PR #568 added it but no CSS or JS consumes it; verify nothing else uses it before deleting):

```bash
# Broad grep — no path filter; covers test/, docs/, hugo-apps/, and anything else.
git grep -n "data-has-quiz"
```

If grep returns no consumers (only the partial itself), replace line 6 from:

```html
      <li class="step-toc-item" data-toc-step="{{ .number }}"{{ with .validation }} data-has-quiz="true"{{ end }}>
```

to:

```html
      <li class="step-toc-item" data-toc-step="{{ .number }}">
```

> If grep finds a consumer (anywhere), **keep `data-has-quiz`** as-is on line 6 (don't break a CSS hook we missed). Add a follow-up note to the PR description.

- [ ] **Step 2: Verify desktop sidebar tests now pass**

```bash
npx vitest run test/hugo-step-badges.test.js
```

Expected: 7 CSS tests + 4 sidebar tests all PASS. The 3 u1-object-page tests still FAIL.

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/partials/tutorial-sidebar.html
git commit -m "feat(steps): badge row in desktop step-toc with 3 indicator slots"
```

---

## Task 5: Hugo mobile step-sheet — replace `additional-text` with inline badges

**Files:**
- Modify: `hugo/layouts/tutorials/u1-object-page.html` line 408

- [ ] **Step 1: Update the `ui5-li`**

Replace line 408:

```html
      <ui5-li data-step-number="{{ .number }}" data-step-target="step-{{ .number }}" type="Active" icon=""{{ with .validation }} additional-text="Question" additional-text-state="Positive"{{ end }}>{{ .number }}. {{ .title }}</ui5-li>
```

with:

```html
      <ui5-li data-step-number="{{ .number }}" data-step-target="step-{{ .number }}" type="Active" icon="">{{ if or .validation .codeCheck .branchGroup }}<span class="step-badge-row" aria-hidden="true">{{ with .branchGroup }}<span class="step-badge step-badge--branch" title="This step has a branch point"></span>{{ end }}{{ with .codeCheck }}<span class="step-badge step-badge--codecheck" title="This step has a code check"></span>{{ end }}{{ with .validation }}<span class="step-badge step-badge--quiz" title="This step has a question"></span>{{ end }}</span>{{ end }}{{ .number }}. {{ .title }}</ui5-li>
```

> **DOM order matches desktop** (`branch → codecheck → quiz`) so the same `flex-direction: row-reverse` produces the same visual left-to-right `quiz, codecheck, branch` on both surfaces. See Task 4 note.

> **Why `aria-hidden="true"` on mobile but not desktop:** the `ui5-li` already announces its visible text content (the step title) to screen readers; the badges' per-element `title` attributes would double-announce. On desktop the `<a>` ancestor announces the step title via `.step-toc-text`, and the per-badge `title`s serve as decorative-supplementary. Spec accessibility section.

- [ ] **Step 2: Verify all tests now pass**

```bash
npx vitest run test/hugo-step-badges.test.js
```

Expected: all 14 tests PASS (7 CSS + 4 sidebar + 3 u1-object-page).

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/tutorials/u1-object-page.html
git commit -m "feat(steps): badge row in mobile step-sheet, drop additional-text"
```

---

## Task 6: Run full unit suite to confirm no regressions

**Files:** none (verification)

- [ ] **Step 1: Run the unit project**

```bash
npm test -- --project unit
```

Expected: all tests pass, including the new `test/hugo-step-badges.test.js`. If anything else breaks, stop and investigate — we did not change any code outside of CSS + 2 Hugo templates + the new test file, so unrelated failures are environmental, not from this change.

- [ ] **Step 2: If full suite is slow, smoke just adjacent areas**

```bash
npx vitest run test/hugo-step-badges.test.js test/admin-service.test.js
```

(Adjacent test picked at random — just confirms vitest itself is healthy.)

---

## Task 7: Manual visual-smoke check

**Files:** none (visual verification)

The source-string tests can't see whether the SVG masks actually render. A 5-minute eyeball check covers that gap.

- [ ] **Step 1: Build Hugo and serve locally**

```bash
npm run fetch-tutorials   # if .tutorial-cache/ is empty
npm run dev
```

Open <http://localhost:1313/tutorials/> and pick a tutorial. The right-column TOC's step bubbles should show:
- A green `?` badge on steps with `[VALIDATE_N]` blocks
- A blue `</>` badge on steps with `[CODECHECK_N]` blocks
- An orange fork badge on steps with `[BRANCH_N]` blocks
- Stacked badges (cluster anchored to bubble top-right) when a step has 2 or 3 of them

- [ ] **Step 2: Find or author a tutorial with all three indicator types**

If no tutorial in the cache has all three on the same step, search for candidates:

```bash
grep -rln "\[VALIDATE_" .tutorial-cache | head -5
grep -rln "\[CODECHECK_" .tutorial-cache | head -5
grep -rln "\[BRANCH_" .tutorial-cache | head -5
```

If no single step exercises all three, that's OK — the test plan's manual check accepts a multi-tutorial sweep. Document the tutorial slug(s) and step number(s) you used in the PR description so reviewers can repro.

- [ ] **Step 3: Mobile path — resize browser to ≤ 768px width**

The bottom step-sheet on Object Page mobile only triggers below the mobile breakpoint. Resize the browser and tap the floating step-list button; verify the `ui5-li` items show the inline badges before the step number text and that `additional-text` is gone (no right-aligned "Question" label).

- [ ] **Step 4: Dark mode**

Toggle the OS theme (or use the admin shell's theme switcher if you're hitting `/admin-ui/`; the Hugo public site auto-detects). Verify the badge colors stay legible against the dark `.step-toc-circle` and that the badge borders blend into the surrounding background as designed.

- [ ] **Step 5: If the eyeball check fails for any reason**

- Mask not rendering (badges show as solid colored circles) → check browser DevTools console for a CSS parser error. Most likely cause: a stray `"` or `#` in the SVG path broke the `data:` URI. Fix by re-extracting the path verbatim from `node_modules/@ui5/webcomponents-icons/dist/v5/<name>.js`.
- Cluster overflowing or misaligned → check the `flex-direction: row-reverse` and the `:last-child { margin-left: 0 }` rule are in place.
- Mobile badges pushing the title to a second line → adjust `.step-badge-row`'s `display`/`vertical-align` rule; should be `inline-flex` + `vertical-align: middle`.

- [ ] **Step 6: Capture a screenshot for the PR**

Take a screenshot of the desktop sidebar showing all three badge types and attach it to the PR description.

---

## Task 8: Open the PR

**Files:** none (publishing)

- [ ] **Step 1: Push the branch and open the PR**

```bash
git push -u origin feat/step-nav-codecheck-branch-indicators
gh pr create \
  --base main \
  --title "feat(steps): codecheck + branch indicators in step navigation" \
  --body "$(cat <<'EOF'
Extends PR #568's quiz-dot skeleton to three step-nav indicator slots:

- Quiz (green, `?` glyph) — steps with `[VALIDATE_N]`
- Codecheck (blue, `</>` glyph) — steps with `[CODECHECK_N]`
- Branch (orange, fork glyph) — steps with `[BRANCH_N]`

Quiz indicator from #568 is retrofitted to share the new badge+glyph treatment so all three slots look like one system. Mobile step-sheet gains visual parity with desktop (inline badges replace `additional-text="Question"`).

Spec: `docs/superpowers/specs/2026-06-23-step-nav-codecheck-branch-indicators-design.md`

Build-time-static change. No parser, schema, API, or runtime JS changes.

## Manual smoke

- Desktop sidebar: <screenshot>
- Mobile bottom-sheet: <screenshot, ≤768px width>
- Tutorial slug(s) used for the smoke: `<slug-1>`, `<slug-2>`
- Dark mode: ✅ verified

## Tests

`test/hugo-step-badges.test.js` adds 14 source-string assertions against the partial, the u1-object-page template, and the CSS file. (Source-string only — no Hugo render harness; project gotcha about Vitest stubbing imported CSS in jsdom documented in test header comment.)

Closes <follow-up issue if filed; else leave blank>
EOF
)"
```

> If no issue is filed for this work, that's fine — the spec doc + PR are the only paper trail required.

- [ ] **Step 2: Confirm CI passes**

Wait for the deploy.yml / unit-test workflows to run on the PR. If anything red comes back that's unrelated to this change (flaky test, network blip), retry; if anything related fails, fix and push.

---

## Out-of-scope items / explicit non-goals

These were considered and rejected during brainstorming. Do not add them to this PR:

- Gating the codecheck badge on `ChatSettings.codeCheckEnabled`. The flag isn't available in Hugo's build context, and the spec deliberately advertises the *opportunity* even when the runtime UI is disabled.
- A count chip ("3 questions"). "≥1 present" is the only state; symmetric with PR #568.
- Per-indicator counts ("2 codechecks"). Same — single badge per slot.
- Below-bubble layout. Rejected during brainstorming (Question 5 answer A): right-stacked overlapping cluster wins on vertical density.
- Adding a parser change. Frontmatter fields are already emitted by `scripts/parsers/render-frontmatter.ts:79-89`.

---

## Rollback

Single `git revert` of the merged PR. No data migration, no schema change, no API change. Tutorials republish on the next `rebuild-content` run with the reverted templates baked in.
