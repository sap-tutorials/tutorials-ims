# Vue islands / Hugo / Vite gotchas

A reference of frontend-specific pitfalls in this project's Hugo + Vue 3 islands + Vite pipeline. Each section is a single discovered failure mode with cause, why, and how to apply. These were originally one-fact agent-memory files; consolidated here so platform engineers find them via the VitePress sidebar instead of by guessing memory names.

> Originally maintained as separate memory entries under `~/.claude/projects/d--projects-tutorials-poc/memory/`. Promoted to docs 2026-06-24 to make them discoverable to humans + agents alike.

## How to use this doc

Search (Ctrl-F) for the error message you're seeing, the API you're using, or the symptom. Each section is independent — read only the one you need.

## Sections

- [Hugo minifier strips attribute quotes (smoke regexes must flex)](#hugo-minifier-strips-attribute-quotes-smoke-regexes-must-flex)
- [Hugo percent-shortcode + 4-space-indented HTML becomes a code block](#hugo-percent-shortcode-4-space-indented-html-becomes-a-code-block)
- [QA channel: gate new shellbar items + script tags with `site.Params.qa`](#qa-channel-gate-new-shellbar-items-script-tags-with-siteparamsqa)
- [U1 Object Page is the default tutorial layout](#u1-object-page-is-the-default-tutorial-layout)
- [Vite code-split chunks need `base: '/js/'`](#vite-code-split-chunks-need-base-js)
- [Vue fragment hydration mismatch (multi-root SFCs)](#vue-fragment-hydration-mismatch-multi-root-sfcs)
- [Vue scoped CSS doesn't propagate to child component descendants](#vue-scoped-css-doesnt-propagate-to-child-component-descendants)
- [Vue scoped `<style>` beats unscoped external CSS (specificity)](#vue-scoped-style-beats-unscoped-external-css-specificity)
- [Vue watcher clobbers state restored in `onMounted` (flush: pre)](#vue-watcher-clobbers-state-restored-in-onmounted-flush-pre)
- [Vue island slug source — read `documentElement.dataset.pageSlug`](#vue-island-slug-source-read-documentelementdatasetpageslug)
- [UI5 boolean attr coercion — `disabled=false` renders truthy](#ui5-boolean-attr-coercion-disabledfalse-renders-truthy)
- [Vitest skips imported CSS (`getComputedStyle` returns empty)](#vitest-skips-imported-css-getcomputedstyle-returns-empty)
- [CSP: WebAssembly needs the wasm-specific eval token in `script-src`](#csp-webassembly-needs-the-wasm-specific-eval-token-in-script-src)
- [Flexbox atomizes inline prose into anonymous flex items](#flexbox-atomizes-inline-prose-into-anonymous-flex-items)
- [`extractSection` regex swallows trailing `---` HRs](#extractsection-regex-swallows-trailing-hrs)

---

## Hugo minifier strips attribute quotes (smoke regexes must flex)

Hugo's production HTML minifier strips quotes from attribute values that are HTML-safe (no spaces, no special chars). So `class="joule-step-fab"` becomes `class=joule-step-fab`, and `data-recommend-slug="abap-cloud-ui-from-interface"` becomes `data-recommend-slug=abap-cloud-ui-from-interface`. The dev server doesn't minify, so tests pass locally but fail against deployed prod.

**Why:** Hit twice in the same deploy round (2026-05-23 smoke run for joule-step-fab and recommendations rail wrapper). Same shape as the HANA boolean CASE WHEN gotcha — looks fine in dev/unit, breaks in prod.

**How to apply:** When writing smoke tests that scan rendered Hugo HTML for an attribute, accept both forms in the regex:

```js
expect(html).toMatch(/id=["']?joule-step-fab["']?/);
expect(html).toMatch(/class=(["'][^"']*joule-step-fab[^"']*["']|joule-step-fab[\s>])/);
expect(html).toMatch(new RegExp(`data-recommend-slug=(["']${slug}["']|${slug}[\\s>])`));
```

Don't disable minification to make the test pass — it ships in production. Fix the regex.

---

## Hugo percent-shortcode + 4-space-indented HTML becomes a code block

`{{% shortcode %}}` (percent-style) Hugo shortcodes pipe their rendered output through Goldmark's markdown processor. When a `{{ if }}` block (without `-` whitespace trimming) emits a blank line followed by a 4-space-indented HTML element, Goldmark's CommonMark rule kicks in: "blank line + 4-space indent = indented code block" — wrapping the HTML in `<pre><code>...</code></pre>` with full HTML-entity escaping.

**Why:** Caught all 8 Done buttons on every tutorial on DEV (2026-06-13). Commit `0211bc1e` added `{{ if $branchPointId }}` and `{{ if $skipIf }}` blocks above `<div class="step-actions">` in [hugo/layouts/shortcodes/tutorial-step.html](../../../hugo/layouts/shortcodes/tutorial-step.html). Both conditionals were empty for every tutorial that doesn't use alt-groups/branches (i.e. every tutorial on DEV), but the empty conditionals still emitted leading whitespace + newlines, producing a blank-line-+-indented-`<div>` pattern. Result: every Done button rendered as escaped source code inside a `<pre><code>` block.

**How to apply:**
1. When adding `{{ if }}`/`{{ end }}` blocks inside a `{{% %}}` shortcode template, ALWAYS use whitespace-trimming form: `{{- if ... }}` and `{{- end }}` so empty conditionals collapse to zero whitespace.
2. Verify with `cat -A` after changes — `$` at end of indented blank lines reveals the trap.
3. The bug is invisible to grep/diff because the offending characters are spaces and newlines.
4. Test post-build HTML for `pre><code>&lt;div class=&quot;step-actions` — that string in any tutorial output means this regressed.

---

## QA channel: gate new shellbar items + script tags with `site.Params.qa`

When adding new shellbar items or `<script type="module" src="/js/<island>.js">` tags to `hugo/layouts/partials/header.html`, **always wrap them in `{{ if not site.Params.qa }} ... {{ end }}`** unless the corresponding JS chunk is also copied into `hugo/static-qa/js/`.

**Why:** The QA channel's `hugo.qa.toml` sets `staticDir = "static-qa"` (single dir, not an array), so anything served from `/js/...` produces a 404 on QA pages. Joule and other gated features already follow this pattern. Bit us 2026-05-28 in PR #experimental-camera-input — the new `sb-prefs` gear item rendered on QA but `tutorial-prefs.js` 404'd, leaving authors with a dead icon and a console error. Caught in final code review by the superpowers code-reviewer, fixed in commit 96b2ecb before merge.

**How to apply:** Two-step check whenever editing `header.html`:
1. Add new shellbar-item? → `{{ if not site.Params.qa }}<ui5-shellbar-item ...></ui5-shellbar-item>{{ end }}`
2. Add new `<script>` tag for an island? → wrap in the same conditional, OR explicitly extend QA `staticDir` to `["static-qa", "static"]` if you want the chunk to ship to QA too.

Same family as srv-qa cp-list and check-srv-qa-when-changing-srv — QA channel has its own packaging rules and a frontend deviation can fail just as silently as a backend one.

---

## U1 Object Page is the default tutorial layout

The U1 Object Page floorplan (sticky header with title/chips/progress-ring + anchor bar with scroll-spy + 5 sections Overview/Prerequisites/Steps/Resources/Discussion + sticky right-column step navigator) is now the default layout for every tutorial page.

**Why:** Tom validated the prototype 2026-05-22 ("really like it ... idea is solid"). After iterating on the punch list, he confirmed wrap-up: roll U1 out to all 1396 tutorials via Hugo cascade, commit, then move to U2.

**How to apply:**

- Layout: [hugo/layouts/tutorials/u1-object-page.html](../../../hugo/layouts/tutorials/u1-object-page.html)
- Cascade rule: `hugo.toml` → `[[cascade]]` with `_target.path = '/tutorials/**'` and `_target.kind = 'page'` sets `layout = 'u1-object-page'`. Mission/group pages keep their `single.html` because Hugo's type-folder lookup falls back when `layouts/missions/u1-object-page.html` doesn't exist.
- UI5 bootstrap: `TabContainer` + `Tab` imports added to `hugo/assets/js/ui5-bootstrap.ts` so the anchor bar renders without a runtime fetch.
- Branch: `ui-pilot/u1-object-page` (commit `fef1ca5`), branched from the U0/U3/U5 checkpoint `e23b4d2`.
- Worktree: `.worktrees/u1-object-page`.
- Discussion section reuses existing `openTutorialFeedbackPopup(slug)` from `feedback-share.html`.

**Punch list resolved:**
1. Right-column step navigator stays sticky (no internal overflow — that hid the "Steps" heading)
2. Section heading clipping during free-scroll (padding-top 2.5rem + scroll-margin-top 180px)
3. Dark mode visual verified
4. Discussion tab added with Submit feedback + Discuss in Community CTAs
5. Chip overflow fix (prefer human-readable `displayTags`, fall back to raw `primaryTag`)

**Known minor cosmetic items not blocking:**
- Empty Resources subheadings show even when "Next Steps" / "Related Tutorials" lists are empty
- Mini-nav card only renders when tutorial has missionId or groupSlug (by design)
- Local-dev 404s for `nav-dropdown.js`, `mini-navigator.js`, `img-cdn/*` are pre-existing approuter routes, not U1

---

## Vite code-split chunks need `base: '/js/'`

When a hugo-apps island code-splits via dynamic `import()` (e.g. `tutorial-prefs.js` → `chunks/eye-tracking-...js`), Vite's preload helper resolves chunk paths via `base + chunkName`. Default `base: ''` produces `/chunkName` which is rooted at the document URL — on `/` that's `/chunks/...` (404), on `/tutorials/x` that's `/tutorials/chunks/...` (also 404).

**Why:** The approuter serves all hugo-apps bundles at `/js/...` via the catch-all `localDir: "static"` route. The chunks live at `/js/chunks/*`, but without `base` Vite has no idea about that prefix. Static `<script src="/js/...">` tags happen to work because they're absolute. Dynamic imports break.

**How to apply:**
1. In `hugo-apps/vite.config.ts`, set `base: '/js/'` at the top level of `defineConfig`.
2. Verify the rewritten resolver in the built bundle: `grep -oE 'function\([a-z]\)\{return"[^"]*"\+[a-z]\}' hugo/static/js/<island>.js` should print `function(e){return"/js/"+e}`. If it prints `/`, base wasn't picked up.
3. **Don't trust the static `import("./chunks/...")` literal** in the built bundle — that's Vite's dead-code fallback for tooling. The actual runtime path is the preload helper.

Trap that bit us 2026-05-29: Vite emits `hugo/static/js/`, but mbt copies `hugo/public/js/` (Hugo's output) into the approuter. After a Vite rebuild you MUST also run `npm run build:hugo` so Hugo refreshes `public/` from `static/` — `mbt build` alone won't re-run Hugo. See the Hugo-before-mbt rule (template/CSS variant of the same trap).

Symptom: console shows `Failed to load resource: 404` on `/chunks/<name>-<hash>.js` (note: NOT `/js/chunks/...`). The bundle is deployed correctly at `/js/chunks/...`; the URL in the request is wrong.

---

## Vue fragment hydration mismatch (multi-root SFCs)

Vue 3 components without a single wrapping root element are represented as fragments (internally marked `Symbol(v-fgt)`). When you `createSSRApp().mount()` such a component over SSR'd HTML, Vue expects fragment markers (`<!--[-->...<!--]-->`) wrapping the children. If the SSR'd HTML doesn't have those markers (e.g., it was generated by Hugo or another non-Vue templating engine), Vue logs `[Vue warn] Hydration node mismatch` and forces a client-side re-render of the affected subtree — defeating the entire point of SSR (visible flicker on every load).

**Why this matters:** Caught in PR #217 (issue #174 PR 2) by the parity test. `BrowseGrid.vue` used `<template v-for>` as its root to render cards in `#browse-root`; Hugo's `card-{tutorial,mission,group}.html` partials emit flat card markup with no fragment markers. The mismatch was real and would have shipped a visible re-render flicker on every `/browse/` page load.

**Three escape hatches, in order of preference:**

1. **Add a single-element root to the Vue component.** Wrap `<template v-for>` in a `<div>` or similar. Cost: a wrapper element you may not visually want; the SSR'd HTML must be updated to match.
2. **Switch the mount call from `createSSRApp` to `createApp`.** Vue renders fresh client-side instead of hydrating. Cost: a brief mount-time re-render (~50–100 ms) where the SSR'd content is replaced. Benefit: zero structural changes to the Vue or HTML; works when SSR + Vue co-render the same data and a one-frame replacement is acceptable. **This is what PR #217 did.**
3. **Emit fragment markers from the SSR'd template.** Hugo `{{- "<!--[-->" | safeHTML -}}` ... `{{- "<!--]-->" | safeHTML -}}` around the v-for output. Cost: brittle (Vue's marker format may change between minor versions); the markers leak into the rendered HTML even without JS. Avoid unless you genuinely need true hydration with no flicker.

**Detection:** Vue logs `[Vue warn] Hydration node mismatch` to console with `rendered on server: ...` and `expected on client: Symbol(v-fgt)` lines. The hydration parity test in PR #217 catches this via console-spy. Without that test, the warning is easy to miss in development (still works, just flickers) and never surfaces in production logs.

**Rule of thumb:** if a Vue component's root is `<template v-for>`, `<template v-if-else>`, or multiple sibling elements, AND it's mounted via `createSSRApp().mount()` over SSR'd HTML that doesn't come from Vue's own SSR pipeline, expect fragment-mismatch trouble. Either restructure the component (option 1) or switch to `createApp` (option 2).

---

## Vue scoped CSS doesn't propagate to child component descendants

Vue 3's `<style scoped>` adds `[data-v-parentHash]` to (a) every element directly in the parent's template, and (b) the *root* element of each rendered child component. **Descendants inside the child** get the *child's* `[data-v-childHash]`, not the parent's. So when you extract a chunk of inline markup into a child SFC, the parent's scoped rules for descendant selectors silently become dead — they compile to `.foo[data-v-parentHash]` and never match.

**Why:** Caught in PR #206 (issue #174 refactor) by the post-rewire code reviewer. The implementer's claim "No CSS drift; class names byte-identical so existing styles continue to apply" was technically true for class names but operationally false — visual styling broke even though unit tests stayed green (tests don't assert on computed styles).

**How to apply:** When extracting markup from a parent SFC into a child component, audit the parent's `<style scoped>` block for ANY descendant selectors (`.foo .bar`, `.foo__bar`, `.foo--mod`). All of those need to either:
1. Move into the child SFC (cleanest — child owns its own visuals; pairs with the extraction's "design for isolation" goal), OR
2. Move into a shared non-scoped CSS file imported by both the parent and the child (good when the styles are shared across multiple consumers; this is what PR #206 did — `hugo-apps/src/shared/cards/card.css` is imported by `MissionCard.vue` / `GroupCard.vue` / `TutorialCard.vue`), OR
3. Get wrapped in `:deep(.foo__bar)` in the parent (cheapest fix; accumulates `:deep()` calls and only works if the parent is the only consumer).

The component-tests-don't-catch-this means an extra eye on this in code review whenever a refactor pulls markup into a child SFC. Look for the scoped block first, then the child SFC's `<style>` (or lack thereof) second.

---

## Vue scoped `<style>` beats unscoped external CSS (specificity)

When a Vue SFC has `<style scoped>`, Vite's CSS transformer rewrites every selector with an attribute selector `[data-v-XXXXXXXX]` matching that component's scope hash. So a rule like:

```vue
<style scoped>
.progress-ring { position: relative }
</style>
```

becomes:

```css
.progress-ring[data-v-7f3822f3] { position: relative }   /* specificity 0,2,0 */
```

External `.css` files imported via `import './foo.css'` from an SFC are NOT scoped — selectors stay as written.

**The trap:** when a child component (like `ProgressRing.vue`) has scoped styles, and a parent component's external CSS file (like `card.css`) tries to override one of the child's properties, the parent's rule **must reach specificity ≥0,2,0 OR the scoped rule wins**.

`.foo { position: absolute }` (0,1,0) loses to `.bar[data-v-XX] { position: relative }` (0,2,0). Cascade order doesn't help — specificity decides first.

**To override a scoped rule from outside the SFC**, use 0,3,0+:

```css
/* 0,3,0 — wins over scoped 0,2,0 */
.parent-class .child-class.another-class { ... }

/* OR 0,2,0 + later in source order — fragile */
.foo.foo { ... }   /* duplicate-class hack — same specificity */
```

**The bigger lesson:** source-string-only regression tests can't catch cascade bugs. Tests that import the CSS and read `getComputedStyle` would catch them — but Vitest doesn't apply imported CSS to happy-dom (see the Vitest-skips-imported-CSS section below). The reliable way to catch a cascade bug is **a real browser with the deployed bundle** (Playwright on the live deploy, or a screenshot diff in CI).

Surfaced 2026-06-20 by the #399 follow-up. PR #440 moved `.nav-card__progress` from `left:0.75rem` to `right:0.75rem` — correct source, correct deploy, correct browser load. But ProgressRing.vue's scoped `.progress-ring { position: relative }` (0,2,0) beat the unscoped `.nav-card__progress { position: absolute }` (0,1,0). The ring stayed at `position: relative` and never honored `right:0.75rem`. Fix landed as PR #458 — selector bumped to `.nav-card .progress-ring.nav-card__progress` (0,3,0).

When designing CSS that touches a Vue child component's classes, always check whether that component has `<style scoped>` and what specificity it injects. If overriding, plan for ≥0,3,0.

---

## Vue watcher clobbers state restored in `onMounted` (flush: pre)

In Vue 3 SFCs that restore state in `onMounted` (e.g. URL → reactive filters), watch out for an existing `watch(...)` on the same reactive sources that synchronously resets a sibling field. Vue's default `flush: 'pre'` queues watcher callbacks to run AFTER the synchronous block completes but BEFORE DOM update. Sequence:

1. `onMounted` synchronously assigns `filters.types = restored.types` etc.
2. End of synchronous block.
3. Vue scheduler flushes queued watchers — the existing pagination-reset watcher fires, clobbers `currentPage.value = 1`.
4. Now you set `currentPage.value = restored.page` — too late, already overwritten.

Caught by u15-lightbox-style final-review-of-whole-branch in project-issue-195-navigator-url-sync / PR #197 final reviewer. Per-task reviewers couldn't see this because each only saw one watcher per task; the bug only surfaces when the existing watcher (untouched code) and the new restore path are alive at the same time.

**Why:** Per-commit review can't catch interaction-between-existing-and-new-code bugs by construction. Whole-branch review specifically targets this class.

**How to apply:**
- Whenever an `onMounted` rewrite restores reactive state, grep the SFC for any `watch([...filters,...])` callback that mutates ANOTHER reactive field. If found, defer the dependent assignments past the watcher tick:
  ```ts
  searchQuery.value = initial.q
  filters.types     = initial.types
  // ... all filter assignments
  await nextTick()                  // let pagination-reset watcher flush
  currentPage.value = initial.page  // now sticks
  ```
- Keep the writing-plans skill's mandated final-branch-review checkpoint — it caught this defect that 18 prior subagent reviews missed.

---

## Vue island slug source — read `documentElement.dataset.pageSlug`

The convention used by `cmd-palette/actions.ts:121` and `tutorial-breadcrumbs/main.ts:36` (both shipped islands):

```ts
const slug = (document.documentElement.dataset.pageSlug ?? '').toLowerCase();
```

The Hugo `<html>` element gets `data-page-slug="{{ .Params.slug }}"` from `hugo/layouts/_default/baseof.html`.

**Why this matters:** caught 2026-06-04 in #212 spec review. The spec authored by Claude said `document.body.dataset.slug` (which doesn't exist on tutorial pages) and falsely claimed it was the convention used by `tutorial-rating` and `code-check`. Both of those islands actually read slug from their own mount element's `data-slug` attribute (set explicitly by their Hugo partials). Without the fix, every persistence key in #212 would have been `tutorial-validation--<step>` (empty slug) — feature silently broken.

**How to apply:**
- For a Vue island that needs the slug: use `document.documentElement.dataset.pageSlug`.
- If the mount partial explicitly emits `data-slug="..."` on the mount div, reading from `el.dataset.slug` is also acceptable (matches `tutorial-rating`, `code-check`).
- Never read from `document.body.dataset.slug` — `<body>` doesn't have a `data-slug` attribute on this project.
- Always lowercase: `(...).toLowerCase()`. Slugs in HANA are canonical-lowercase; mixing cases breaks lookups.

---

## UI5 boolean attr coercion — `disabled=false` renders truthy

Vue 3's runtime DOM patcher applies `:disabled="pending"` to `<ui5-button>` (a custom element) by calling `setAttribute('disabled', '')` when `pending=false`. UI5 web components read attribute *presence* as truthy regardless of value, so the button renders disabled at mount.

**Verification:** Live in DevTools — `setAttribute('disabled', '')` → `btn.disabled === true`; `setAttribute('disabled', 'false')` → still true; only `removeAttribute('disabled')` actually disables.

**Fix:** Switch `:disabled="pending"` bindings on UI5 web components to `v-bind="pending ? { disabled: true } : {}"`. Vue only emits the attribute when the value is truthy, so `removeAttribute` is the default state.

**Why tests didn't catch it:** happy-dom renders `<ui5-*>` as unknown elements; tests that assert against `wrapper.vm.result` never check the DOM `disabled` attribute on a real upgraded UI5 element. Add a DOM-attribute test that mounts the component and asserts `el.hasAttribute('disabled') === false` at mount and `=== true` after the pending state flips.

**Apply preventatively:** the same `:disabled` pattern in other islands (e.g. `CodeCheck.vue` with `!code.trim()` / `submitting`, `TutorialRating.vue` with `rating === 0` / `state === 'submitting'`) is not currently user-visible because their initial state is `disabled=true` — but a future change to the initial-falsy state would silently regress. Apply the v-bind conditional-spread pattern preventatively.

---

## Vitest skips imported CSS (`getComputedStyle` returns empty)

When testing layout/CSS contracts in Vitest with `@vitest-environment happy-dom` (or jsdom), imported CSS files (e.g. `import './card.css'` in an SFC) do NOT get applied to the test DOM. Vite's css-transformer treats them as side-effect imports and stubs them in the test runner.

**Symptom:** `getComputedStyle(el).paddingLeft` returns empty string `""` for both ringed and non-ringed elements, so an assertion like `expect(a.paddingLeft).toBe(b.paddingLeft)` passes tautologically (`'' === ''`) regardless of the real CSS rule. You'll see green tests that don't actually exercise the contract.

**Fix:** Don't try to validate computed styles in Vitest. Read the CSS file as a string via Node's `fs` and assert against the source-text shape. Resolve the path via `process.cwd()` (Vitest runs from the project root or the configured `--root`); `import.meta.url` doesn't yield a `file://` scheme inside Vite's test runner.

```ts
import { describe, expect, it, beforeEach } from 'vitest'

describe('CSS shape', () => {
  let css: string
  beforeEach(async () => {
    if (!css) {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const p = path.resolve(process.cwd(), 'hugo-apps/src/shared/cards/card.css')
      css = fs.readFileSync(p, 'utf-8')
    }
  })

  it('does not contain a regression rule', () => {
    expect(css).not.toMatch(/\.nav-card--has-progress\s+\.nav-card__title[^{]*\{[^}]*padding-left/s)
  })
})
```

This is a layer below `getComputedStyle` semantically — you're asserting the rule is or isn't in the file, not that the browser would compute X — but it's honest about what the test environment can prove and the contract is the same. For real visual verification, run `npm run dev` locally and look at the page.

Surfaced 2026-06-19 by #399 / PR #440. First test passed when it should have failed; investigation showed both `paddingLeft` reads were `""`. Pivoted to source-string assertion and got proper RED → GREEN.

---

## CSP: WebAssembly needs the wasm-specific eval token in `script-src`

When a WebAssembly-using island (MediaPipe, Pyodide, wa-sqlite, …) ships behind a tight CSP, add the WASM-specific eval token to `script-src` — NOT the general JS-eval one. CSP3 split them: the WASM token permits `WebAssembly.instantiate` / `instantiateStreaming` without unlocking JavaScript code-evaluation.

Symptoms when missing:
- Console: "Compiling or instantiating WebAssembly module violates the following Content Security policy directive because [JS-eval token] is not an allowed source of script…"
- Companion 404 ERR_ABORTED on the wasm asset URL — Chrome aborts the in-flight fetch when streaming compile fails. Misleading; the asset is actually deployed.
- Followed by Emscripten's "falling back to ArrayBuffer instantiation" then "Aborted(CompileError…)" — same root cause, different layer of MediaPipe's loader.

**Why:** The Hugo approuter ships a deliberately tight CSP (no blanket JS-eval token, no `https:` wildcards — see the SAP corporate CMP reference for the contrast with AEM). Wasm-using features must opt in explicitly with the WASM-specific token.

**How to apply:** Edit `approuter/xs-app.json` `responseHeaders[0].value` and add the WASM token (the one with `wasm-` prefix in front of the eval keyword) to the `script-src` token list. Verify with `curl -sI <approuter-url>/ | grep content-security-policy`. Confirmed live 2026-05-29 for the `tutorial-prefs` eye-tracking + hand-gesture features.

Related: the QA-gate frontend script tags section — the same `tutorial-prefs` island is QA-gated, so QA approuter is unaffected; only the prod approuter CSP needs this.

---

## Flexbox atomizes inline prose into anonymous flex items

CSS3 Flexbox §4: when a flex container holds mixed inline content (text runs + inline elements like `<a>`, `<code>`, `<strong>`), each contiguous text run AND each inline element becomes a separate **anonymous flex item**. With `gap: NNrem` (or `justify-content: space-between` etc.) those fragments visually separate into "columns" — one sentence becomes a row of disconnected pieces.

**Why:** the gap/spacing is intended for the icon-vs-text relationship, but flex doesn't know the difference between "icon child" and "text-content child" — it treats everything siblings of the icon as flex items, including each text node.

**How to apply:**
- Any layout that puts `display: flex` on a wrapper containing markdownify/markdown-rendered prose MUST wrap the prose in a single child element (`<span>`, `<div>`).
- After the wrap, the flex container has exactly TWO flex items (icon + text-wrapper); the text-wrapper's internal inline structure flows as normal inline content, and `gap` still produces icon-text spacing.
- Plain-prose lists won't surface the bug (one text run = one flex item) — review specifically against bullets/cells/items containing `[link]` or `` `code` ``.

**Witness:** issue #163 / PR #182. `.you-will-learn li` was a flex container; bullets with `<a>` and `<code>` rendered as visible "columns" until each bullet's text was wrapped in `<span class="check-text">`. Affected ~20+ tutorials; plain-prose bullets had hidden the regression.

**Where to look in this codebase next:** any partial that uses `display: flex` on a list item or row AND interpolates `{{ . | markdownify }}` or `{{ .Param | markdownify }}` directly as a child. Examples to audit: `tutorial-prerequisites.html`, anywhere an `<li>` or `<dt>/<dd>` is a flex container.

---

## `extractSection` regex swallows trailing `---` HRs

`extractSection(content, heading)` and its sibling `extractBulletList` in `scripts/parsers/frontmatter.ts` use the regex pattern:

```
## ${heading}\s*\n([\s\S]*?)(?=\n## |\n### |$)
```

The lookahead stops at the **next heading** or **end of string** — not at markdown thematic breaks (`---`, `___`, `***`). When source markdown closes a section with an HR before the first step (very common in SAP tutorials — `## Prerequisites` … list … blank line … `---` … `### Step heading`), the HR text gets captured into the section body.

**Why this matters:**
- For `splitPrerequisites`, the HR `---` survives the `^\s*-\s+` strip (no whitespace after the dash → no match → unchanged), then escapeHtml is a no-op on `---`, then it passes the `length > 0` filter, and emerges as a prereq bullet.
- The Hugo prereq partial pipes each bullet through `markdownify`, where standalone `---` becomes `<hr>` inside the `<li>` — a stray rule under the prereqs.

**How to apply:**
- When **adding a new top-level frontmatter section** that uses `extractSection`/`extractBulletList`, expect `---` HRs to leak in. Either:
  1. Filter the consumer (preferred, surgical — what PR #182 did with `^-{3,}$` in `splitPrerequisites`), OR
  2. Tighten the regex to also stop at `\n---\n` (broader; affects every caller, audit before doing).
- **Don't over-filter:** `^-{3,}$` rejects standalone HR lines but keeps prose containing dashes (`--force`, `A-B-C`). The unit test in `test/parsers/frontmatter-utils.test.ts` includes the over-filter guard explicitly.
- Run `grep -l '  - ---' hugo/content/tutorials/*.md` after a regenerate to spot the regression — already-generated `.md` files don't fix retroactively until `rebuild-content.yml` runs.

**Witness:** issue #163 / PR #182, fix 2 of 2. 20+ tutorials had `- ---` as a prereq bullet before the filter landed.
