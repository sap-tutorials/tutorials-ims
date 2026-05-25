# Hugo Migration Plan

## Why Hugo

VitePress compiles every `.md` file as a Vue Single File Component, running the full Vue template compiler and SSR renderer for each page. At 1370+ tutorials with ~8 steps each, this creates ~11,000 component instances during build. Even with optimizations (`v-if`, `ClientOnly`, disabled source maps), build time is ~190 seconds locally and risks timeout on CI runners with less memory/CPU.

Hugo is a compiled Go binary that renders markdown to HTML using Go templates. It routinely builds 5,000+ page sites in under 10 seconds. For a content-heavy tutorial site where interactivity is limited to the client, Hugo eliminates the fundamental bottleneck: there is no JavaScript compilation or SSR phase during build.

---

## Architecture Comparison

| Concern | VitePress (current) | Hugo (target) |
|---------|-------------------|---------------|
| Build tool | Node.js + Vite + Vue compiler | Go binary (single executable) |
| Markdown engine | markdown-it + Vue SFC compilation | Goldmark (CommonMark compliant) |
| Templating | Vue 3 SFCs (`.vue` files) | Go `html/template` (`.html` files) |
| Components in markdown | Vue components (`<TutorialStep>`) | Hugo shortcodes (`{{</* tutorial-step */>}}`) |
| Styling | Scoped CSS in Vue SFCs + global CSS | Global CSS (same SAP Fundamental Styles) |
| Client interactivity | Vue hydration (full SPA) | Vanilla JS or bundled Vue/Alpine app |
| Build time (1370 pages) | ~190 seconds | Expected: 3-8 seconds |
| Memory usage | 8-16 GB | < 1 GB |

---

## Project Structure Mapping

### Current (VitePress)

```
tutorials-poc/
├── site/
│   ├── .vitepress/
│   │   ├── config.ts
│   │   └── theme/
│   │       ├── index.ts
│   │       ├── components/
│   │       │   ├── TutorialStep.vue
│   │       │   ├── OptionTabs.vue
│   │       │   ├── TutorialLayout.vue
│   │       │   ├── TutorialNavigator.vue
│   │       │   ├── ProgressBar.vue
│   │       │   ├── PointsBadge.vue
│   │       │   ├── FeedbackShareBar.vue
│   │       │   └── AppSpace.vue
│   │       ├── composables/
│   │       │   └── useApi.ts
│   │       └── styles/
│   │           └── sap-fundamental.css
│   ├── tutorials/           ← generated markdown pages
│   ├── index.md             ← TutorialNavigator page
│   └── app-space.md         ← AppSpace page
├── scripts/
│   ├── fetch-tutorials.ts   ← fetches from GitHub
│   ├── validate-tutorials.ts
│   └── parsers/
└── package.json
```

### Target (Hugo)

```
tutorials-poc/
├── hugo/                        ← Hugo site root
│   ├── hugo.toml                ← Hugo configuration
│   ├── content/
│   │   └── tutorials/          ← generated markdown (Hugo format)
│   ├── layouts/
│   │   ├── _default/
│   │   │   └── baseof.html     ← base template (head, body shell)
│   │   ├── tutorials/
│   │   │   └── single.html     ← tutorial page layout
│   │   ├── index.html          ← home page (TutorialNavigator)
│   │   └── partials/
│   │       ├── head.html
│   │       ├── header.html
│   │       ├── footer.html
│   │       ├── tutorial-sidebar.html
│   │       └── tutorial-meta.html
│   ├── shortcodes/
│   │   ├── tutorial-step.html
│   │   └── option-tabs.html
│   ├── static/
│   │   └── css/
│   │       └── sap-fundamental.css
│   └── assets/
│       └── js/
│           ├── tutorial-app.ts  ← client-side Vue/Alpine app
│           ├── navigator.ts     ← search/filter logic
│           └── progress.ts      ← step completion + API calls
├── scripts/
│   ├── fetch-tutorials.ts       ← mostly unchanged
│   ├── generate-hugo-content.ts ← NEW: converts parsed tutorials to Hugo format
│   └── parsers/                 ← unchanged
├── display-app/                 ← unchanged
└── package.json
```

