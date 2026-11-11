# Concept / topic / channel page layout fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix flush-left rendering on four CAP/Hugo page types and cap the hundreds-of-tiles relationship walls on concept hub pages (issue #3095).

**Architecture:** Two independent changes. (A) One grouped CSS base rule (desktop + mobile media query) in the git-tracked CSS *source*, giving `.concept-page`, `.topic-detail`, `.channel-detail`, `.channels-page` the site-standard 1280px/centered/padded container. (B) An EJS change in `concept-detail.ejs` that moves KG-relationship tile overflow (past N) into a no-JS `<details>` collapse.

**Tech Stack:** CSS (`hugo/assets/css/sap-fundamental.src.css`, compiled by postcss `build:css`), EJS (`srv/lib/templates/concept-detail.ejs` via `srv/lib/concept-detail-render.js`), vitest unit tests.

**Spec:** `docs/superpowers/specs/2026-11-11-concept-page-layout-design.md`

## Global Constraints

- **CSS edits go ONLY in `hugo/assets/css/sap-fundamental.src.css`** (git-tracked source). NEVER edit `hugo/assets/css/sap-fundamental.css` (gitignored build output since #2896; editing it causes Hugo-fingerprint drift → blocked publish).
- **Container values copied verbatim from the sibling rule:** desktop `max-width: 1280px; margin: 0 auto; padding: 1.5rem 2rem 3rem;` (`src.css:2402-2407`); mobile `padding: 1rem;` inside the existing `@media` block (`src.css:2774-2777`).
- **No new global container class and no `main { … }` rule** — scope strictly to the four named root classes.
- **Cap mechanism is CSS-only `<details>`/`<summary>`** — no island, no JS, overflow moved server-side (not hidden client-side).
- **Cap scope = KG-relationship sections only** (`teaches`, `requires`, `requiredBy`, `relatedTo`); leave phase-4 external sections (learningJourneys, helpDocs, blogPosts, discoveryMissions, videos, apiDocs, samples, communityEvents) uncapped — corpus data shows only these grow unbounded.
- **Cap threshold N = 24.**
- **Test runner:** `npx vitest run --project unit <file>` (scoped — full suite is hook-blocked locally).
- **Windows worktree:** CSS/EJS files are LF. After edits run `file <path>`; if it flips to CRLF, normalize before commit.
- **Activation is two-step:** the CSS fix (Task 1) activates on deploy; the EJS cap (Task 2) changes body bytes → needs a concepts re-publish after deploy. Note this in the PR body. One PR.

## Review Focus

- **Concept with zero `requiredBy` but non-empty other sections** — the cap helper must still render normal sections untouched and emit no empty `<details>`. Covered in Task 2 tests.
- **`requiredBy.length` exactly === N (24)** — boundary: no `<details>` should appear (nothing overflows). Covered in Task 2 tests.
- **`requiredBy.length` === N+1 (25)** — boundary: exactly one item inside `<details>`, summary count correct. Covered in Task 2 tests.
- **Title values needing HTML-escape inside the collapsed overflow** — escaping must hold for items rendered in the `<details>` half, not just the visible half. Covered in Task 2 tests.
- **Concept index / topic index already-padded pages** — the new grouped rule must not double-apply to `.concepts-index`/`.topics-index` (different classes; verify by inspection that the selector list contains only the four intended classes). Covered in Task 1 review.

---

## Task 1: Container base rule for the four flush-left roots (CSS)

**Files:**
- Modify: `hugo/assets/css/sap-fundamental.src.css` (add desktop rule near `:3069` `.concept-page__*` block; add the four classes to the mobile `@media` block at `:2774-2777`)
- Test: `test/concept-page-container.test.js` (create — source-string guard, same style as `test/hugo-css-fingerprint.test.js`)

**Interfaces:**
- Produces: CSS classes `.concept-page`, `.topic-detail`, `.channel-detail`, `.channels-page` each resolving to `max-width:1280px; margin:0 auto; padding:1.5rem 2rem 3rem` on desktop and `padding:1rem` under the mobile media query. No JS/HTML interface.

- [ ] **Step 1: Write the failing test**

Create `test/concept-page-container.test.js` (vitest, source-string guard — reads `sap-fundamental.src.css` as text, mirroring `hugo-css-fingerprint.test.js`):

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const src = readFileSync(join(import.meta.dirname, '..', 'hugo/assets/css/sap-fundamental.src.css'), 'utf8');

describe('#3095 — concept/topic/channel container base rule', () => {
  const ROOTS = ['.concept-page', '.topic-detail', '.channel-detail', '.channels-page'];
  it('declares a desktop container rule with 1280px/centered/padded for all four roots', () => {
    // one grouped rule block containing all four selectors + the sibling values
    const rule = src.match(/\.concept-page,\s*\.topic-detail,\s*\.channel-detail,\s*\.channels-page\s*\{[^}]*\}/);
    expect(rule, 'grouped base rule present').not.toBeNull();
    expect(rule[0]).toMatch(/max-width:\s*1280px/);
    expect(rule[0]).toMatch(/margin:\s*0 auto/);
    expect(rule[0]).toMatch(/padding:\s*1\.5rem 2rem 3rem/);
  });
  it('adds the four roots to the mobile padding override', () => {
    // the four classes appear alongside .group-body inside a rule setting padding:1rem
    for (const r of ROOTS) {
      expect(src, `${r} in a 1rem padding rule`).toMatch(
        new RegExp(`${r.replace('.', '\\.')}[\\s\\S]{0,400}padding:\\s*1rem`)
      );
    }
  });
  it('does NOT introduce a bare `main {` width rule or touch the index classes', () => {
    expect(src).not.toMatch(/\.concept-page,\s*\.topic-detail,\s*\.channel-detail,\s*\.channels-page,\s*\.concepts-index/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/concept-page-container.test.js`
Expected: FAIL (no grouped rule yet).

- [ ] **Step 3: Add the CSS rules in `sap-fundamental.src.css`**

Desktop: insert a grouped rule immediately before the first `.concept-page__*` rule (≈`:3069`):
```css
.concept-page,
.topic-detail,
.channel-detail,
.channels-page {
  max-width: 1280px;
  margin: 0 auto;
  padding: 1.5rem 2rem 3rem;
}
```
Mobile: in the existing `@media` block containing `.mission-body, .group-body { padding: 1rem; }` (`:2774-2777`), add the four selectors to that same declaration (or a sibling declaration in the same media block) so they also get `padding: 1rem`.

- [ ] **Step 4: Run the test + verify CSS still compiles**

Run: `npx vitest run --project unit test/concept-page-container.test.js`
Expected: PASS.
Run: `npm run build:css`
Expected: exits 0, regenerates `sap-fundamental.css` (gitignored — do not stage it).

- [ ] **Step 5: Verify line endings, then commit**

Run: `file hugo/assets/css/sap-fundamental.src.css test/concept-page-container.test.js` (expect "ASCII text", not "CRLF"); normalize if flipped.
```bash
git add hugo/assets/css/sap-fundamental.src.css test/concept-page-container.test.js
git commit -m "fix(#3095): add 1280px container base rule for concept/topic/channel/channels page roots"
```

---

## Task 2: Cap KG-relationship tile walls with a no-JS `<details>` collapse (EJS)

**Files:**
- Modify: `srv/lib/concept-detail-render.js` (add a cap helper into the template context)
- Modify: `srv/lib/templates/concept-detail.ejs` (render the four KG sections' `<ul>` via the helper)
- Test: `test/concept-detail-cap.test.js` (create)

**Interfaces:**
- Consumes: `renderConceptDetail(concept, phase4)` from `srv/lib/concept-detail-render.js:52` → returns `{ body, contentHash }`.
- Produces: a template-context helper `renderCappedGrid(items, renderItem, { visible = 24, label })` → string of `<ul class="concept-card-grid">` markup where the first `visible` items are direct `<li>` children and any overflow is wrapped in `<details class="concept-card-grid__more"><summary>Show all <N> …</summary><ul class="concept-card-grid">…rest…</ul></details>`. `renderItem(item)` returns the `<li>…</li>` for one item (reuses the existing per-section markup). When `items.length <= visible`, no `<details>` is emitted.

- [ ] **Step 1: Write the failing tests**

Create `test/concept-detail-cap.test.js` (vitest). Build a concept with N-boundary `requiredBy` arrays and assert on the returned `body` string:

```js
import { describe, it, expect } from 'vitest';
import { renderConceptDetail } from '../srv/lib/concept-detail-render.js';
const mk = (n) => Array.from({ length: n }, (_, i) => ({ slug: `c${i}`, title: `Concept ${i}` }));
const base = { slug: 'x', name: 'X', description: '' };

describe('#3095 — KG relationship cap', () => {
  it('no <details> when requiredBy.length === 24 (boundary)', () => {
    const { body } = renderConceptDetail({ ...base, requiredBy: mk(24) }, {});
    const sec = body.match(/Concepts that build on this[\s\S]*?<\/section>/)[0];
    expect(sec).not.toMatch(/<details/);
    expect((sec.match(/<li>/g) || []).length).toBe(24);
  });
  it('one item inside <details> when requiredBy.length === 25 (boundary)', () => {
    const { body } = renderConceptDetail({ ...base, requiredBy: mk(25) }, {});
    const sec = body.match(/Concepts that build on this[\s\S]*?<\/section>/)[0];
    expect(sec).toMatch(/<details/);
    const inside = sec.match(/<details[\s\S]*?<\/details>/)[0];
    expect((inside.match(/<li>/g) || []).length).toBe(1);
    expect(sec).toMatch(/Show all 25/);
  });
  it('235-item hub collapses overflow (24 visible, 211 in details)', () => {
    const { body } = renderConceptDetail({ ...base, requiredBy: mk(235) }, {});
    const sec = body.match(/Concepts that build on this[\s\S]*?<\/section>/)[0];
    const inside = sec.match(/<details[\s\S]*?<\/details>/)[0];
    expect((inside.match(/<li>/g) || []).length).toBe(211);
  });
  it('escapes titles rendered inside the collapsed overflow half', () => {
    const items = mk(25); items[24].title = '<script>x</script>';
    const { body } = renderConceptDetail({ ...base, requiredBy: items }, {});
    expect(body).not.toMatch(/<script>x<\/script>/);
    expect(body).toMatch(/&lt;script&gt;/);
  });
  it('leaves an uncapped external section (phase4) untouched', () => {
    const { body } = renderConceptDetail(
      { ...base }, { videos: mk(30).map(v => ({ ...v, url: 'https://x' })) });
    const sec = body.match(/Videos teaching this[\s\S]*?<\/section>/);
    if (sec) expect(sec[0]).not.toMatch(/<details/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit test/concept-detail-cap.test.js`
Expected: FAIL (no cap yet; 235 renders 235 `<li>`, no `<details>`).

- [ ] **Step 3: Implement the cap helper in `concept-detail-render.js`**

Add `renderCappedGrid(items, renderItem, { visible = 24, label })` (signature in Interfaces) and inject it into `ctx` alongside `escapeHtml`/`renderMarkdown`. First `visible` items render as direct `<li>` inside `<ul class="concept-card-grid">`; overflow goes in `<details class="concept-card-grid__more"><summary>Show all <%= items.length %> <%= label %></summary><ul class="concept-card-grid">…</ul></details>`. `renderItem` is the existing per-item `<li>` markup for that section (escaping via the existing `escapeHtml`/`<%= %>` path).

- [ ] **Step 4: Rewire the four KG sections in `concept-detail.ejs`**

Replace the bare `<ul class="concept-card-grid"><% arr.forEach(… ) %></ul>` in the `teaches`, `requires`, `requiredBy`, `relatedTo` sections with a call to `renderCappedGrid(arr, itemFn, { label: '<section noun>' })`. Leave all phase-4 external sections exactly as they are. Keep each section's existing `<li>` inner markup identical (move it into the `itemFn`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project unit test/concept-detail-cap.test.js`
Expected: PASS (all five).

- [ ] **Step 6: Add collapse-affordance CSS (source) + verify line endings**

In `sap-fundamental.src.css`, add a small rule for `.concept-card-grid__more` (and its `summary`) — Horizon tokens, e.g. `summary` styled as a text button, top margin. Run `npm run build:css` (exit 0).
Run: `file srv/lib/templates/concept-detail.ejs srv/lib/concept-detail-render.js test/concept-detail-cap.test.js` — normalize any CRLF flip.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/concept-detail-render.js srv/lib/templates/concept-detail.ejs test/concept-detail-cap.test.js hugo/assets/css/sap-fundamental.src.css
git commit -m "fix(#3095): cap KG-relationship tile lists at 24 with no-JS <details> collapse"
```

---

## Task 3: Local verification + PR

**Files:** none (verification + PR only)

- [ ] **Step 1: Scoped test run**

Run: `npx vitest run --project unit test/concept-page-container.test.js test/concept-detail-cap.test.js`
Expected: all PASS.

- [ ] **Step 2: Confirm no built CSS or stray files staged**

Run: `git status --porcelain` — expect only the four source files across the two commits; `hugo/assets/css/sap-fundamental.css` must NOT appear (gitignored).

- [ ] **Step 3: Push branch + open PR to DEV**

```bash
git push -u origin fix-concept-page-layout-3095
gh pr create --base DEV --title "fix(#3095): concept/topic/channel page layout — container padding + cap relationship walls" --body "<summary + two-step activation note + verification plan>"
```
PR body MUST state the two-step activation: CSS fixes activate on deploy for all four pages; the concept relationship cap needs a concepts re-publish (`rebuild-content.yml`) after deploy to reach served BLOBs. Link issue #3095 and the design spec.

- [ ] **Step 4: Post-deploy verification (record in PR, do not mark done until confirmed)**

After the change is deployed to DEV + concepts re-published, curl `/concepts/sap-btp-fundamentals/`, `/concepts/cap-golden-path-best-practices/`, `/topics/<slug>/`, `/channels/`, `/channels/<slug>/`; confirm (a) container padding present on all, (b) the "Concepts that build on this" section on the hub page shows 24 tiles + a "Show all 235" `<details>`. Compare against #3095 screenshots.

---

## Self-review notes

- **Spec coverage:** bug class A (4 roots) → Task 1; bug B (cap) → Task 2; deploy/publish sequencing + verification → Task 3. All spec sections mapped.
- **Type consistency:** `renderCappedGrid(items, renderItem, {visible,label})` defined in Task 2 Interfaces and used identically in Steps 3–4; `renderConceptDetail` signature matches `concept-detail-render.js:52`.
- **Review Focus:** all five boundary/escape/non-regression cases have owning tests in Task 1/2.
- **Proportion:** plan carries decisions (selectors, values, N=24, helper signature, boundary assertions); implementers write the EJS/CSS bodies and the helper body.
