# Hugo Migration Design Spec

**Date:** 2026-04-28  
**Status:** Approved  
**Scope:** Migrate from VitePress to Hugo while preserving all functionality, look, and feel.

---

## Summary

Replace VitePress with Hugo as the static site generator for the SAP Tutorial Platform. Hugo builds 1370+ tutorial pages in <10 seconds (vs. 190+ seconds with VitePress) using <1GB memory (vs. 8-16GB). The migration preserves all existing functionality: SAP Fundamental Styles theming, step accordion interactivity, progress tracking, search/filter navigator, AppSpace event views, and BTP Cloud Foundry deployment via MTA.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Client-side interactivity | Hybrid: vanilla TS for tutorials, Vue mini-apps for Navigator/AppSpace | Tutorial steps are simple DOM toggles; Navigator and AppSpace have complex reactive state |
| Migration approach | Parallel coexistence (`hugo/` alongside `site/.vitepress/`) | Compare output, validate parity before removing VitePress |
| Vue mini-app bundling | Separate Vite project (`apps/`) builds to `hugo/static/js/` | SFC support, TypeScript, hot reload, tree-shaking — output is just static JS |
| Tutorial JS bundling | Hugo's built-in `js.Build` (esbuild) | No node_modules needed, TypeScript native, tiny output |

---

## Project Structure

```
tutorials-poc/
├── hugo/                            ← Hugo site root
│   ├── hugo.toml                    ← Hugo configuration
│   ├── content/
│   │   └── tutorials/              ← Generated markdown (Hugo shortcode format)
│   ├── layouts/
│   │   ├── _default/
│   │   │   ├── baseof.html         ← Base template (head, nav, footer shell)
│   │   │   └── list.html           ← Default list (required by Hugo)
│   │   ├── tutorials/
│   │   │   └── single.html         ← Tutorial page layout
│   │   ├── missions/
│   │   │   └── single.html         ← Mission page layout
│   │   ├── groups/
│   │   │   └── single.html         ← Group page layout
│   │   ├── page/
│   │   │   ├── app-space.html      ← AppSpace page (Vue mount point)
│   │   │   └── event-display.html  ← EventDisplay page
│   │   ├── index.html              ← Home page (Navigator mount point)
│   │   ├── shortcodes/
│   │   │   ├── tutorial-step.html  ← Step accordion shortcode
│   │   │   ├── option-tabs.html    ← Tab container shortcode
│   │   │   └── tab.html            ← Individual tab panel shortcode
│   │   └── partials/
│   │       ├── head.html           ← <head> with CSS, meta, fonts
│   │       ├── header.html         ← Top nav bar
│   │       ├── breadcrumbs.html    ← Tutorial breadcrumb bar
│   │       ├── tutorial-meta.html  ← Level, time, tags row
│   │       ├── tutorial-sidebar.html ← Step TOC sidebar
│   │       ├── progress-bar.html   ← Placeholder for client-side progress
│   │       ├── feedback-share.html ← Action bar with prev/next + share
│   │       └── footer.html
│   ├── static/
│   │   ├── css/
│   │   │   ├── sap-fundamental.css ← SAP Fundamental Styles
│   │   │   └── sap-theme-vars.css  ← SAP Horizon CSS custom properties
│   │   ├── js/                     ← Output from Vite build (mini-apps)
│   │   └── tutorials/
│   │       └── _nav.json           ← Navigation data
│   └── assets/
│       └── js/
│           └── tutorial.ts         ← Vanilla TS: step toggle, done, progress
│
├── apps/                            ← Vue mini-apps (Vite project)
│   ├── package.json
│   ├── vite.config.ts
│   ├── src/
│   │   ├── navigator/
│   │   │   ├── main.ts            ← Mount point for TutorialNavigator
│   │   │   └── TutorialNavigator.vue
│   │   ├── app-space/
│   │   │   ├── main.ts            ← Mount point for AppSpace
│   │   │   └── AppSpace.vue
│   │   ├── event-display/
│   │   │   ├── main.ts
│   │   │   └── EventDisplay.vue
│   │   ├── nav-dropdown/
│   │   │   ├── main.ts            ← Mounts on every tutorial page breadcrumb
│   │   │   └── TutorialNavigatorDropdown.vue
│   │   └── shared/
│   │       ├── useApi.ts           ← API composable
│   │       └── types.ts
│   └── tsconfig.json
│
├── scripts/                         ← Modified: dual output support
│   ├── fetch-tutorials.ts          ← Adds --target hugo flag
│   ├── parsers/                    ← Unchanged
│   └── generate-nav.ts            ← Extracted nav JSON generation
│
├── site/                            ← Kept until Hugo achieves parity, then removed
├── display-app/                     ← Unchanged
├── approuter/                       ← Unchanged
└── mta.yaml                         ← Modified: Hugo build commands
```