---

## Component Conversion

### TutorialStep → Shortcode

**Current (Vue component in markdown):**
```html
<TutorialStep :number="1" title="Set up the agent" slug="my-tutorial">

Markdown content here...

</TutorialStep>
```

**Hugo shortcode (`layouts/shortcodes/tutorial-step.html`):**
```html
{{< tutorial-step number="1" title="Set up the agent" >}}

Markdown content here...

{{< /tutorial-step >}}
```

**Shortcode implementation:**
```html
{{ $number := .Get "number" }}
{{ $title := .Get "title" }}
{{ $expanded := eq $number "1" }}

<div class="tutorial-step" data-step="{{ $number }}" data-expanded="{{ $expanded }}">
  <div class="step-header" onclick="toggleStep(this)">
    <span class="step-number">Step {{ $number }}</span>
    <span class="step-title-text">{{ $title }}</span>
    <span class="step-toggle-icon">{{ if $expanded }}—{{ else }}+{{ end }}</span>
  </div>
  <div class="step-body" {{ if not $expanded }}style="display:none"{{ end }}>
    <hr class="step-divider" />
    <div class="step-content">
      {{ .Inner | markdownify }}
    </div>
    <div class="step-actions">
      <button class="fd-button fd-button--emphasized step-done-btn"
              data-step="{{ $number }}"
              onclick="markStepDone(this)">Done</button>
    </div>
  </div>
</div>
```

### OptionTabs → Shortcode

**Current (Vue component):**
```html
<OptionTabs :tabs="['Video','Written Instructions']">
<template #tab-0>
Video content...
</template>
<template #tab-1>
Written content...
</template>
</OptionTabs>
```

**Hugo shortcode approach:**
```html
{{< option-tabs tabs="Video,Written Instructions" >}}

{{< tab "Video" >}}
Video content...
{{< /tab >}}

{{< tab "Written Instructions" >}}
Written content...
{{< /tab >}}

{{< /option-tabs >}}
```

**Shortcode implementation (`layouts/shortcodes/option-tabs.html`):**
```html
{{ $tabs := split (.Get "tabs") "," }}
<div class="option-tabs">
  <div class="fd-tabs" role="tablist">
    {{ range $i, $tab := $tabs }}
    <button class="fd-tabs__item{{ if eq $i 0 }} is-active{{ end }}"
            role="tab"
            data-tab-index="{{ $i }}"
            onclick="switchTab(this, {{ $i }})">{{ $tab }}</button>
    {{ end }}
  </div>
  <div class="tab-panels">
    {{ .Inner }}
  </div>
</div>
```

**Tab shortcode (`layouts/shortcodes/tab.html`):**
```html
{{ $name := .Get 0 }}
<div class="tab-panel" data-tab-name="{{ $name }}" {{ if ne (index .Parent.Params "first") $name }}style="display:none"{{ end }}>
  {{ .Inner | markdownify }}
</div>
```

### TutorialNavigator → Client-side App

The navigator is a search/filter/card-grid interface that loads data from `_nav.json` client-side. In Hugo, this becomes:

1. Hugo generates the `_nav.json` at build time (or the fetch script generates it as a static file)
2. The home page template includes a mount point: `<div id="tutorial-navigator"></div>`
3. A bundled JS app (Vue, Alpine.js, or vanilla) mounts on that div and provides the interactive search/filter experience

This is already how it works in VitePress — the TutorialNavigator fetches `_nav.json` in `onMounted` and renders client-side. The only difference is we lose the server-rendered empty shell (hero banner) but gain instant page load.

### ProgressBar / PointsBadge → Client-side JS

These already load data client-side (`onMounted`). In Hugo they become:
- Empty placeholder divs in the template
- Client JS populates them after page load via API call to `/tutorials/{slug}/progress`

### FeedbackShareBar → Hugo Partial + Client JS

