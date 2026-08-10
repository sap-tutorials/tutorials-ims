# Fingerprint `joule.css` + `sap-fundamental.css` (dual-emit) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `joule.css` and `sap-fundamental.css` emit content-fingerprinted URLs (edge-safe) while still emitting a bare `/css/<name>.css` for the static/runtime consumers that can't take a build-time hash — closing the last two bare-path CSS stale-edge gaps from the 2026-08-10 giant-logo incident (follow-up to #1601/#1603).

**Architecture:** Single-source **dual-emit** via Hugo's `Resource.Publish`. Each stylesheet lives once in `hugo/assets/css/`; the Hugo layout links a `| fingerprint` variant (hashed URL) and calls `.Publish` to also write the bare filename. `sap-fundamental.css`'s `@import` source is renamed `.src.css` and `build:css` compiles it into `assets/` (committed compiled bytes, since `npm run dev` has no CSS build step). CAP degraded-fallback renderers, the static admin-shell page, and smoke tests keep their bare `/css/*` references and are left untouched — `.Publish` guarantees the bare file exists for them.

**Tech Stack:** Hugo v0.147.7+extended (`resources.Get`, `| fingerprint`, `.Publish`), PostCSS (`postcss-cli` + `postcss-import`, `hugo/postcss.config.cjs`), Vitest (source-string guard tests).

## Global Constraints