---

## Content Generation Pipeline

```
GitHub API (sap-tutorials org)
     │
     ▼
.tutorial-cache/ (raw markdown + metadata)
     │
     ▼
parsers/frontmatter.ts → parsers/v1.ts or v2.ts → parsers/images.ts
     │
     ▼
convertOptionBlocks() — MUST be target-aware (see below)
     │
     ▼
writeHugoPage()  ← NEW function (writeVitePressPage kept during migration)
     │
     ▼
hugo/content/tutorials/{slug}.md  +  hugo/static/tutorials/_nav.json
```

### Modifications to `fetch-tutorials.ts`

This is **substantial surgery**, not a minor flag addition. The following must be modified:

1. **`main()` function:** Add `--target hugo` argument parsing. Branch on target to set:
   - `OUTPUT_DIR` → `hugo/content/tutorials/` (instead of `site/tutorials/`)
   - `NAV_OUTPUT` → `hugo/static/tutorials/_nav.json`
   - Call `writeHugoPage()` instead of `writeVitePressPage()`

2. **`convertOptionBlocks()` in `parsers/options.ts`:** Must become target-aware. Currently outputs Vue slot syntax (`<OptionTabs :tabs="[...]"><template #tab-0>...</template></OptionTabs>`). For Hugo target, must output Hugo shortcode syntax directly:

   ```text
   {{% option-tabs tabs="Video,Written Instructions" %}}
   {{% tab index="0" name="Video" %}}
   content...
   {{% /tab %}}
   {{% tab index="1" name="Written Instructions" %}}
   content...
   {{% /tab %}}
   {{% /option-tabs %}}
   ```
   This is critical because option blocks are converted INSIDE step content before step wrapping occurs. If `convertOptionBlocks()` still outputs Vue syntax, the Hugo shortcode form of `tutorial-step` will receive raw Vue tags that render as literal text.

3. **`patchTutorialFrontmatter()`:** Must be target-aware. Currently writes to hardcoded `OUTPUT_DIR`. For Hugo, must write to `hugo/content/tutorials/` and use Hugo-compatible frontmatter keys (e.g., `type: tutorials` instead of `layout: tutorial`).

4. **`writeHugoPage()` (new function):** Wraps steps in `{{% tutorial-step %}}` shortcode syntax. Does NOT re-process option blocks (already converted by step 2).

### Content Format Transformation

| Concern | VitePress output | Hugo output |
|---------|-----------------|-------------|
| Step wrapping | `<TutorialStep :number="1" title="..." slug="...">` | `{{% tutorial-step number="1" title="..." %}}` |
| Option tabs | `<OptionTabs :tabs="[...]">` + `<template #tab-N>` | `{{% option-tabs tabs="A,B" %}}` + `{{% tab index="0" name="A" %}}` |
| Frontmatter layout | `layout: tutorial` | `type: tutorials` (directory-based) |
| HTML escaping | Aggressive (Vue template compiler) | Minimal (Goldmark passes through raw HTML) |

**Important:** Hugo shortcode form must use `{{% %}}` (percent signs), NOT `{{< >}}` (angle brackets). The percent form tells Hugo to process inner content as markdown AND process nested shortcodes. The angle bracket form does NOT render markdown in inner content.

### `{{` Delimiter Scanning

Some tutorials contain Go templates, Mustache, or workflow syntax with `{{`. The content generation phase scans for `{{` outside of code fences and wraps affected content in Hugo's raw string shortcode. A warning is emitted during generation for manual verification.