The nav pills (Previous/Next) are pure HTML derivable from frontmatter — Hugo handles this natively:
```html
{{ with .Params.prev }}
<a href="/tutorials/{{ . }}" class="nav-pill">&larr; Previous</a>
{{ end }}
{{ with .Params.next }}
<a href="/tutorials/{{ . }}" class="nav-pill nav-pill--primary">Next &rarr;</a>
{{ end }}
```

The feedback/share popovers become client-side JS widgets.

---

## Content Format Changes

### Frontmatter

The YAML frontmatter is nearly identical. Hugo uses some reserved keys differently:

```yaml
---
title: "Use Smart Data Integration..."
description: "Virtualize data from..."
# Hugo-specific
type: tutorials              # maps to layouts/tutorials/single.html
layout: single               # (default, can omit)
# Custom params (accessed via .Params.xxx)
slug: hana-cloud-mission-extend-06
time: 15
level: beginner
tags:
  - SAP HANA Cloud
primaryTag: "software-product>sap-hana-cloud"
stepCount: 9
prev: "hana-cloud-mission-extend-05"
next: "hana-cloud-mission-extend-08"
displayTags:
  - SAP HANA Cloud
  - Beginner
youWillLearn:
  - How to set up the Data Provisioning Agent
  - How to create a remote source
prerequisites:
  - A running instance of SAP HANA Cloud
---
```

### Body Content

Replace Vue component syntax with Hugo shortcode syntax:

| VitePress | Hugo |
|-----------|------|
| `<TutorialStep :number="1" title="..." slug="...">` | `{{</* tutorial-step number="1" title="..." */>}}` |
| `</TutorialStep>` | `{{</* /tutorial-step */>}}` |
| `<OptionTabs :tabs="['A','B']">` | `{{</* option-tabs tabs="A,B" */>}}` |
| `<template #tab-0>` | `{{</* tab "A" */>}}` |
| `</template>` | `{{</* /tab */>}}` |
| `</OptionTabs>` | `{{</* /option-tabs */>}}` |

---

## Client-Side Interactivity Strategy

Hugo generates pure static HTML. All interactivity runs in the browser. Two approaches:

### Option A: Vanilla JS (Recommended for this use case)

The interactive behaviors needed are simple:
- **Step accordion:** toggle `display` on click, update icon
- **Step completion:** POST to API on "Done" click, update progress bar
- **Tab switching:** show/hide panels on click
- **Search/filter (navigator):** fetch JSON, filter array, render cards

This can be ~500 lines of vanilla TypeScript, bundled with esbuild (which Hugo supports natively via `js.Build`).

**Pros:** Zero framework overhead, instant page load, tiny bundle size (<10KB gzipped)
**Cons:** No reactivity system; manual DOM manipulation for progress state

### Option B: Alpine.js (Lightweight reactivity)

Alpine.js (14KB) provides Vue-like reactivity without a build step. Each component becomes an `x-data` block:

```html
<div x-data="tutorialStep(1)" class="tutorial-step">
  <div class="step-header" @click="toggle()">
    <span x-text="expanded ? '—' : '+'"></span>
  </div>
  <div class="step-body" x-show="expanded" x-transition>
    ...
  </div>
</div>
```

**Pros:** Familiar Vue-like syntax, declarative, small footprint
**Cons:** Additional dependency, slightly heavier than vanilla for simple interactions

### Option C: Bundled Vue App (Maximum code reuse)

Mount a Vue app on specific pages that need heavy interactivity (TutorialNavigator, AppSpace). Use Hugo for the content rendering but load Vue for the interactive shell:

```html
<!-- In Hugo template -->
<div id="tutorial-navigator"></div>
<script type="module" src="/js/navigator.js"></script>
```

**Pros:** Reuse existing Vue components with minimal changes
**Cons:** Defeats some of Hugo's simplicity; two build systems; Vue bundle adds ~80KB

### Recommendation

**Use Option A (vanilla JS) for tutorials** — the interactions are simple DOM toggles and API calls. **Use Option C (bundled Vue) only for TutorialNavigator and AppSpace** — these are genuinely complex interactive UIs that benefit from Vue's reactivity.

