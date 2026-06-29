# Issue #744 — Fold `/explore/` into Hugo: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the standalone srv-rendered `/explore/` page with a Hugo content page so it inherits the SAP Developer Center shellbar, theme bootstrap, head/footer, and joule panel from `baseof.html`.

**Architecture:** Hugo emits `hugo/public/explore/index.html` with chrome + a `<div id="explore-app">` mount + `<script type="module" src="/explore-ui/main-<hash>.js">`. Hugo learns the Vite bundle hash from a small JSON manifest (`hugo/data/explore_bundle.json`) emitted by `scripts/build-explore-manifest.ts`. The Vue/Sigma SPA in `app/explore/` stays as its own Vite project (preserves 150KB gzip budget + Sigma/graphology deps). The current SSR-inlined graph payload is dropped — `useGraphData()` already has a `fetch('/graph/explore-data')` fallback.

**Tech Stack:** Hugo 0.147, Vite 5.4, Vue 3.5, Sigma.js 3, graphology, TypeScript 5.9, Vitest, BTP CF approuter + xs-app.json, MTA build.

**Spec:** [`docs/superpowers/specs/2026-06-29-744-explore-into-hugo-design.md`](../specs/2026-06-29-744-explore-into-hugo-design.md)

---

## File Structure

### New files

- `hugo/content/explore/_index.md` — Hugo content with frontmatter (`type: explore`, `layout: single`, title, description, slug).
- `hugo/layouts/explore/single.html` — Hugo template; mounts `<div id="explore-app">`, reads `site.Data.explore_bundle`, emits `<link>` + `<script>` tags with the `{{ with }}{{ else }}` error fallback.
- `hugo/data/explore_bundle.json` — generated; **gitignored**. Same `{hash, css}` shape as the old srv manifest.
- `test/unit/scripts/check-explore-manifest-hugo.test.ts` — asserts both mta.yaml files contain the manifest-emit step targeting `hugo/data/explore_bundle.json` and that the step appears before the Hugo build step in the same module's before-all.
- `test/unit/hugo/explore-layout.test.ts` — text-grep test on `hugo/layouts/explore/single.html`.

### Modified files