### What Becomes Unnecessary

- `sanitizeStepContent()` — Hugo doesn't compile HTML as Vue templates
- `balanceComponentTags()` — No component tag matching
- `escapeHtmlTags()` — Only shortcode delimiters need attention

### What Must Be Refactored (Not Removed)

- `convertOptionBlocks()` — target-aware: Vue syntax for VitePress, Hugo shortcodes for Hugo
- `patchTutorialFrontmatter()` — target-aware: different output dir and frontmatter keys

### Parallel Coexistence During Migration

During the migration period, `fetch-tutorials.ts` supports both targets:
- `npm run fetch-tutorials` (no flag) — existing VitePress output to `site/tutorials/`
- `npm run fetch-tutorials -- --target hugo` — Hugo output to `hugo/content/tutorials/`

Both share the same `.tutorial-cache/` and AEM cache, so running both targets does not require double-fetching from GitHub. Only the final write step differs.

---

## Hugo Templates & Shortcodes

### Base Template (`baseof.html`)

```html
<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  {{ partial "head.html" . }}
</head>
<body>
  {{ partial "header.html" . }}
  <main>{{ block "main" . }}{{ end }}</main>
  {{ partial "footer.html" . }}
</body>
</html>
```

### Tutorial Single Layout (`tutorials/single.html`)

Replaces `TutorialLayout.vue`. Static parts (title, meta, author, prerequisites, breadcrumbs, sidebar TOC) rendered by Hugo at build time. Dynamic parts (progress bar, step completion) are placeholder divs hydrated by `tutorial.ts`.

```html
{{ define "main" }}
{{ partial "breadcrumbs.html" . }}
{{ partial "feedback-share.html" . }}

<div class="tutorial-page">
  <main class="tutorial-main">
    <h1 class="tutorial-title">{{ .Title }}</h1>
    {{ partial "tutorial-meta.html" . }}
    <p class="tutorial-description">{{ .Params.description }}</p>

    {{ with .Params.youWillLearn }}
    <div class="you-will-learn">
      <h3>You will learn</h3>
      <ul>{{ range . }}<li><span class="check-icon">✔</span> {{ . | markdownify }}</li>{{ end }}</ul>
    </div>
    {{ end }}

    {{ partial "tutorial-author.html" . }}
    {{ partial "tutorial-prerequisites.html" . }}

    <div id="progress-bar" data-step-count="{{ .Params.stepCount }}" data-slug="{{ .Params.slug }}"></div>

    <div class="step-controls">
      <a href="#" onclick="expandAllSteps(); return false">Open all</a>
      <a href="#" onclick="collapseAllSteps(); return false">Close all</a>
    </div>

    <div class="tutorial-steps">{{ .Content }}</div>

    {{ partial "tutorial-nav-bottom.html" . }}
  </main>
  {{ partial "tutorial-sidebar.html" . }}
</div>

{{ with .Params.steps }}
<script id="tutorial-data" type="application/json">{{ . | jsonify }}</script>
{{ end }}
{{ end }}
```

### Shortcode: `tutorial-step.html`

**Important:** This shortcode is invoked with the `{{% %}}` form in content files. Hugo renders the inner content as markdown AND processes nested shortcodes before passing `.Inner` to this template. Therefore, `.Inner` already contains rendered HTML — do NOT pipe through `markdownify`.

```html
{{ $number := .Get "number" }}
{{ $title := .Get "title" }}
{{ $isFirst := eq $number "1" }}

<div id="step-{{ $number }}" class="tutorial-step" data-step="{{ $number }}">
  <div class="step-header" data-action="toggle-step">
    <span class="step-check-circle"></span>
    <div class="step-header-text">
      <span class="step-label">Step {{ $number }}</span>
      <span class="step-title-text">{{ $title }}</span>
    </div>
    <span class="step-toggle-icon">{{ if $isFirst }}—{{ else }}+{{ end }}</span>
  </div>
  <div class="step-body"{{ if not $isFirst }} hidden{{ end }}>
    <hr class="step-divider" />
    <div class="step-content">{{ .Inner }}</div>
    <div class="step-validation-mount" data-step="{{ $number }}"></div>
    <div class="step-actions">
      <button class="fd-button fd-button--emphasized" data-action="mark-done" data-step="{{ $number }}">Done</button>
    </div>
  </div>
</div>
```