- **Fingerprint the COMPILED bytes of `sap-fundamental.css`, never the `@import` source** — the `@import 'fundamental-styles/dist/...'` source does not resolve in a browser.
- **Keep the compiled `hugo/assets/css/sap-fundamental.css` committed to git** — `npm run dev` runs `hugo server` with no `build:css` step and depends on committed compiled bytes; `test/hugo-step-badges.test.js` reads this exact path.
- **Every dual-emit site MUST emit BOTH** the fingerprinted `<link>` AND the bare `/css/<name>.css` (via `.Publish`). Dropping the bare emit 404s admin-shell / scanner / CAP-fallback / smoke.
- **`.Publish` is side-effect only, returns nil, prints nothing** — safe to call inline in a template.
- **Do NOT modify** `srv/lib/content-store.js`, `srv/lib/concept-list-page.js`, `app/admin-shell/webapp/index.html`, `test/smoke/joule-aurora.test.js`, `test/smoke/joule-step-fab.test.js` — they intentionally keep bare paths.
- **Respect the existing `{{ if not site.Params.qa }}` guard** around the joule `<link>` in `baseof.html`.
- **Windows/CRLF:** this repo is edited on Windows; preserve existing line endings on touched files (don't let an editor flip LF→CRLF).

## File Structure

| File | Responsibility after change |
|---|---|
| `hugo/assets/css/joule.css` | joule source (moved from `static/`); Hugo-resolvable, dual-emitted |
| `hugo/assets/css/sap-fundamental.src.css` | the `@import` source (renamed); editable source, NOT shipped |
| `hugo/assets/css/sap-fundamental.css` | compiled bytes (committed); the file that gets fingerprinted + published |
| `package.json` → `build:css` | compiles `.src.css` → `assets/sap-fundamental.css` |
| `hugo/layouts/_default/baseof.html` | dual-emit joule (fingerprint link + `.Publish`) |
| `hugo/layouts/partials/head.html` | dual-emit sap-fundamental |
| `hugo/layouts/scanner-vue/list.html` | dual-emit sap-fundamental |
| `test/hugo-css-fingerprint.test.js` | NEW source-string guard: layouts fingerprint + publish both files |
| `docs/developers/architecture/cdn-caching.md` | note both files now fingerprinted (dual-emit) |

---

### Task 1: Retarget `build:css` and rename the sap-fundamental source

**Files:**
- Modify: `package.json` (the `build:css` script, ~line 63)
- Rename: `hugo/assets/css/sap-fundamental.css` → `hugo/assets/css/sap-fundamental.src.css`
- Regenerate + commit: `hugo/assets/css/sap-fundamental.css` (now compiled bytes)
- Delete: `hugo/static/css/sap-fundamental.css`

**Interfaces:**
- Produces: a committed `hugo/assets/css/sap-fundamental.css` containing **compiled** CSS (no `@import 'fundamental-styles` lines) with the `.step-badge` rules intact. Task 3 fingerprints this file; `test/hugo-step-badges.test.js` reads it.

- [ ] **Step 1: Rename the `@import` source to `.src.css`**

```bash
cd "D:/projects/tutorials-poc/.claude/worktrees/issue-1605-fingerprint-css"
git mv hugo/assets/css/sap-fundamental.css hugo/assets/css/sap-fundamental.src.css
```

- [ ] **Step 2: Add a header note to the source (drift guard)**

Prepend this comment as the first line of `hugo/assets/css/sap-fundamental.src.css` (keep the existing `@import` lines after it):

```css
/* SOURCE — edit here, then run `npm run build:css` to regenerate the committed
   compiled hugo/assets/css/sap-fundamental.css that Hugo fingerprints + publishes. */
```

- [ ] **Step 3: Retarget the `build:css` script in `package.json`**

Change the `build:css` value from:

```
"build:css": "postcss hugo/assets/css/sap-fundamental.css --config hugo/ --no-map -o hugo/static/css/sap-fundamental.css",
```

to:

```
"build:css": "postcss hugo/assets/css/sap-fundamental.src.css --config hugo/ --no-map -o hugo/assets/css/sap-fundamental.css",
```

- [ ] **Step 4: Run `build:css` to regenerate the compiled bytes into `assets/`**

Run: `npm run build:css`
Expected: writes `hugo/assets/css/sap-fundamental.css` (~800 KB compiled). Command exits 0.

- [ ] **Step 5: Verify the regenerated file is compiled, not the `@import` source**

Run:
```bash
head -1 hugo/assets/css/sap-fundamental.css
grep -c "step-badge" hugo/assets/css/sap-fundamental.css
grep -c "@import 'fundamental-styles" hugo/assets/css/sap-fundamental.css
```
Expected: first line is `@charset "UTF-8";...` (NOT `@import './sap-theme-vars.css'`); `step-badge` count is `8`; `@import 'fundamental-styles` count is `0`.

- [ ] **Step 6: Delete the now-redundant `static/` compiled copy**

```bash
git rm hugo/static/css/sap-fundamental.css
```

- [ ] **Step 7: Run the existing step-badge test (reads the assets path)**

Run: `npx vitest run --project unit test/hugo-step-badges.test.js`
Expected: PASS (the `.step-badge` rules are present in the compiled `assets/` file).

- [ ] **Step 8: Commit**

```bash
git add package.json hugo/assets/css/sap-fundamental.src.css hugo/assets/css/sap-fundamental.css
git commit -m "build(css): compile sap-fundamental into assets/ for fingerprinting [#1605]"
```

---

### Task 2: Move `joule.css` into `assets/`

**Files:**
- Rename: `hugo/static/css/joule.css` → `hugo/assets/css/joule.css`

**Interfaces:**
- Produces: `hugo/assets/css/joule.css` reachable via `resources.Get "css/joule.css"`. Task 4 fingerprints + publishes it.

- [ ] **Step 1: Move the file**

```bash
git mv hugo/static/css/joule.css hugo/assets/css/joule.css
```

- [ ] **Step 2: Verify no other build step depends on the old static path**

Run:
```bash
grep -rn "static/css/joule" scripts/ package.json .deploy/ 2>/dev/null
```
Expected: no output (nothing references the old `static/css/joule.css` build-time path; runtime consumers use the `/css/joule.css` URL, which Task 4's `.Publish` provides).

- [ ] **Step 3: Commit**

```bash
git add -A hugo/static/css/joule.css hugo/assets/css/joule.css
git commit -m "refactor(css): move joule.css to assets/ for fingerprinting [#1605]"
```

---

### Task 3: Dual-emit `sap-fundamental.css` from `head.html`

**Files:**
- Modify: `hugo/layouts/partials/head.html:35`

**Interfaces:**
- Consumes: `hugo/assets/css/sap-fundamental.css` (compiled, from Task 1).
- Produces: rendered pages link `/css/sap-fundamental.<hash>.css` and the build emits bare `/css/sap-fundamental.css`. Flows into the CAP `__shell__` automatically (the `_shell` layout renders through `head.html`).

- [ ] **Step 1: Replace the bare `<link>` at line 35**

Replace this line:

```gotemplate
<link rel="stylesheet" href="/css/sap-fundamental.css">
```

with:

```gotemplate
{{ $fundamental := resources.Get "css/sap-fundamental.css" }}{{ $fundamental.Publish }}<link rel="stylesheet" href="{{ ($fundamental | fingerprint).RelPermalink }}">
```

- [ ] **Step 2: Build Hugo and verify the emit**

Run:
```bash
hugo --source hugo --minify --destination public-1605check
```
Expected: exits 0. Then:
```bash
ls hugo/public-1605check/css/sap-fundamental*.css
grep -o '/css/sap-fundamental[^"]*\.css' hugo/public-1605check/index.html | sort -u
```
Expected: TWO files listed — `sap-fundamental.css` AND `sap-fundamental.<hash>.css`; `index.html` references ONLY the hashed one (no bare `/css/sap-fundamental.css` link).

- [ ] **Step 3: Verify the published bare copy is compiled (not the `@import` source)**

Run: `head -1 hugo/public-1605check/css/sap-fundamental.css`
Expected: `@charset "UTF-8";...` (compiled), NOT `@import`.

- [ ] **Step 4: Clean up the throwaway build dir**

```bash
rm -rf hugo/public-1605check
```

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/partials/head.html
git commit -m "fix(cdn): fingerprint sap-fundamental.css in head.html (dual-emit) [#1605]"
```

---

### Task 4: Dual-emit `joule.css` from `baseof.html`

**Files:**
- Modify: `hugo/layouts/_default/baseof.html:15`

**Interfaces:**
- Consumes: `hugo/assets/css/joule.css` (from Task 2).
- Produces: rendered pages link `/css/joule.<hash>.css`; build emits bare `/css/joule.css` for admin-shell + smoke.

- [ ] **Step 1: Replace the guarded bare `<link>` at line 15**

Replace this line:

```gotemplate
  {{ if not site.Params.qa }}<link rel="stylesheet" href="/css/joule.css">{{ end }}
```

with:

```gotemplate
  {{ if not site.Params.qa }}{{ $joule := resources.Get "css/joule.css" }}{{ $joule.Publish }}<link rel="stylesheet" href="{{ ($joule | fingerprint).RelPermalink }}">{{ end }}
```

- [ ] **Step 2: Build Hugo and verify the emit**

Run:
```bash
hugo --source hugo --minify --destination public-1605check
ls hugo/public-1605check/css/joule*.css
grep -o '/css/joule[^"]*\.css' hugo/public-1605check/index.html | sort -u
```
Expected: TWO files — `joule.css` AND `joule.<hash>.css`; `index.html` references ONLY the hashed one.

- [ ] **Step 3: Clean up**

```bash
rm -rf hugo/public-1605check
```

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/_default/baseof.html
git commit -m "fix(cdn): fingerprint joule.css in baseof.html (dual-emit) [#1605]"
```

---

### Task 5: Dual-emit `sap-fundamental.css` from the scanner layout

**Files:**
- Modify: `hugo/layouts/scanner-vue/list.html:20`

**Interfaces:**
- Consumes: `hugo/assets/css/sap-fundamental.css`.
- Produces: scanner page links the hashed URL; bare copy re-published (idempotent with Task 3).

- [ ] **Step 1: Replace the bare `<link>` at line 20**

Replace this line:

```gotemplate
  <link rel="stylesheet" href="/css/sap-fundamental.css">
```

with:

```gotemplate
  {{ $fundamental := resources.Get "css/sap-fundamental.css" }}{{ $fundamental.Publish }}
  <link rel="stylesheet" href="{{ ($fundamental | fingerprint).RelPermalink }}">
```

- [ ] **Step 2: Build Hugo and confirm it still builds clean**

Run: `hugo --source hugo --minify --destination public-1605check`
Expected: exits 0 (publishing the same resource from two layouts is safe/idempotent).

- [ ] **Step 3: Clean up**

```bash
rm -rf hugo/public-1605check
```

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/scanner-vue/list.html
git commit -m "fix(cdn): fingerprint sap-fundamental.css in scanner layout (dual-emit) [#1605]"
```

---

### Task 6: Guard test — layouts fingerprint AND publish both stylesheets

**Files:**
- Create: `test/hugo-css-fingerprint.test.js`

**Interfaces:**
- Consumes: the three modified layout files (Tasks 3–5) + `baseof.html` (Task 4).
- Produces: a source-string regression guard, mirroring the `test/hugo-step-badges.test.js` source-string style (the repo has no Hugo render harness).

- [ ] **Step 1: Write the failing test**

```javascript
// test/hugo-css-fingerprint.test.js
//
// Source-string guard for issue #1605: joule.css + sap-fundamental.css must be
// emitted BOTH fingerprinted (edge-safe hashed URL) AND bare (.Publish) so the
// static admin-shell page, scanner, CAP degraded fallback, and smoke tests that
// reference bare /css/<name>.css keep resolving. See the design spec:
// docs/superpowers/specs/2026-08-10-1605-fingerprint-joule-sapfundamental-design.md
//
// Source-string (not rendered-Hugo) for the same reasons as hugo-step-badges.test.js:
// the repo has no Hugo render harness.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

const baseof  = read('hugo/layouts/_default/baseof.html');
const head    = read('hugo/layouts/partials/head.html');
const scanner = read('hugo/layouts/scanner-vue/list.html');

describe('#1605 — joule.css dual-emit (baseof.html)', () => {
  it('fingerprints joule.css', () => {
    expect(baseof).toMatch(/resources\.Get "css\/joule\.css"/);
    expect(baseof).toMatch(/\|\s*fingerprint/);
  });
  it('publishes the bare joule.css copy', () => {
    expect(baseof).toMatch(/\$joule\.Publish/);
  });
  it('no longer links the bare /css/joule.css path', () => {
    expect(baseof).not.toMatch(/href="\/css\/joule\.css"/);
  });
  it('keeps the qa guard', () => {
    expect(baseof).toMatch(/if not site\.Params\.qa/);
  });
});

describe('#1605 — sap-fundamental.css dual-emit (head.html + scanner)', () => {
  it('head.html fingerprints + publishes sap-fundamental.css', () => {
    expect(head).toMatch(/resources\.Get "css\/sap-fundamental\.css"/);
    expect(head).toMatch(/\$fundamental\.Publish/);
    expect(head).toMatch(/\|\s*fingerprint/);
    expect(head).not.toMatch(/href="\/css\/sap-fundamental\.css"/);
  });
  it('scanner layout fingerprints + publishes sap-fundamental.css', () => {
    expect(scanner).toMatch(/resources\.Get "css\/sap-fundamental\.css"/);
    expect(scanner).toMatch(/\$fundamental\.Publish/);
    expect(scanner).toMatch(/\|\s*fingerprint/);
    expect(scanner).not.toMatch(/href="\/css\/sap-fundamental\.css"/);
  });
});

describe('#1605 — source layout / build invariants', () => {
  it('joule.css source lives in assets/, not static/', () => {
    expect(existsSync(join(REPO_ROOT, 'hugo/assets/css/joule.css'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'hugo/static/css/joule.css'))).toBe(false);
  });
  it('the fingerprinted sap-fundamental.css is committed compiled bytes, not the @import source', () => {
    const compiled = read('hugo/assets/css/sap-fundamental.css');
    expect(compiled).not.toMatch(/@import 'fundamental-styles/);
    expect(compiled).toMatch(/step-badge/);
    // the old verbatim static copy must be gone (dual-emit replaces it)
    expect(existsSync(join(REPO_ROOT, 'hugo/static/css/sap-fundamental.css'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to confirm it passes against Tasks 1–5**

Run: `npx vitest run --project unit test/hugo-css-fingerprint.test.js`
Expected: PASS (all describe blocks). If any fail, the corresponding layout/build task was not applied correctly — fix the layout, not the test.

- [ ] **Step 3: Commit**

```bash
git add test/hugo-css-fingerprint.test.js
git commit -m "test(cdn): guard joule + sap-fundamental dual-emit fingerprinting [#1605]"
```

---

### Task 7: Full local build + doc update + final verification

**Files:**
- Modify: `docs/developers/architecture/cdn-caching.md` (the §"Static assets" paragraph noting assets are not fingerprinted)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a full-pipeline build proof + updated docs.

- [ ] **Step 1: Run the real production CSS + Hugo build end-to-end**

Run:
```bash
npm run build:css
hugo --source hugo --minify
```
Expected: both exit 0.

- [ ] **Step 2: Assert dual-emit in the real `hugo/public`**

Run:
```bash
ls hugo/public/css/joule*.css hugo/public/css/sap-fundamental*.css
grep -rl 'href="/css/joule\.css"' hugo/public 2>/dev/null | head
grep -rl 'href="/css/sap-fundamental\.css"' hugo/public 2>/dev/null | head
```
Expected: each stylesheet lists BOTH a bare and a `.<hash>.` file; the two `grep`s for bare `<link href>` return **no** rendered HTML pages (pages link only the hashed URLs).

- [ ] **Step 3: Confirm the bare files exist for runtime consumers**

Run:
```bash
test -f hugo/public/css/joule.css && echo "joule bare OK"
test -f hugo/public/css/sap-fundamental.css && echo "sap-fundamental bare OK"
head -1 hugo/public/css/sap-fundamental.css
```
Expected: both "OK" lines; the sap-fundamental bare head is `@charset "UTF-8";...` (compiled).

- [ ] **Step 4: Update the CDN doc**

In `docs/developers/architecture/cdn-caching.md`, find the §"Static assets" paragraph that reads (near the `cacheControl` block) "the Hugo assets are **not** content-fingerprinted — the templates reference `/css/sap-fundamental.css`, `/js/joule.js`, etc. by stable path". Replace the `/css/sap-fundamental.css` example with a still-bare one and add a sentence noting the fingerprinting progress. Change that sentence to:

```markdown
The TTL is a **deliberately modest 1 hour**, not `immutable`/1-year, because the
Hugo assets are **only partially** content-fingerprinted. The page-referenced
stylesheets (`sap-fundamental.css`, `joule.css`, and the #1601/#1603 set) now emit
content-hashed URLs (dual-emitted alongside a bare copy for static/runtime
consumers — see #1605), but many JS islands (`/js/joule.js`, etc.) and the
theme-var CSS still reference stable paths (some carry a `?v=` query, many do not).
A long/immutable TTL would strand a stale un-fingerprinted asset across a redeploy.
Raising this to `immutable` + a 1-year TTL is gated on fingerprinting the remaining
`/js/*` assets; until then 1 h keeps redeploys safe while still offloading the bulk
of asset requests.
```

- [ ] **Step 5: Run the guard + step-badge tests together**

Run: `npx vitest run --project unit test/hugo-css-fingerprint.test.js test/hugo-step-badges.test.js`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/developers/architecture/cdn-caching.md
git commit -m "docs(cdn): note joule + sap-fundamental now fingerprinted [#1605]"
```

- [ ] **Step 7: Restore the working tree (don't ship the throwaway public build)**

The `hugo/public` from Step 1 is a build artifact and should not be committed (verify it's gitignored). Run:
```bash
git status --porcelain hugo/public | head
```
Expected: no output (hugo/public is gitignored). If output appears, do NOT `git add` it.

---

## Self-Review

**Spec coverage:**
- Correction A (fingerprint compiled bytes) → Task 1.
- Correction B (CAP `__shell__` inherits head.html; CAP renderers untouched) → Task 3 interface note + Global Constraints (do-not-modify list).
- Dual-emit mechanism → Tasks 3/4/5 + Global Constraints.
- joule move → Task 2; joule dual-emit → Task 4.
- sap-fundamental source rename + build retarget + delete static copy → Task 1.
- Bare consumers preserved → `.Publish` in Tasks 3/4/5, verified Task 7 Step 3.
- Test impact (step-badge test, committed compiled bytes) → Task 1 Steps 5/7, Task 6 Step 1.
- Guard test → Task 6.
- Doc update → Task 7 Step 4.
- All "Files changed" rows from the spec are covered.

**Placeholder scan:** No TBD/TODO; every code/edit step shows exact before/after content and exact commands with expected output.

**Type/name consistency:** Template var names consistent — `$joule` (baseof), `$fundamental` (head + scanner). Test regexes match those exact names and the `resources.Get "css/<name>.css"` strings used in the layouts. `build:css` input/output paths consistent between Task 1 Step 3 and the file-structure table.