---

## Build Pipeline Changes

### Current Pipeline

```
fetch-tutorials.ts → validate-tutorials.ts → vitepress build → build:display → copy:static
```

### Hugo Pipeline

```
fetch-tutorials.ts → generate-hugo-content.ts → hugo build → build:display → copy:static
```

The key change is `generate-hugo-content.ts` replaces `validate-tutorials.ts` + `vitepress build`. This script:

1. Takes parsed tutorial data (from existing parsers)
2. Generates Hugo-format markdown files with shortcode syntax instead of Vue components
3. Generates `_nav.json` as a static file (for the navigator)
4. Hugo builds everything in seconds

### Hugo Build Command

```bash
cd hugo && hugo --minify
```

That's it. No `NODE_OPTIONS`, no 16GB memory, no source map concerns.

### Asset Pipeline (JS/CSS)

Hugo has built-in support for:
- **JS bundling:** `js.Build` pipes through esbuild (supports TypeScript, tree-shaking, minification)
- **CSS processing:** `css.PostCSS` for PostCSS, or just serve static CSS files
- **Fingerprinting:** `resources.Fingerprint` for cache-busting

For SAP Fundamental Styles, just copy the CSS to `hugo/static/css/` or `hugo/assets/css/` and reference it in the base template.

---

## fetch-tutorials.ts Changes

The fetch and parse logic stays almost identical. The only change is the output format in `writeVitePressPage` → `writeHugoPage`:

**Replace Vue component wrapping:**
```typescript
// Before (VitePress)
const stepsMd = steps.map(step =>
  `<TutorialStep :number="${step.number}" title="${step.title}" slug="${slug}">\n\n${content}\n\n</TutorialStep>`
).join('\n\n')

// After (Hugo)
const stepsMd = steps.map(step =>
  `{{< tutorial-step number="${step.number}" title="${step.title}" >}}\n\n${content}\n\n{{< /tutorial-step >}}`
).join('\n\n')
```

**Replace OptionTabs wrapping:**
```typescript
// Before (VitePress)
`<OptionTabs :tabs="['${tabs.join("','")}']">\n<template #tab-0>\n${content}\n</template>\n</OptionTabs>`