### Shortcode: `option-tabs.html`

Also invoked with `{{% %}}` form. `.Inner` contains the already-processed nested `tab` shortcodes.

```html
{{ $tabs := split (.Get "tabs") "," }}
<div class="option-tabs" data-component="tabs">
  <div class="fd-tabs" role="tablist">
    {{ range $i, $tab := $tabs }}
    <button class="fd-tabs__item{{ if eq $i 0 }} is-selected{{ end }}" role="tab" data-tab-index="{{ $i }}">{{ $tab }}</button>
    {{ end }}
  </div>
  <div class="tab-panels">{{ .Inner }}</div>
</div>
```

### Shortcode: `tab.html`

The tab index is passed explicitly as a parameter (not derived from `.Ordinal`, which gives page-level position, not sibling position). The `index` param is generated by `convertOptionBlocks()` during content generation.

```html
{{ $index := .Get "index" }}
{{ $name := .Get "name" }}
<div class="tab-panel" data-tab-panel="{{ $index }}" data-tab-name="{{ $name }}"{{ if ne $index "0" }} hidden{{ end }}>
  {{ .Inner }}
</div>
```

---

## Client-Side JavaScript Architecture

### Layer 1: `tutorial.ts` (Vanilla TypeScript)

Bundled by Hugo's `js.Build` (esbuild). ~600-700 lines. No framework.

**Responsibilities:**
- Step accordion toggle (expand/collapse via `hidden` attribute)
- "Open all" / "Close all" controls
- "Done" button → POST `/api/tutorials/{slug}/steps/{n}/complete`
- Progress bar update
- Step TOC sidebar completion highlighting
- **Validation quiz widget** (see below)
- Load progress on page init → GET `/api/tutorials/{slug}/progress`

**Validation Quiz Widget (~200 lines):**

This reimplements `StepValidation.vue` in vanilla TS. On page load, reads the `#tutorial-data` JSON which contains step data including `validation` arrays. For each step that has validation questions:

1. Renders into `.step-validation-mount[data-step="N"]` a form with:
   - Multiple-choice: radio inputs in styled option cards
   - Text: text input field
2. Submit button validates answers client-side (same logic as current: exact match for multiple-choice, case-insensitive for text)
3. On failure: shows error message, allows retry
4. On success: shows success message, **enables the Done button** (which starts disabled when validation exists)
5. The Done button's `disabled` state is controlled by checking `data-validated="true"` on the step element

**Data flow for validation:**

```text
Hugo template → <script id="tutorial-data" type="application/json">
                  [{ number: 1, title: "...", validation: [{ id, question, type, options, correctAnswer }] }, ...]
                </script>

tutorial.ts → on DOMContentLoaded:
  1. Parse #tutorial-data JSON
  2. For each step with validation[].length > 0:
     - Set Done button to disabled
     - Render quiz form into .step-validation-mount
  3. On quiz submit: validate, if correct → enable Done button
```

**Pattern:** Event delegation on `document.body` via `data-action` attributes.

```typescript
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  const stepHeader = target.closest('[data-action="toggle-step"]')
  if (stepHeader) { toggleStep(stepHeader); return }
  const doneBtn = target.closest('[data-action="mark-done"]')
  if (doneBtn) { markDone(doneBtn as HTMLButtonElement); return }
  const tabBtn = target.closest('[role="tab"]')
  if (tabBtn) { switchTab(tabBtn as HTMLButtonElement); return }
})
```

**API helper:**

```typescript
const API_BASE = document.documentElement.dataset.apiBase || '/api'

async function apiGet<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API_BASE}${path}`)
  return res.ok ? res.json() : null
}

async function apiPost(path: string, body?: unknown): Promise<boolean> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.ok
}
```

### Layer 2: Vue Mini-Apps (Vite → static JS)

**Vite config (`apps/vite.config.ts`):**

```typescript
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: '../hugo/static/js',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        navigator: resolve(__dirname, 'src/navigator/main.ts'),
        'app-space': resolve(__dirname, 'src/app-space/main.ts'),
        'event-display': resolve(__dirname, 'src/event-display/main.ts'),
        'nav-dropdown': resolve(__dirname, 'src/nav-dropdown/main.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
})
```

**Mount pattern:**

```typescript
import { createApp } from 'vue'
import TutorialNavigator from './TutorialNavigator.vue'