- `scripts/build-explore-manifest.ts` — default output path moves from `srv/lib/explore-bundle-manifest.json` to `hugo/data/explore_bundle.json`.
- `package.json` — `build:explore-manifest` script (already exists, unchanged); `build:all` orchestrates manifest existence before Hugo runs (new freshness guard).
- `srv/server.js:10` — remove `import { exploreHandler }`.
- `srv/server.js:191-192` — remove both `/explore` and `/explore/` registrations.
- `app/explore/src/main.ts` — `.mount('#app')` → `.mount('#explore-app')`.
- `app/explore/src/composables/useGraphData.ts` — drop the `window.__INITIAL_GRAPH__` branch.
- `app/explore/index.html` (Vite's dev-mode shell) — `<div id="app">` → `<div id="explore-app">` (keeps Vite dev server working).
- `approuter/xs-app.json:75-83` — remove the `^/explore/?$` → `srv-api` route entry (the surrounding `^/explore-ui/(.*)$` static entry stays).
- `mta.yaml:82-86` — change `gen/srv/srv/lib/explore-bundle-manifest.json` to `hugo/data/explore_bundle.json`. The step stays in the same global before-all block; sequencing rule: must run BEFORE the Hugo build line on `mta.yaml:46` (today's `bash -c '... /tmp/hugo --source hugo --minify ...'`). So the manifest emit moves UP, above the Hugo build invocation.
- `.deploy/mta.yaml:43` — symmetric change, preserving the `bash -c "cd .. && ..."` wrapper; target becomes `hugo/data/explore_bundle.json`. Move BEFORE Hugo build in the same global before-all.
- `.gitignore` — add `hugo/data/explore_bundle.json` (it's a build artifact).
- `test/smoke/explore-route.smoke.test.js` — rewrite. The current test asserts inline-graph-JSON presence (gone), Vite-hashed JS asset (kept), CSS asset (kept). Add: shellbar markup present, `data-theme` attribute on `<html>`, `/graph/explore-data` returns valid payload (kept).
- `test/unit/scripts/build-explore-manifest.test.ts` — update the default-output-path assertion in the "writes manifest to disk" case.

### Deleted files

- `srv/lib/explore-route.js`
- `srv/lib/build-explore-html.js`
- `srv/templates/explore.html`
- `srv/lib/explore-bundle-manifest.json` (build artifact; was already gitignored — verify and remove from disk if present)
- `test/unit/srv/explore-route.test.js`
- `test/unit/srv/build-explore-html.test.ts`
- `test/unit/scripts/check-explore-manifest-mta.test.ts`

---

## Task 1: Switch `scripts/build-explore-manifest.ts` default to Hugo target

**Files:**
- Modify: `scripts/build-explore-manifest.ts` (line ~77 — the CLI fallback path)
- Modify: `test/unit/scripts/build-explore-manifest.test.ts` (the "writes manifest to disk" case at the bottom)

- [ ] **Step 1: Read the existing test to confirm the assertion shape**

Run:
```bash
cd D:/projects/tutorials-poc/.claude/worktrees/744-explore-into-hugo
sed -n '60,80p' test/unit/scripts/build-explore-manifest.test.ts
```
Expected: see the `'writes manifest to disk when outPath is provided'` test that supplies `outPath` explicitly — unaffected by the default change. No assertion changes needed here.

- [ ] **Step 2: Add a new failing test for the default output path**

Append to `test/unit/scripts/build-explore-manifest.test.ts` (before the final closing `})`):

```ts
  it('default CLI output path is hugo/data/explore_bundle.json (not srv/lib/...)', async () => {
    // Read the script's source and assert the default outPath constant.
    // We can't easily run the CLI without invoking tsx in a subprocess;
    // text-asserting the default in the source is the cheapest pin.
    const src = readFileSync(
      join(import.meta.dirname, '../../../scripts/build-explore-manifest.ts'),
      'utf8',
    )
    expect(src).toMatch(/hugo\/data\/explore_bundle\.json/)
    expect(src).not.toMatch(/srv\/lib\/explore-bundle-manifest\.json/)
  })
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `npx vitest run test/unit/scripts/build-explore-manifest.test.ts`
Expected: the new case fails — current default is `srv/lib/explore-bundle-manifest.json`.

- [ ] **Step 4: Change the CLI default in `scripts/build-explore-manifest.ts`**

In the file at `scripts/build-explore-manifest.ts`, the bottom CLI block reads:

```ts
  const outPath = process.argv[3] ?? path.resolve('srv/lib/explore-bundle-manifest.json')
```

Change to:

```ts
  const outPath = process.argv[3] ?? path.resolve('hugo/data/explore_bundle.json')
```

Also update the file-header comment from "writes srv/lib/explore-bundle-manifest.json next to the route module that needs it" to reflect the new role — name it `hugo/data/explore_bundle.json` and describe the new consumer (Hugo's `site.Data.explore_bundle`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/scripts/build-explore-manifest.test.ts`
Expected: all 6 cases pass (5 existing + 1 new).

- [ ] **Step 6: Commit**

```bash
git add scripts/build-explore-manifest.ts test/unit/scripts/build-explore-manifest.test.ts
git -c core.autocrlf=false commit -m "feat(#744): default explore-manifest target to hugo/data/

scripts/build-explore-manifest.ts now defaults to writing
hugo/data/explore_bundle.json instead of
srv/lib/explore-bundle-manifest.json. The mta.yaml files (Task 5)
will pass the new path explicitly; the CLI default reflects the
new canonical target."
```

---

## Task 2: Add `.gitignore` entry for the build artifact

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Check the artifact isn't already tracked**

Run:
```bash
git ls-files hugo/data/explore_bundle.json
```
Expected: empty output (file never committed).

- [ ] **Step 2: Append to `.gitignore`**

Add at the end of `.gitignore`:

```
# Build artifact produced by scripts/build-explore-manifest.ts; consumed by Hugo.
hugo/data/explore_bundle.json
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git -c core.autocrlf=false commit -m "chore(#744): gitignore hugo/data/explore_bundle.json"
```

---

## Task 3: Create the Hugo content page

**Files:**
- Create: `hugo/content/explore/_index.md`

- [ ] **Step 1: Write the content file**

Create `hugo/content/explore/_index.md`:

```markdown
---
title: Knowledge Graph Explorer
description: Interactive visualization of the SAP Developers knowledge graph — tutorials, missions, concepts, products, and the relationships between them.
type: explore
layout: single
slug: explore
---
```

The Vue island renders the actual content; Markdown body is intentionally empty.

- [ ] **Step 2: Commit**

```bash
git add hugo/content/explore/_index.md
git -c core.autocrlf=false commit -m "feat(#744): add hugo/content/explore/_index.md

Content page with frontmatter only; the Vue/Sigma island in
app/explore/ renders the page body. Title and description feed
the site head/og tags via the existing partials."
```

---

## Task 4: Create the Hugo layout

**Files:**
- Create: `hugo/layouts/explore/single.html`
- Create: `test/unit/hugo/explore-layout.test.ts`

- [ ] **Step 1: Write the failing layout test**

Create `test/unit/hugo/explore-layout.test.ts`:

```ts
// Text-grep test on hugo/layouts/explore/single.html. No Hugo runtime
// needed — we just assert the layout has the right structural pieces.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const LAYOUT = path.resolve(
  import.meta.dirname,
  '../../../hugo/layouts/explore/single.html',
)

describe('hugo/layouts/explore/single.html', () => {
  const html = readFileSync(LAYOUT, 'utf8')

  it('references the explore_bundle data file', () => {
    expect(html).toMatch(/site\.Data\.explore_bundle/)
  })

  it('mounts the Vue island into #explore-app (not #app)', () => {
    expect(html).toMatch(/id="explore-app"/)
    // Defensive: catch a future regression that mounts into Hugo's chrome.
    expect(html).not.toMatch(/<div id="app">/)
  })

  it('has a {{ else }} branch for the missing-manifest case', () => {
    // The {{ with site.Data.explore_bundle }}...{{ else }} block renders
    // a visible build-error message when the manifest is absent (e.g.
    // forgot to run `npm run build:explore` before Hugo).
    expect(html).toMatch(/\{\{\s*else\s*\}\}/)
    expect(html).toMatch(/explore-build-error/)
  })

  it('uses the hashed JS bundle path', () => {
    // Hashed name keeps cache-busting; matches the Vite output convention.
    expect(html).toMatch(/\/explore-ui\/main-/)
  })

  it('defines a "main" Hugo block (inherits from baseof.html)', () => {
    expect(html).toMatch(/\{\{\s*define\s+"main"\s*\}\}/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/hugo/explore-layout.test.ts`
Expected: ENOENT — file doesn't exist yet.

- [ ] **Step 3: Create the Hugo layout**

Create `hugo/layouts/explore/single.html`:

```html
{{ define "main" }}
<div id="explore-app" class="explore-page">
  {{ with site.Data.explore_bundle }}
    <link rel="stylesheet" href="/explore-ui/assets/{{ .css }}">
    <script type="module" src="/explore-ui/main-{{ .hash }}.js"></script>
  {{ else }}
    <div class="explore-build-error" role="alert">
      <h2>Explore bundle missing</h2>
      <p>The explore Vue bundle manifest <code>hugo/data/explore_bundle.json</code>
         was not present at Hugo build time. Run <code>npm run build:explore</code>
         before <code>hugo</code> to regenerate it.</p>
    </div>
  {{ end }}
</div>
<noscript>
  <div class="ds-noscript-fallback">
    <p>JavaScript is required to view the Knowledge Graph explorer.</p>
  </div>
</noscript>
{{ end }}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/hugo/explore-layout.test.ts`
Expected: all 5 assertions pass.

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/explore/single.html test/unit/hugo/explore-layout.test.ts
git -c core.autocrlf=false commit -m "feat(#744): add hugo/layouts/explore/single.html

Hugo layout that mounts the explore Vue island and emits the
hashed bundle script/link tags from site.Data.explore_bundle.
The {{ else }} branch renders a visible build-error message if
the manifest is missing — defends against forgetting to run
\`npm run build:explore\` before \`hugo\`."
```

---

## Task 5: Move the manifest emit step in both `mta.yaml` files

**Files:**
- Modify: `mta.yaml` (DEV/test variant)
- Modify: `.deploy/mta.yaml` (standalone-approuter variant)
- Create: `test/unit/scripts/check-explore-manifest-hugo.test.ts`
- Delete: `test/unit/scripts/check-explore-manifest-mta.test.ts`

The current emit step targets the srv module's MTAR slice (`gen/srv/srv/lib/`). It must move to target Hugo's data dir (`hugo/data/`) AND must run before the Hugo build step in the same module's before-all.

- [ ] **Step 1: Write the failing new mta-shape test**

Create `test/unit/scripts/check-explore-manifest-hugo.test.ts`:

```ts
// Both mta.yaml files must:
//   1. emit the explore manifest into hugo/data/explore_bundle.json
//      (NOT the old gen/srv/srv/lib/ target).
//   2. emit it BEFORE the Hugo build step in the same module's before-all,
//      so Hugo's template-render step can read site.Data.explore_bundle.
//
// Failure mode (out-of-order): if mbt runs `hugo` before the manifest
// emit, Hugo's template falls through to the {{ else }} branch and the
// deployed page renders the visible "Explore bundle missing" message.
//
// Failure mode (wrong target): if the emit step writes to the old
// srv/lib/ path, Hugo's data lookup returns nothing and the {{ else }}
// branch renders too.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'yaml'

const DEPLOY_MTA = path.resolve(import.meta.dirname, '../../../.deploy/mta.yaml')
const LOCAL_MTA = path.resolve(import.meta.dirname, '../../../mta.yaml')

function loadMta(p: string): any {
  return yaml.parse(readFileSync(p, 'utf8'))
}

function findBeforeAllCommands(mta: any): string[] {
  const beforeAll = mta?.['build-parameters']?.['before-all']
  if (!Array.isArray(beforeAll) || beforeAll.length === 0) return []
  return beforeAll.flatMap((b: any) =>
    Array.isArray(b?.commands) ? b.commands : [],
  )
}

const MANIFEST_RE = /tsx (?:\.\.\/)?scripts\/build-explore-manifest\.ts.+hugo\/data\/explore_bundle\.json/
const HUGO_BUILD_RE = /\/tmp\/hugo\s+--source\s+hugo/
const OLD_TARGET_RE = /gen\/srv\/(?:srv\/)?lib\/explore-bundle-manifest\.json/

describe('explore_bundle.json is emitted before Hugo build', () => {
  for (const [label, p] of [['mta.yaml', LOCAL_MTA], ['.deploy/mta.yaml', DEPLOY_MTA]] as const) {
    describe(label, () => {
      const mta = loadMta(p)
      const cmds = findBeforeAllCommands(mta)

      it('emits the manifest into hugo/data/explore_bundle.json', () => {
        const hit = cmds.find((c: string) => MANIFEST_RE.test(c))
        expect(hit, `${label}: manifest emit line targeting hugo/data/`).toBeTruthy()
      })

      it('does NOT target the old gen/srv/...lib/ path', () => {
        const bad = cmds.find((c: string) => OLD_TARGET_RE.test(c))
        expect(bad, `${label}: legacy srv-lib target must be removed`).toBeFalsy()
      })

      it('emits the manifest BEFORE invoking Hugo', () => {
        const manifestIdx = cmds.findIndex((c: string) => MANIFEST_RE.test(c))
        const hugoIdx = cmds.findIndex((c: string) => HUGO_BUILD_RE.test(c))
        // .deploy/mta.yaml might not have an inline /tmp/hugo line (the
        // standalone approuter variant builds Hugo elsewhere). Only enforce
        // ordering when both are present in the same file.
        if (manifestIdx >= 0 && hugoIdx >= 0) {
          expect(manifestIdx).toBeLessThan(hugoIdx)
        } else {
          expect(manifestIdx).toBeGreaterThanOrEqual(0)
        }
      })
    })
  }
})
```

- [ ] **Step 2: Delete the old mta test**

Run:
```bash
git rm test/unit/scripts/check-explore-manifest-mta.test.ts
```

- [ ] **Step 3: Run the new test to confirm it fails**

Run: `npx vitest run test/unit/scripts/check-explore-manifest-hugo.test.ts`
Expected: all assertions fail — the mta files still target `gen/srv/srv/lib/` and the manifest emit happens AFTER the Hugo build.

- [ ] **Step 4: Edit `mta.yaml`**

In `mta.yaml`, find the block at line ~80-86 (the `# Build app/explore + emit the bundle manifest...` comment block plus its 5 command lines: `npm --prefix app/explore install`, `npm --prefix app/explore run build`, the `tsx scripts/build-explore-manifest.ts` line, `mkdir -p approuter/static/explore-ui`, `cp -r app/explore/dist/.`).

Two surgical changes:

**(a) Change the manifest target path.** The single tsx line currently reads:
```yaml
        - npx tsx scripts/build-explore-manifest.ts app/explore/dist gen/srv/srv/lib/explore-bundle-manifest.json
```
Change to:
```yaml
        - npx tsx scripts/build-explore-manifest.ts app/explore/dist hugo/data/explore_bundle.json
```

**(b) Move the three lines `npm --prefix app/explore install` / `... run build` / `npx tsx scripts/build-explore-manifest.ts ...` UP, so they sit BEFORE the parallel Hugo build invocation at `mta.yaml:46` (`bash -c 'set -e; /tmp/hugo --source hugo --minify & p1=$!; ...'`). The `mkdir + cp` steps for `approuter/static/explore-ui/` can stay where they are (they only need to happen before mbt packs the approuter module).

Also update the comment block to describe the new role: the manifest is now read by Hugo (`site.Data.explore_bundle`) at build time, not by srv at request time.

- [ ] **Step 5: Edit `.deploy/mta.yaml`**

In `.deploy/mta.yaml`, find the analogous block at line ~30-45. Two surgical changes:

**(a) Change the manifest target path.** The line currently reads:
```yaml
        - bash -c "cd .. && npx tsx scripts/build-explore-manifest.ts app/explore/dist gen/srv/srv/lib/explore-bundle-manifest.json"
```
Change to:
```yaml
        - bash -c "cd .. && npx tsx scripts/build-explore-manifest.ts app/explore/dist hugo/data/explore_bundle.json"
```

**(b) The `.deploy/mta.yaml` variant has no inline Hugo build (Hugo is built upstream and the result is cp'd in via the module config — verify with `grep -n /tmp/hugo .deploy/mta.yaml`). If no `/tmp/hugo` line exists in the file, the ordering test's `if (manifestIdx >= 0 && hugoIdx >= 0)` branch skips the ordering check for this file. The "manifest present" assertion still applies.

Update the comment block to describe the new role.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/unit/scripts/check-explore-manifest-hugo.test.ts`
Expected: all assertions pass for both mta files.

- [ ] **Step 7: Commit**

```bash
git add mta.yaml .deploy/mta.yaml test/unit/scripts/check-explore-manifest-hugo.test.ts test/unit/scripts/check-explore-manifest-mta.test.ts
git -c core.autocrlf=false commit -m "feat(#744): move explore-manifest emit before Hugo build

Both mta.yaml files now emit hugo/data/explore_bundle.json (instead
of gen/srv/srv/lib/explore-bundle-manifest.json) and run that step
BEFORE the inline Hugo build invocation in the same module's
before-all.

Replaces test/unit/scripts/check-explore-manifest-mta.test.ts —
the new test pins the new path AND the new ordering rule. The old
test's assertions are now wrong (and would always fail) so it's
deleted in this same change."
```

---

## Task 6: Rename Vue mount target from `#app` to `#explore-app`

**Files:**
- Modify: `app/explore/src/main.ts`
- Modify: `app/explore/index.html` (Vite's dev-mode shell)

The rename is precautionary; Section 4.5 of the spec confirms no Hugo partial currently uses `id="app"`, but renaming defends against a future chrome change.

- [ ] **Step 1: Re-confirm the grep**

Run:
```bash
cd D:/projects/tutorials-poc/.claude/worktrees/744-explore-into-hugo
grep -rn 'id="app"' hugo/layouts/ 2>&1
```
Expected: no matches. If matches appear, STOP and report — the rename may now be reactive instead of precautionary, and we need to discuss.

- [ ] **Step 2: Edit `app/explore/src/main.ts`**

Change:
```ts
createApp(App).mount('#app')
```
to:
```ts
createApp(App).mount('#explore-app')
```

- [ ] **Step 3: Edit `app/explore/index.html`**

Change `<div id="app"></div>` to `<div id="explore-app"></div>`. This keeps the Vite dev server (`npm --prefix app/explore run dev`) working — it serves this `index.html` directly.

- [ ] **Step 4: Run the explore unit tests**

Run: `npm --prefix app/explore test 2>&1 | tail -30` (if `app/explore` has tests — check `package.json` scripts; if no `test` script, skip).
Run also: `npx vitest run test/unit/hugo/explore-layout.test.ts`
Expected: pass. The layout test already asserts `#explore-app` is in the layout (Task 4).

- [ ] **Step 5: Commit**

```bash
git add app/explore/src/main.ts app/explore/index.html
git -c core.autocrlf=false commit -m "refactor(#744): rename explore Vue mount #app → #explore-app

Defends against future Hugo chrome changes that might add
<div id=\"app\"> somewhere in baseof.html (joule panel, etc.).
Vite dev server's index.html updated symmetrically so
\`npm --prefix app/explore run dev\` still works."
```

---

## Task 7: Drop the `window.__INITIAL_GRAPH__` branch from `useGraphData`

**Files:**
- Modify: `app/explore/src/composables/useGraphData.ts`

Today the composable prefers an inline `window.__INITIAL_GRAPH__` and falls back to `fetch('/graph/explore-data')`. The new Hugo page never injects the window global; we delete the inline branch so the data flow is one path only.

- [ ] **Step 1: Read the current file**

Run: `cat app/explore/src/composables/useGraphData.ts`
Expected: see the `const initial = typeof window !== 'undefined' ? window.__INITIAL_GRAPH__ : null` line at the top.

- [ ] **Step 2: Rewrite the composable**

Replace the file contents with:

```ts
import { ref, computed } from 'vue'
import type { ExplorePayload } from '../types'

// Fetches the bulk graph payload from /graph/explore-data on mount.
// Pre-#744 this composable also accepted an inline payload via
// window.__INITIAL_GRAPH__ (SSR-injected by the standalone srv template).
// That code path is gone — /explore/ is now a Hugo page with no SSR.

export function useGraphData() {
  const payload = ref<ExplorePayload | null>(null)
  const error = ref<Error | null>(null)
  const hasData = computed(() => !!payload.value)

  async function fetchAsync() {
    try {
      const r = await fetch('/graph/explore-data')
      if (!r.ok) {
        error.value = new Error(`HTTP ${r.status}`)
        return
      }
      payload.value = await r.json()
    } catch (err) {
      console.error('[explore] failed to fetch graph data', err)
      error.value = err instanceof Error ? err : new Error(String(err))
    }
  }

  if (typeof window !== 'undefined') {
    fetchAsync()
  }

  return { payload, hasData, error }
}
```

- [ ] **Step 3: Search the codebase for orphaned `__INITIAL_GRAPH__` references**

Run:
```bash
grep -rn "__INITIAL_GRAPH__" app/explore/ srv/ hugo/ scripts/ 2>/dev/null
```
Expected: only the type declaration (if one exists). Anything in app/explore/src/types.ts that declares `Window.__INITIAL_GRAPH__` should be removed too. If found, delete that declaration. If `app/explore/src/types.ts` has the declaration:

```ts
declare global {
  interface Window {
    __INITIAL_GRAPH__?: ExplorePayload | null
  }
}
```

…delete it. (Re-run the grep to confirm zero references after this change.)

- [ ] **Step 4: Run the explore app's tests (if any)**

Run: `npm --prefix app/explore test 2>&1 | tail -50` (only if a `test` script is defined in `app/explore/package.json`; skip if not).
Expected: pass. If tests reference `window.__INITIAL_GRAPH__`, update them to mock `fetch` instead.

- [ ] **Step 5: Commit**

```bash
git add app/explore/src/composables/useGraphData.ts app/explore/src/types.ts
git -c core.autocrlf=false commit -m "refactor(#744): drop __INITIAL_GRAPH__ branch from useGraphData

The /explore/ page no longer SSR-injects the graph payload; the
Hugo-served HTML has only chrome + the bundle <script> tag. Vue
unconditionally fetches /graph/explore-data on mount. Reduces the
composable to a single data path and lets the user see the
shellbar + a loading state while the request is in flight."
```

---

## Task 8: Remove the srv `/explore` handler and its registrations

**Files:**
- Modify: `srv/server.js:10` (drop the import)
- Modify: `srv/server.js:191-192` (drop both registrations)
- Delete: `srv/lib/explore-route.js`
- Delete: `srv/lib/build-explore-html.js`
- Delete: `srv/templates/explore.html`
- Delete: `srv/lib/explore-bundle-manifest.json` (if present on disk)
- Delete: `test/unit/srv/explore-route.test.js`
- Delete: `test/unit/srv/build-explore-html.test.ts`

- [ ] **Step 1: Remove the import on `srv/server.js:10`**

Locate and delete the line:
```js
import { exploreHandler } from './lib/explore-route.js';
```

- [ ] **Step 2: Remove both registrations on `srv/server.js:191-192`**

Locate and delete BOTH lines:
```js
  app.get('/explore', exploreHandler);
  app.get('/explore/', exploreHandler);
```
Keep `app.get('/graph/explore-data', exploreDataHandler);` on line 189 — that's a different handler and the new Hugo page calls it.

- [ ] **Step 3: Delete the source files**

Run:
```bash
git rm srv/lib/explore-route.js srv/lib/build-explore-html.js srv/templates/explore.html
git rm -f srv/lib/explore-bundle-manifest.json 2>/dev/null || true   # may not be tracked
rm -f srv/lib/explore-bundle-manifest.json                             # if it's on disk but untracked
```

- [ ] **Step 4: Delete the obsolete tests**

Run:
```bash
git rm test/unit/srv/explore-route.test.js test/unit/srv/build-explore-html.test.ts
```

- [ ] **Step 5: Verify no stale references**

Run:
```bash
grep -rn "exploreHandler\|build-explore-html\|explore-route\|explore-bundle-manifest" srv/ scripts/ test/ 2>/dev/null | grep -v ".test.ts\|node_modules"
```
Expected: zero results. If anything matches, surface it before continuing.

- [ ] **Step 6: Run the srv unit tests**

Run: `npx vitest run test/unit/srv/ 2>&1 | tail -30`
Expected: all tests pass (the two deleted ones are gone; the rest are unaffected).

- [ ] **Step 7: Commit**

```bash
git add srv/server.js
git -c core.autocrlf=false commit -m "feat(#744): remove srv /explore handler

The /explore/ page is now served by Hugo from approuter/static/explore/.
Drops srv/lib/explore-route.js, srv/lib/build-explore-html.js,
srv/templates/explore.html, srv/lib/explore-bundle-manifest.json
(build artifact), and the two unit tests that pinned them. Removes
the import + both app.get registrations from srv/server.js.

The /graph/explore-data and /graph/path endpoints stay — they
power the client-side data fetch from the new Hugo page."
```

---

## Task 9: Remove the approuter `^/explore/?$` route

**Files:**
- Modify: `approuter/xs-app.json` (lines 73-83 — the explore-srv-api entry)

- [ ] **Step 1: Confirm no other route in xs-app.json intercepts `/explore`**

Run:
```bash
grep -n '"explore"' approuter/xs-app.json
grep -n "/explore" approuter/xs-app.json
```
Expected output:
- The `^/explore-ui/(.*)$` static route (line ~69) — keep.
- The `^/explore/?$` → `srv-api` route (line ~75) — remove.
- The `/graph/...explore-data...` route (line ~153) — unrelated, keep.

- [ ] **Step 2: Edit `approuter/xs-app.json`**

Locate this block (lines ~73-83):

```json
    {
      "source": "^/explore/?$",
      "target": "/explore/",
      "destination": "srv-api",
      "authenticationType": "none",
      "csrfProtection": false
    },
```

Delete the entire block (including the trailing comma if it sits before another route). Validate JSON syntax after the edit.

- [ ] **Step 3: Validate JSON**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('approuter/xs-app.json','utf8')); console.log('OK')"
```
Expected: `OK`.

- [ ] **Step 4: Run the xs-app/mta validator**

Run: `npx tsx scripts/check-xs-app-mta.ts 2>&1 | tail -20`
Expected: pass (this validator exists per `package.json` `postbuild:apps`; it sanity-checks xs-app.json against mta.yaml destination references).

- [ ] **Step 5: Commit**

```bash
git add approuter/xs-app.json
git -c core.autocrlf=false commit -m "feat(#744): drop approuter ^/explore/?\$ → srv-api route

The /explore/ page is now Hugo-rendered and served by the
default ^(.*)\$ → localDir: static catch-all from
approuter/static/explore/index.html. The ^/explore-ui/(.*)\$
static route for the Vite bundle is unchanged."
```

---

## Task 10: Add freshness guard to `build:all`

**Files:**
- Modify: `package.json` (`build:all` script + add a `prebuild:hugo` guard)

The orchestrator should fail loudly if `hugo/data/explore_bundle.json` doesn't exist by the time Hugo runs. This is the "belt" half of the Section 4.1 belt-and-braces error-handling design.

- [ ] **Step 1: Decide where the guard runs**

`build:all` script today: `npm run prebuild && npm run fetch-tutorials -- --regenerate && npm run fetch-concepts && npm run fetch-advocates && npm run fetch-homepage-shelves && npm run build:css && npm run build:apps && npm run build:analytics-explorer && npm run copy-joule-vendor && npm run build:hugo && ...`

We add the guard as `prebuild:hugo` so it runs automatically just before `build:hugo`.

- [ ] **Step 2: Edit `package.json`**

Add the new script (insert near the existing `build:hugo` line):

```json
"prebuild:hugo": "node -e \"if (!require('fs').existsSync('hugo/data/explore_bundle.json')) { console.error('\\n[prebuild:hugo] hugo/data/explore_bundle.json missing. Run \\\"npm run build:explore\\\" before \\\"hugo\\\".\\n'); process.exit(1); }\"",
```

npm's lifecycle convention runs `prebuild:hugo` automatically before `build:hugo`. Both `npm run build:hugo` and `npm run build:all` (which calls `build:hugo`) get the guard for free.

- [ ] **Step 3: Test the guard fires**

Run:
```bash
rm -f hugo/data/explore_bundle.json
npm run prebuild:hugo 2>&1 | tail -5
```
Expected: process exits 1, stderr message names the missing file and the script that produces it.

- [ ] **Step 4: Test the guard passes when manifest exists**

Run:
```bash
mkdir -p hugo/data && echo '{"hash":"test","css":"index-test.css"}' > hugo/data/explore_bundle.json
npm run prebuild:hugo 2>&1 | tail -3
```
Expected: process exits 0, no output.

Clean up: `rm -f hugo/data/explore_bundle.json` (will be re-generated by Task 11's verification).

- [ ] **Step 5: Commit**

```bash
git add package.json
git -c core.autocrlf=false commit -m "feat(#744): add prebuild:hugo guard for explore manifest

prebuild:hugo fails loudly if hugo/data/explore_bundle.json is
missing when 'hugo' would run, naming both the missing file and
the script that produces it (npm run build:explore). The 'else'
branch in hugo/layouts/explore/single.html handles the at-build-
time slip; this guard handles the local-dev case where someone
ran 'hugo' without 'npm run build:all' first."
```

---

## Task 11: Verify the full local build pipeline

**Files:** none (manual verification step)

- [ ] **Step 1: Clean any stale state**

Run:
```bash
cd D:/projects/tutorials-poc/.claude/worktrees/744-explore-into-hugo
rm -f hugo/data/explore_bundle.json
rm -rf app/explore/dist
rm -rf hugo/public/explore
```

- [ ] **Step 2: Build the explore bundle and emit the manifest**

Run: `npm run build:explore 2>&1 | tail -15`
Expected: ends with `build-explore-manifest: wrote .../hugo/data/explore_bundle.json — hash=<hash> css=index-<hash>.css`.

- [ ] **Step 3: Verify the manifest exists with the right shape**

Run:
```bash
cat hugo/data/explore_bundle.json
```
Expected: `{ "hash": "<vite-hash>", "css": "index-<hash>.css" }` (real hash, not `"dev"`).

- [ ] **Step 4: Run Hugo standalone**

Run: `hugo --source hugo --minify 2>&1 | tail -15` (or `/tmp/hugo --source hugo --minify` on Linux).
Expected: build succeeds.

- [ ] **Step 5: Inspect the emitted page**

Run:
```bash
head -50 hugo/public/explore/index.html
```
Expected (key markers):
- `<html ... data-theme="light" ... data-page-kind="generic">` (the page-kind for `type: explore` falls through to `generic` since we didn't add an explicit branch — that's OK; see Task 12).
- `<ui5-shellbar id="app-shellbar"` somewhere in the body.
- `<div id="explore-app"` in the body.
- `<script type="module" src="/explore-ui/main-<hash>.js">` inside the explore-app div, with a REAL hash (not `<hash>`).
- `<link rel="stylesheet" href="/explore-ui/assets/index-<hash>.css">` similarly.

If any marker is missing, STOP and surface — the layout or manifest is wrong.

- [ ] **Step 6: Run all unit tests**

Run: `npm test 2>&1 | tail -30`
Expected: green. New tests in `test/unit/hugo/` and `test/unit/scripts/check-explore-manifest-hugo.test.ts` pass; old `srv/explore-route.test.js`, `srv/build-explore-html.test.ts`, `scripts/check-explore-manifest-mta.test.ts` are gone.

- [ ] **Step 7: No commit (verification only)**

If anything broke, fix and re-run. Otherwise proceed.

---

## Task 12: Optionally add `data-page-kind="explore"` to baseof.html

**Files:**
- Modify: `hugo/layouts/_default/baseof.html` (line 3 — the `data-page-kind` ternary chain)

The other custom Hugo types (`tutorials`, `missions`, `groups`, `developer-advocates`) each have an explicit branch in `data-page-kind`. Adding `explore` is small, optional, and makes CSS/JS hooks per-page-kind work. **This task is OPTIONAL** — skip if it adds risk; the default `generic` fallback works fine for the chrome features we care about.

- [ ] **Step 1: Decide whether to skip**

If anything else in this PR feels risky, skip this task. The page kind doesn't affect shellbar or theme — it only affects CSS hooks.

- [ ] **Step 2: Edit `hugo/layouts/_default/baseof.html`**

In the `data-page-kind` ternary on line 3, before the final `{{ else }}generic{{ end }}`:

```
{{ else if eq .Type "developer-advocates" }}advocates
```

becomes

```
{{ else if eq .Type "developer-advocates" }}advocates{{ else if eq .Type "explore" }}explore
```

(Same line; just insert the new `{{ else if }}` branch before `{{ else }}generic`.)

- [ ] **Step 3: Re-run Hugo and inspect**

Run:
```bash
hugo --source hugo --minify >/dev/null 2>&1
grep 'data-page-kind' hugo/public/explore/index.html
```
Expected: `data-page-kind="explore"` (not `generic`).

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/_default/baseof.html
git -c core.autocrlf=false commit -m "feat(#744): set data-page-kind=\"explore\" on /explore/ page

Symmetrically with other custom Hugo content types (tutorials,
missions, groups, developer-advocates). Lets future CSS or JS
target the explore page by [data-page-kind=\"explore\"]."
```

---

## Task 13: Update the smoke test for the new shape

**Files:**
- Modify: `test/smoke/explore-route.smoke.test.js`

Existing test asserts (1) inline graph JSON markup, (2) hashed JS bundle, (3) hashed CSS, (4) `/graph/explore-data`, (5) `/graph/path` with real edge pair, (6) `/graph/path` same-slug 400. After #744, (1) is gone forever and (2-6) stay. We replace (1) with shellbar + theme assertions.

- [ ] **Step 1: Rewrite `test/smoke/explore-route.smoke.test.js`**

Replace the first `it` block (`'returns 200 with valid HTML containing the inline graph JSON'`) with:

```js
  it('returns 200 with shellbar + theme markup (Hugo-rendered chrome)', async () => {
    const r = await fetchWithRetry(`${BASE_URL}/explore/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    html = await r.text();
    // Section 5.2 of the spec: assert the shellbar + theme markup so a
    // regression that re-introduces a standalone template fails loudly.
    expect(html).toContain('app-shellbar');
    expect(html).toMatch(/data-theme=/);
    // The Vue island mount point.
    expect(html).toContain('id="explore-app"');
    // Defensive: confirm the OLD SSR script-tag JSON shape is GONE.
    expect(html).not.toContain('<script type="application/json" id="initial-graph">');
  });
```

The remaining tests (JS bundle 200, CSS 200, `/graph/explore-data`, `/graph/path` pair, `/graph/path` same-slug 400) stay verbatim — they still apply.

- [ ] **Step 2: Update the file-header comment**

Replace the leading comment block:

```js
// #446 Track 3-B — /explore/ end-to-end smoke test.
//
// Task 3 (CSS-discovery) verified that the HTML page references hashed JS/CSS
// asset URLs the approuter can actually serve. Task 6 extends this to the
// underlying CAP endpoints that power the page:
//   1. /explore/ returns 200 HTML with inline graph JSON.
//   2. The referenced JS bundle resolves to 200.
//   3. The referenced CSS file resolves to 200.
//   4. /graph/explore-data returns the bulk payload.
//   5. /graph/path returns 200 for a real edge pair (skipped if empty env).
//   6. /graph/path returns 400 for same-slug query (extracted from Phase 2).
```

with:

```js
// #744 — /explore/ end-to-end smoke test.
//
// Post-#744 the page is Hugo-rendered with full chrome (shellbar + theme)
// and the Vue/Sigma SPA fetches graph data client-side from /graph/explore-data.
// Assertions:
//   1. /explore/ returns 200 HTML with shellbar + theme markup + #explore-app mount.
//   2. The referenced JS bundle resolves to 200.
//   3. The referenced CSS file resolves to 200.
//   4. /graph/explore-data returns the bulk payload.
//   5. /graph/path returns 200 for a real edge pair (skipped if empty env).
//   6. /graph/path returns 400 for same-slug query.
```

- [ ] **Step 3: Commit**

```bash
git add test/smoke/explore-route.smoke.test.js
git -c core.autocrlf=false commit -m "test(#744): assert shellbar + theme markup on /explore/ smoke

Replaces the (deleted) inline-graph-JSON assertion with shellbar +
theme + #explore-app mount assertions. The remaining bundle-200,
CSS-200, and /graph/path tests are unchanged — they still apply to
the Hugo-rendered shape."
```

---

## Task 14: End-to-end local smoke

**Files:** none (manual verification)

- [ ] **Step 1: Full clean build**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/744-explore-into-hugo
rm -rf approuter/static/explore approuter/static/explore-ui hugo/public/explore hugo/data/explore_bundle.json app/explore/dist
```

- [ ] **Step 2: Run the full local build chain**

```bash
npm run build:explore && npm run build:hugo
```

Expected: both succeed. Manifest exists in `hugo/data/`. Hugo emits `hugo/public/explore/index.html`.

- [ ] **Step 3: Stage approuter static files**

```bash
mkdir -p approuter/static/explore-ui
cp -r app/explore/dist/. approuter/static/explore-ui/
cp -r hugo/public/explore approuter/static/
```

- [ ] **Step 4: Inspect the page that will be served**

```bash
head -80 approuter/static/explore/index.html | tail -60
```
Expected: full Hugo chrome (shellbar markup, `data-theme`, `<div id="explore-app">`, hashed bundle `<script>`).

- [ ] **Step 5: Boot approuter standalone**

```bash
cd approuter && node server.js & APP_ROUTER_PID=$!
```
Then in another shell (or wait + curl):

```bash
sleep 3
curl -s http://localhost:5000/explore/ | head -20
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5000/explore-ui/main-*.js | head -1
kill $APP_ROUTER_PID
```
Expected: `/explore/` returns 200 with Hugo chrome; the JS bundle returns 200.

If the approuter has trouble booting locally, this smoke can also be deferred to the deployed-CF verification in Task 16.

- [ ] **Step 6: No commit (verification only)**

---

## Task 15: Open the PR

**Files:** none

- [ ] **Step 1: Push the branch**

```bash
git push -u origin 744-explore-into-hugo
```

- [ ] **Step 2: Create the PR**

```bash
gh pr create --base main --head 744-explore-into-hugo \
  --title "feat(#744): fold /explore/ into Hugo for shellbar + theme" \
  --body "$(cat <<'EOF'
Closes #744.

## What

Replaces the standalone srv-rendered \`/explore/\` page with a Hugo content page so it inherits the SAP Developer Center shellbar, light/dark theme, head/footer, joule panel, and alerts popover from \`baseof.html\`. The Vue/Sigma SPA in \`app/explore/\` stays as its own Vite project; Hugo learns the bundle hash from a small JSON manifest at \`hugo/data/explore_bundle.json\`. The current SSR-inlined graph payload (several MB of \`__INITIAL_GRAPH__\`) is dropped — \`useGraphData()\` already had a \`fetch('/graph/explore-data')\` fallback, and client-fetch lets the chrome paint immediately while data loads.

## Spec

[docs/superpowers/specs/2026-06-29-744-explore-into-hugo-design.md](docs/superpowers/specs/2026-06-29-744-explore-into-hugo-design.md)

## How

- Add \`hugo/content/explore/_index.md\` + \`hugo/layouts/explore/single.html\` (Vue-island layout).
- Move \`scripts/build-explore-manifest.ts\` target from \`srv/lib/...\` → \`hugo/data/explore_bundle.json\`; both \`mta.yaml\` and \`.deploy/mta.yaml\` updated.
- Delete \`srv/lib/explore-route.js\`, \`srv/lib/build-explore-html.js\`, \`srv/templates/explore.html\`, \`srv/lib/explore-bundle-manifest.json\`, and the two unit tests that pinned them.
- Drop the approuter \`^/explore/?\$\` → \`srv-api\` route; default static-serve picks up \`approuter/static/explore/index.html\`.
- Rename Vue mount \`#app\` → \`#explore-app\` to defend against any future Hugo chrome change that adds \`<div id="app">\`.
- Add \`prebuild:hugo\` guard that fails loudly if the manifest is missing.

## Tests

- New: \`test/unit/hugo/explore-layout.test.ts\` (5 assertions on the layout shape).
- New: \`test/unit/scripts/check-explore-manifest-hugo.test.ts\` (asserts both mta files emit to the new path AND emit BEFORE Hugo).
- Updated: \`test/smoke/explore-route.smoke.test.js\` — asserts shellbar + theme + mount markup; bundle-200 + \`/graph/*\` checks unchanged.
- Removed: \`test/unit/srv/explore-route.test.js\`, \`test/unit/srv/build-explore-html.test.ts\`, \`test/unit/scripts/check-explore-manifest-mta.test.ts\`.

## Rollback

\`git revert\` + redeploy. No data migration. No feature flag.

## Manual smoke

After deploy:

1. Load \`/explore/\` — shellbar paints immediately, Sigma canvas + "Loading graph…" for ~1s, then graph renders.
2. Click theme-toggle — page flips to dark, canvas inherits dark background via CSS vars.
3. Open hamburger menu → "Knowledge Graph" — reloads to \`/explore\`.
4. Hard-refresh in dark mode — no light-mode flash (pre-paint script).
5. Block \`/graph/explore-data\` in DevTools, reload — chrome stays painted, body shows "Failed to load graph".
EOF
)"
```

- [ ] **Step 2 alt: Verify CI green**

After the PR opens, watch for the standard CI run. Expected: green. If anything fails, address before merging.

---

## Task 16: Post-merge deploy + verify

After PR merge, deploy from `main` in the **primary tree** (per memory [[feedback_always_deploy_from_main_primary_tree.md]]):

- [ ] **Step 1: Switch to primary tree, pull main**

```bash
cd D:/projects/tutorials-poc
git checkout main
git pull --ff-only origin main
```

- [ ] **Step 2: Verify CF target**

```bash
cf target
```
Expected: DEV space. If wrong, surface and STOP before deploying.

- [ ] **Step 3: Build + deploy**

```bash
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

- [ ] **Step 4: Probe the deployed page**

```bash
curl -s https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/explore/ | grep -c "app-shellbar"
curl -s -o /dev/null -w "%{http_code}\n" https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/explore/
```
Expected: shellbar marker count ≥ 1; status 200.

- [ ] **Step 5: Manual smoke per Task 15's checklist**

Walk through the 5-item manual smoke. Confirm with the user (Tom) once the page paints with chrome + the graph data loads via client fetch.

- [ ] **Step 6: No commit (deploy step)**

---

## Notes / hazards

- **Build sequencing is the highest-risk failure mode.** Task 5's test exists specifically to catch out-of-order regressions; if it ever flakes, fix the mta order, don't relax the test.
- **The `app/explore/index.html` (Vite dev shell) and `app/explore/src/main.ts` must agree on the mount-target ID.** Task 6 updates both. If a future developer changes one without the other, `vite dev` breaks even though production builds work.
- **`window.__INITIAL_GRAPH__` is dead.** Tests referencing it should fail — that's the point. Don't reach for a backwards-compat shim; Task 7's commit message explicitly buries it.
- **Approuter route-source-order matters.** Task 9 drops the explicit `/explore` route; the catch-all `^(.*)$` → `localDir: static` serves the Hugo-emitted file. Confirm no route between them intercepts (Task 9 Step 1).
- **The `data-page-kind="explore"` task (Task 12) is optional.** Skip if the rest of the PR is feeling tight; default `generic` works.
- **CRLF on Windows:** all commits use `git -c core.autocrlf=false commit` per memory [[feedback_crlf_regression_on_windows]].
- **Work in the worktree; deploy from primary tree.** Tasks 1-15 run in `D:/projects/tutorials-poc/.claude/worktrees/744-explore-into-hugo`; Task 16 runs in `D:/projects/tutorials-poc` against `main`.