// After (Hugo)
`{{< option-tabs tabs="${tabs.join(',')}" >}}\n{{< tab "${tabs[0]}" >}}\n${content}\n{{< /tab >}}\n{{< /option-tabs >}}`
```

The sanitizer (`sanitizeStepContent`, `balanceComponentTags`, `escapeHtmlTags`) becomes largely unnecessary — Hugo's Goldmark renderer doesn't compile HTML as Vue templates, so raw `<YOUR_BUCKET_NAME>` and `{{ workflow.parameters }}` are harmless. The only concern is Hugo shortcode delimiters (`{{` and `}}`) which would need escaping if they appear in content — but `{{` inside code fences is already handled by Goldmark.

---

## Migration Steps (Execution Order)

### Phase 1: Hugo Site Skeleton (1 day)

1. Install Hugo (`brew install hugo` / `choco install hugo-extended`)
2. Create `hugo/` directory with `hugo.toml`
3. Create base template (`baseof.html`) with SAP Fundamental Styles CSS
4. Create tutorial single layout (`tutorials/single.html`) with step rendering
5. Create shortcodes: `tutorial-step.html`, `option-tabs.html`, `tab.html`
6. Manually convert 1-2 tutorial markdown files to Hugo format and verify rendering

### Phase 2: Content Generation (1 day)

7. Modify `scripts/fetch-tutorials.ts` to output Hugo shortcode format
8. Output to `hugo/content/tutorials/` instead of `site/tutorials/`
9. Generate `hugo/static/tutorials/_nav.json` for the navigator
10. Run fetch → generate → hugo build and verify all 1370 tutorials render

### Phase 3: Client-Side Interactivity (2-3 days)

11. Write `tutorial-app.ts` — step toggle, done button, progress API calls
12. Write `progress.ts` — fetch progress on page load, update UI
13. Write `navigator.ts` — fetch `_nav.json`, implement search/filter/card rendering (or mount Vue app)
14. Bundle with Hugo's `js.Build` or separate esbuild step
15. Integrate into templates

### Phase 4: Feature Parity (1-2 days)

16. Previous/Next navigation (Hugo partial using frontmatter)
17. Sidebar TOC (Hugo's built-in `.TableOfContents` or custom JS)
18. Dark mode toggle (CSS variables, same approach as current)
19. Breadcrumbs (Hugo partial using mission/group frontmatter)
20. AppSpace page (keep as bundled Vue app, mount on Hugo page)

### Phase 5: Deployment (0.5 day)

21. Update `mta.yaml` to run `hugo --minify` instead of `vitepress build`
22. Hugo output goes to `hugo/public/` — copy to `approuter/static/`
23. Update GitHub Actions workflows
24. Test full deploy pipeline

### Phase 6: Cleanup

25. Remove VitePress dependencies from `package.json`
26. Remove `site/.vitepress/` directory
27. Remove Vue theme components (keep any that are bundled for navigator/app-space)
28. Update CLAUDE.md and documentation

---

## Hugo Configuration (`hugo.toml`)

```toml
baseURL = '/'
languageCode = 'en-us'
title = 'SAP Tutorial Platform'

[build]
  writeStats = true

[markup]
  [markup.goldmark]
    [markup.goldmark.renderer]
      unsafe = true  # Allow raw HTML in markdown (needed for some tutorial content)
    [markup.goldmark.extensions]
      [markup.goldmark.extensions.passthrough]
        enable = true
        [markup.goldmark.extensions.passthrough.delimiters]
          block = [['$$', '$$']]
          inline = [['$', '$']]

[outputs]
  home = ['HTML', 'JSON']  # JSON output for _nav.json equivalent

[params]
  apiBase = '/api'

[module]
  [[module.mounts]]
    source = 'static'
    target = 'static'
  [[module.mounts]]
    source = 'assets'
    target = 'assets'
```

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Hugo shortcode syntax conflicts with tutorial content | Medium | Escape `{{` in content; test with all 1370 tutorials |
| Goldmark renders markdown differently than markdown-it | Medium | Test edge cases (nested lists, code fences in lists, HTML entities) |
| Client-side progress/completion feels laggy vs Vue hydration | Low | API calls are already async; skeleton UI during load |
| Team unfamiliar with Go templates | Medium | Go templates are simple; most logic moves to JS |
| TutorialNavigator complexity in vanilla JS | Medium | Keep it as a bundled Vue mini-app, mount on one page |
| Build pipeline complexity (Node fetch + Hugo build + JS bundle) | Low | Hugo's `js.Build` handles JS; or separate esbuild step |

---

## What We Keep

- `scripts/fetch-tutorials.ts` (fetch + parse logic, modified output format)
- `scripts/parsers/` (all parser logic unchanged)
- SAP Fundamental Styles CSS (copy to Hugo static/)
- `display-app/` (unchanged, separate build)
- `approuter/` (unchanged, serves static files)
- `mta.yaml` structure (swap build command)
- `.github/workflows/` structure (swap build command)
- Dark mode CSS variables and theme system
- API composable logic (rewritten as vanilla fetch helpers)

## What We Lose

- Vue component reactivity during page interaction (replaced with vanilla JS)
- Server-side rendering of tutorial content (Hugo outputs static HTML — same end result)
- Hot module replacement for components during dev (Hugo has live reload for templates)
- Type-safe component props (shortcodes are string-based)

## What We Gain

- **3-8 second builds** instead of 190+ seconds
- **< 1GB memory** instead of 16GB
- **Zero Node.js runtime dependency** for the build (only for fetch scripts)
- **No Vue template compilation errors** — raw HTML in markdown is fine
- **No quarantine system needed** — all content renders safely
- **Simpler CI** — no `NODE_OPTIONS`, no memory tuning, no source map concerns
- **Faster dev iteration** — instant rebuild on template/content change