const el = document.getElementById('tutorial-navigator')
if (el) createApp(TutorialNavigator).mount(el)
```

**Porting changes from current Vue components:**

- Remove `import { useData } from 'vitepress'` — not available outside VitePress
- Remove VitePress `ClientOnly` wrapper — not needed in client-only apps
- `useApi.ts` stays identical
- AppSpace: `activeTheme` is already set by URL param `?theme=joule|sapphire` (no change needed). The `isDark` import from `useData()` can be replaced with reading `document.documentElement.dataset.theme`
- NavDropdown: receives `currentSlug` as a data attribute on its mount element; reads mission navigation from API call (same as current)

### Layer 3: Dark Mode

Same CSS custom property approach. Inline script in `head.html` reads `localStorage`/`prefers-color-scheme` before paint:

```html
<script>
  const t = localStorage.getItem('theme') ||
    (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = t;
</script>
```

SAP Horizon CSS variables define both light and dark tokens keyed on `[data-theme="dark"]`.

---

## Build Pipeline & Deployment

### Package.json Scripts

```json
{
  "scripts": {
    "fetch-tutorials": "tsx scripts/fetch-tutorials.ts --target hugo",
    "fetch-tutorials:vitepress": "tsx scripts/fetch-tutorials.ts",
    "build:apps": "npm --prefix apps run build",
    "build:hugo": "hugo --source hugo --minify",
    "build:display": "npm --prefix display-app run build",
    "build:static": "mkdir -p approuter/static && cp -r hugo/public/* approuter/static/ && cp -r display-app/dist approuter/static/display-app",
    "build": "npm run fetch-tutorials -- --regenerate && npm run build:apps && npm run build:hugo && npm run build:display && npm run build:static",
    "dev": "npm run fetch-tutorials && npm run build:apps && hugo server --source hugo",
    "dev:apps": "npm --prefix apps run dev"
  }
}
```

Note: `hugo --source hugo` tells Hugo the site root is `./hugo/`. Output goes to `hugo/public/`.

### Build Order

```
fetch-tutorials (--target hugo) → build:apps (Vite) → build:hugo (hugo --minify) → build:display → copy to approuter/static/
```

### MTA Build Phase

```yaml
build-parameters:
  before-all:
    - builder: custom
      commands:
        - curl -fsSL https://github.com/gohugoio/hugo/releases/download/v0.147.0/hugo_extended_0.147.0_linux-amd64.tar.gz | tar -xz -C /tmp hugo
        - npm install
        - npm --prefix apps install
        - npm run fetch-tutorials -- --regenerate --target hugo
        - npm run build:apps
        - /tmp/hugo --source hugo --minify
        - npm --prefix display-app install
        - npm --prefix display-app run build
        - mkdir -p approuter/static
        - cp -r hugo/public/* approuter/static/
        - cp -r display-app/dist approuter/static/display-app
```

### Hugo Binary in CI

- **GitHub Actions:** `peaceiris/actions-hugo@v2` action installs Hugo in ~2 seconds
- **MTA Build Service (SAP BTP):** The container runs Linux x86_64. Download the Hugo extended binary directly in the build phase (shown above). The binary is ~50MB compressed, extracts to `/tmp/hugo`, and is invoked by absolute path. Pin the version to avoid drift.

### Dev Server

Use `hugo server` for template/content development. For API proxy, run CAP backend separately (`cds watch`) and configure the Vue mini-apps' API base to point at `localhost:4004` during development.

### Hugo Configuration (`hugo.toml`)

```toml
baseURL = '/'
languageCode = 'en-us'
title = 'SAP Tutorial Platform'

[build]
  writeStats = true

[markup]
  [markup.goldmark]
    [markup.goldmark.renderer]
      unsafe = true
    [markup.goldmark.extensions]
      [markup.goldmark.extensions.passthrough]
        enable = true
        [markup.goldmark.extensions.passthrough.delimiters]
          block = [['$$', '$$']]
          inline = [['$', '$']]

[outputs]
  home = ['HTML']

[params]
  apiBase = '/api'
```

**Note on `outputs.home`:** Hugo's JSON output type is NOT used. The `_nav.json` file is generated directly by the fetch script into `hugo/static/tutorials/`, not by Hugo's output formats. The `['HTML']` setting is intentional.

---

## Migration Phases

### Phase 1: Hugo Skeleton + First Tutorial (1 day)

- `hugo/` directory with `hugo.toml`, base template, tutorial single layout
- Shortcodes: `tutorial-step.html`, `option-tabs.html`, `tab.html`
- SAP Fundamental Styles CSS in `hugo/static/css/`
- One tutorial manually converted, renders correctly

**Acceptance:** Single tutorial page loads with correct styling, step accordions visible.

### Phase 2: Content Generation (1 day)

- `fetch-tutorials.ts` gets `--target hugo` flag
- `writeHugoPage()` outputs shortcode syntax
- `{{` scanner flags and wraps affected content
- `_nav.json` generated to `hugo/static/tutorials/`
- All 1370+ tutorials build with `hugo --minify`

**Acceptance:** Hugo build completes in <10 seconds, zero errors. Spot-check 10 tutorials.

### Phase 3: Client-Side Tutorial Interactivity (2 days)

- `hugo/assets/js/tutorial.ts` — step toggle, done button, progress, validation
- Progress bar renders after API call
- Step TOC sidebar highlights completed steps
- Dark mode toggle

**Acceptance:** Full tutorial workflow functions end-to-end with local CAP backend.

### Phase 4: Vue Mini-Apps (2 days)

- `apps/` Vite project with Navigator, AppSpace, EventDisplay, NavDropdown
- Components ported from current `.vue` files
- `TutorialNavigatorDropdown` mounted on every tutorial page via `nav-dropdown.js` (loaded in `tutorials/single.html` template)
- Vite builds to `hugo/static/js/`
- Hugo templates mount apps

**Acceptance:** Navigator search/filter/cards work identically. AppSpace themes render correctly.

### Phase 5: Feature Parity & Polish (1 day)

- Breadcrumbs, Previous/Next, FeedbackShareBar
- Mission and Group layout pages
- Responsive breakpoints verified
- MiniNavigator dropdown

**Acceptance:** Side-by-side visual parity with VitePress output.

### Phase 6: Deployment & Cleanup (0.5 day)

- Updated `mta.yaml`, CI workflows
- Hugo binary provisioning
- Remove VitePress dependencies and `site/.vitepress/`
- Updated documentation

**Acceptance:** Production deploy succeeds, all pages accessible.

### Total Estimated Effort: ~7.5 days

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `{{` in tutorial content breaks Hugo | Medium | Scanner in Phase 2 detects and wraps in raw blocks |
| Goldmark renders markdown differently | Medium | Spot-check in Phase 2; `unsafe = true` in config |
| Vue mini-app hydration flash | Low | Skeleton UI in Hugo template visible immediately |
| Hugo binary not in MTA build env | Low | Download in build phase; fallback: commit to repo |
| Team unfamiliarity with Go templates | Medium | Templates are simple; most logic is in JS layer |

## What We Keep

- `scripts/parsers/` (all parser logic unchanged)
- SAP Fundamental Styles CSS
- `display-app/` (unchanged)
- `approuter/` (unchanged)
- `mta.yaml` structure (swap build command)
- Dark mode CSS variables and theme system
- Vue components for Navigator/AppSpace (ported to `apps/`)

## What We Lose

- Vue component reactivity on tutorial pages (replaced with vanilla JS)
- Hot module replacement for Vue components during template dev (Hugo has live reload)
- Type-safe component props (shortcodes are string-based)

## What We Gain

- **3-8 second builds** instead of 190+ seconds
- **< 1GB memory** instead of 8-16GB
- **No Vue template compilation errors** from raw HTML in markdown
- **Simpler CI** — no NODE_OPTIONS, no memory tuning
- **Faster dev iteration** — instant rebuild on template/content change
