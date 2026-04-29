# Hugo Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Migrate from VitePress to Hugo while preserving all functionality, theming, and BTP deployment.

**Architecture:** Hugo generates static HTML with shortcode-based tutorial steps. Vanilla TypeScript handles tutorial interactivity (bundled by Hugo's js.Build). Complex UIs (Navigator, AppSpace) remain Vue apps built by a separate Vite project and mounted as client-side mini-apps.

**Tech Stack:** Hugo (Go templates, shortcodes), TypeScript, Vue 3 + Vite (mini-apps), SAP Fundamental Styles, MTA/Cloud Foundry

---

## Phase 1: Hugo Skeleton + First Tutorial

### Task 1: Hugo Project Init

**Files:**
- Create: `hugo/hugo.toml`
- Create: `hugo/layouts/_default/baseof.html`
- Create: `hugo/layouts/_default/list.html`
- Create: `hugo/layouts/index.html`

- [x] **Step 1: Create `hugo/hugo.toml`**

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

- [x] **Step 2: Create `hugo/layouts/_default/baseof.html`**

```html
<!DOCTYPE html>
<html lang="en" data-theme="light" data-api-base="{{ .Site.Params.apiBase }}">
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

- [x] **Step 3: Create `hugo/layouts/_default/list.html`**

Minimal list template (Hugo requires it):

```html
{{ define "main" }}
<h1>{{ .Title }}</h1>
{{ .Content }}
{{ end }}
```

- [x] **Step 4: Create `hugo/layouts/index.html`**

Home page with Navigator mount point:

```html
{{ define "main" }}
<div id="tutorial-navigator"></div>
<script type="module" src="/js/navigator.js"></script>
{{ end }}
```

- [x] **Step 5: Create placeholder `hugo/content/_index.md`**

```markdown
---
title: "SAP Tutorial Platform"
---
```

- [x] **Step 6: Verify Hugo builds with no errors**

Run: `hugo --source hugo`
Expected: Build completes, creates `hugo/public/index.html`

- [x] **Step 7: Commit**

```bash
git add hugo/
git commit -m "feat(hugo): init Hugo skeleton with base templates"
```

---

### Task 2: Head Partial and SAP Fundamental Styles

**Files:**
- Create: `hugo/layouts/partials/head.html`
- Create: `hugo/static/css/sap-fundamental.css`
- Create: `hugo/static/css/sap-theme-vars.css`

- [x] **Step 1: Copy SAP Fundamental Styles CSS**

Copy `site/.vitepress/theme/styles/sap-fundamental.css` to `hugo/static/css/sap-fundamental.css`.
Copy any Horizon theme variables CSS to `hugo/static/css/sap-theme-vars.css`.

- [x] **Step 2: Create `hugo/layouts/partials/head.html`**

```html
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{ .Title }} | {{ .Site.Title }}</title>
<link rel="stylesheet" href="/css/sap-fundamental.css">
<link rel="stylesheet" href="/css/sap-theme-vars.css">
<script>
  const t = localStorage.getItem('theme') ||
    (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = t;
</script>
```

- [x] **Step 3: Verify dark mode inline script runs**

Run: `hugo server --source hugo`
Expected: Page loads, `data-theme` is set on `<html>`.

- [x] **Step 4: Commit**

```bash
git add hugo/layouts/partials/head.html hugo/static/css/
git commit -m "feat(hugo): add SAP Fundamental Styles and head partial"
```

---

### Task 3: Header, Footer, and Navigation Partials

**Files:**
- Create: `hugo/layouts/partials/header.html`
- Create: `hugo/layouts/partials/footer.html`

- [x] **Step 1: Create `hugo/layouts/partials/header.html`**

Read `site/.vitepress/theme/components/TutorialLayout.vue` (the header/shellbar section near line 1-50 of the template) and translate to a static Hugo partial. Structure:

```html
<div class="fd-shellbar">
  <div class="fd-shellbar__group fd-shellbar__group--product">
    <a href="/" class="fd-shellbar__logo">
      <img src="/img/sap-logo.svg" alt="SAP">
    </a>
    <span class="fd-shellbar__title">Tutorial Platform</span>
  </div>
  <div class="fd-shellbar__group fd-shellbar__group--actions">
    <nav>
      <a href="/" class="fd-shellbar__action">Tutorials</a>
      <a href="/app-space" class="fd-shellbar__action">App Space</a>
      <a href="/event-display" class="fd-shellbar__action">Event Display</a>
    </nav>
    <button class="fd-shellbar__action" data-action="toggle-theme" aria-label="Toggle dark mode"></button>
  </div>
</div>
```

- [x] **Step 2: Create `hugo/layouts/partials/footer.html`**

Minimal footer with copyright and links:

```html
<footer class="site-footer fd-bar fd-bar--footer">
  <div class="fd-bar__right">
    <span>&copy; SAP SE</span>
  </div>
</footer>
```

Minimal footer partial.

- [x] **Step 3: Verify pages render with header/footer**

Run: `hugo server --source hugo`
Expected: Shell bar visible on home page.

- [x] **Step 4: Commit**

```bash
git add hugo/layouts/partials/
git commit -m "feat(hugo): add header/footer partials with shell bar"
```

---

### Task 4: Tutorial Single Layout

**Files:**
- Create: `hugo/layouts/tutorials/single.html`
- Create: `hugo/layouts/partials/breadcrumbs.html`
- Create: `hugo/layouts/partials/tutorial-meta.html`
- Create: `hugo/layouts/partials/tutorial-sidebar.html`
- Create: `hugo/layouts/partials/tutorial-author.html`
- Create: `hugo/layouts/partials/tutorial-prerequisites.html`
- Create: `hugo/layouts/partials/tutorial-nav-bottom.html`
- Create: `hugo/layouts/partials/feedback-share.html`
- Create: `hugo/layouts/partials/progress-bar.html`

- [x] **Step 1: Create `hugo/layouts/tutorials/single.html`**

Full tutorial layout per spec (title, meta, you-will-learn, steps container, sidebar, data script).

- [x] **Step 2: Create supporting partials**

breadcrumbs.html, tutorial-meta.html, tutorial-sidebar.html, tutorial-author.html, tutorial-prerequisites.html, tutorial-nav-bottom.html, feedback-share.html, progress-bar.html

- [x] **Step 3: Create a manual test tutorial**

Create `hugo/content/tutorials/test-tutorial.md` with frontmatter and one shortcode step (will add shortcode in next task).

- [x] **Step 4: Commit**

```bash
git add hugo/layouts/tutorials/ hugo/layouts/partials/ hugo/content/tutorials/test-tutorial.md
git commit -m "feat(hugo): tutorial single layout with all partials"
```

---

### Task 5: Shortcodes

**Files:**
- Create: `hugo/layouts/shortcodes/tutorial-step.html`
- Create: `hugo/layouts/shortcodes/option-tabs.html`
- Create: `hugo/layouts/shortcodes/tab.html`

- [x] **Step 1: Create `hugo/layouts/shortcodes/tutorial-step.html`**

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

- [x] **Step 2: Create `hugo/layouts/shortcodes/option-tabs.html`**

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

- [x] **Step 3: Create `hugo/layouts/shortcodes/tab.html`**

```html
{{ $index := .Get "index" }}
{{ $name := .Get "name" }}
<div class="tab-panel" data-tab-panel="{{ $index }}" data-tab-name="{{ $name }}"{{ if ne $index "0" }} hidden{{ end }}>
  {{ .Inner }}
</div>
```

- [x] **Step 4: Update test tutorial to use shortcodes**

Add `{{% tutorial-step number="1" title="Hello World" %}}` content to test-tutorial.md.

- [x] **Step 5: Verify shortcodes render**

Run: `hugo server --source hugo`
Expected: Tutorial page shows step accordion HTML, option tabs functional.

- [x] **Step 6: Commit**

```bash
git add hugo/layouts/shortcodes/ hugo/content/tutorials/test-tutorial.md
git commit -m "feat(hugo): tutorial-step, option-tabs, and tab shortcodes"
```

---

## Phase 2: Content Generation

### Task 6: `--target hugo` Flag in fetch-tutorials.ts

**Files:**
- Modify: `scripts/fetch-tutorials.ts`

- [x] **Step 1: Write a test for target parsing**

Create `scripts/__tests__/hugo-target.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
// Test that parseArgs extracts --target flag
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/hugo-target.test.ts`
Expected: FAIL

- [x] **Step 3: Implement target argument parsing**

In `scripts/fetch-tutorials.ts`, add logic to parse `--target hugo` from `process.argv`. Set `OUTPUT_DIR` and `NAV_OUTPUT` based on target:
- `hugo` → `hugo/content/tutorials/`, `hugo/static/tutorials/_nav.json`
- default → `site/tutorials/`, `site/tutorials/_nav.json`

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/hugo-target.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add scripts/fetch-tutorials.ts scripts/__tests__/hugo-target.test.ts
git commit -m "feat(hugo): add --target hugo flag to fetch-tutorials"
```

---

### Task 7: Make `convertOptionBlocks()` Target-Aware

**Files:**
- Modify: `scripts/parsers/options.ts`
- Test: `scripts/__tests__/options-hugo.test.ts`

- [x] **Step 1: Write test for Hugo option block output**

```typescript
import { describe, it, expect } from 'vitest'
import { convertOptionBlocks } from '../parsers/options'

describe('convertOptionBlocks (hugo target)', () => {
  it('outputs Hugo shortcode syntax', () => {
    const input = `[OPTION BEGIN [Video]]
video content
[OPTION END]
[OPTION BEGIN [Written]]
text content
[OPTION END]`
    const result = convertOptionBlocks(input, 'hugo')
    expect(result).toContain('{{% option-tabs tabs="Video,Written" %}}')
    expect(result).toContain('{{% tab index="0" name="Video" %}}')
    expect(result).toContain('{{% /tab %}}')
    expect(result).toContain('{{% /option-tabs %}}')
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/options-hugo.test.ts`
Expected: FAIL (function doesn't accept target param yet)

- [x] **Step 3: Add `target` parameter to `convertOptionBlocks()`**

Modify `scripts/parsers/options.ts` to accept optional `target: 'vitepress' | 'hugo'` parameter (default: `'vitepress'`). When target is `'hugo'`, output:
```text
{{% option-tabs tabs="A,B" %}}
{{% tab index="0" name="A" %}}
content...
{{% /tab %}}
{{% /option-tabs %}}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/options-hugo.test.ts`
Expected: PASS

- [x] **Step 5: Verify existing VitePress tests still pass**

Run: `npx vitest run scripts/__tests__/`
Expected: All tests PASS (default target unchanged)

- [x] **Step 6: Commit**

```bash
git add scripts/parsers/options.ts scripts/__tests__/options-hugo.test.ts
git commit -m "feat(hugo): make convertOptionBlocks target-aware"
```

---

### Task 8: `writeHugoPage()` and `patchTutorialFrontmatter()` Target-Awareness

**Files:**
- Modify: `scripts/fetch-tutorials.ts`
- Test: `scripts/__tests__/hugo-write.test.ts`

- [x] **Step 1: Write test for Hugo page output format**

Test that `writeHugoPage()` produces correct frontmatter (with `type: tutorials`) and wraps steps in `{{% tutorial-step %}}` shortcodes. Also test that output does NOT contain artifacts from `sanitizeStepContent()`, `balanceComponentTags()`, or `escapeHtmlTags()` (e.g., no `&lt;div&gt;` where raw HTML should appear).

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/hugo-write.test.ts`
Expected: FAIL

- [x] **Step 3: Implement `writeHugoPage()`**

New function in `scripts/fetch-tutorials.ts` that:
1. Writes Hugo-compatible frontmatter (`type: tutorials`, etc.)
2. Wraps each step's content in `{{% tutorial-step number="N" title="..." %}}...{{% /tutorial-step %}}`
3. Calls `convertOptionBlocks(content, 'hugo')` for each step BEFORE wrapping
4. Writes to `hugo/content/tutorials/{slug}.md`
5. **Does NOT call** `sanitizeStepContent()`, `balanceComponentTags()`, or `escapeHtmlTags()` — these are VitePress-only concerns (Hugo's Goldmark passes raw HTML through without issue)

- [x] **Step 4: Make `patchTutorialFrontmatter()` target-aware**

This function currently patches tutorial files (e.g., adding validation data) and writes to the hardcoded VitePress output dir. Refactor to accept a `target` parameter:
- `hugo` → writes to `hugo/content/tutorials/` with `type: tutorials` frontmatter
- `vitepress` (default) → existing behavior unchanged

Write a test that verifies Hugo target produces correct path and frontmatter keys.

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run scripts/__tests__/hugo-write.test.ts`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add scripts/fetch-tutorials.ts scripts/__tests__/hugo-write.test.ts
git commit -m "feat(hugo): implement writeHugoPage and target-aware patchTutorialFrontmatter"
```

---

### Task 9: `{{` Delimiter Scanner

**Files:**
- Modify: `scripts/fetch-tutorials.ts`
- Test: `scripts/__tests__/hugo-delimiters.test.ts`

- [x] **Step 1: Write test for delimiter scanning**

Test that content with `{{` outside code fences gets wrapped in raw string handling, while `{{` inside code fences is left alone.

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/__tests__/hugo-delimiters.test.ts`
Expected: FAIL

- [x] **Step 3: Implement delimiter scanner**

Function that:
1. Finds `{{` outside fenced code blocks
2. Escapes them with Hugo's `{{</* */>}}` raw string delimiters or wraps in `{{` + `}}` rawstring shortcode
3. Logs a warning for each occurrence

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/__tests__/hugo-delimiters.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add scripts/fetch-tutorials.ts scripts/__tests__/hugo-delimiters.test.ts
git commit -m "feat(hugo): scan and escape {{ delimiters in tutorial content"
```

---

### Task 10: Full Content Generation Run

**Files:**
- Modify: `scripts/fetch-tutorials.ts` (wire everything together)
- Modify: `package.json` (add new scripts)

- [x] **Step 1: Wire up main() for Hugo target**

Ensure `main()` calls the correct functions when `--target hugo` is passed: correct output dir, calls `writeHugoPage()`, generates `_nav.json` to `hugo/static/tutorials/`.

- [x] **Step 2: Add package.json scripts**

During the migration period, keep the default `fetch-tutorials` pointing to VitePress (unchanged) and add a separate Hugo script. In Phase 6, the default switches to Hugo.

```json
"fetch-tutorials:hugo": "tsx scripts/fetch-tutorials.ts --target hugo",
"fetch-tutorials:vitepress": "tsx scripts/fetch-tutorials.ts"
```

Note: The existing `"fetch-tutorials"` script remains unchanged (VitePress default) until Phase 6 cleanup.

- [x] **Step 3: Run full generation**

Run: `npm run fetch-tutorials:hugo -- --regenerate`
Expected: All tutorials generated in `hugo/content/tutorials/`, `_nav.json` in `hugo/static/tutorials/`.

- [x] **Step 4: Build Hugo**

Run: `hugo --source hugo`
Expected: Build completes in <10 seconds with zero errors.

- [x] **Step 5: Spot-check 10 tutorials**

Verify shortcodes rendered correctly, option tabs present, no raw `{{` errors.

- [x] **Step 6: Commit**

```bash
git add scripts/fetch-tutorials.ts package.json
git commit -m "feat(hugo): full content generation pipeline for Hugo target"
```

---

## Phase 3: Client-Side Tutorial Interactivity

### Task 11: Step Toggle and Accordion Logic

**Files:**
- Create: `hugo/assets/js/tutorial.ts`

- [x] **Step 1: Create `hugo/assets/js/tutorial.ts` with event delegation**

```typescript
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  const stepHeader = target.closest('[data-action="toggle-step"]')
  if (stepHeader) { toggleStep(stepHeader as HTMLElement); return }
  const doneBtn = target.closest('[data-action="mark-done"]')
  if (doneBtn) { markDone(doneBtn as HTMLButtonElement); return }
  const tabBtn = target.closest('[role="tab"]')
  if (tabBtn) { switchTab(tabBtn as HTMLButtonElement); return }
})
```

- [x] **Step 2: Implement `toggleStep()`**

Toggle `hidden` attribute on `.step-body`, update toggle icon text between `—` and `+`.

- [x] **Step 3: Implement `expandAllSteps()` and `collapseAllSteps()`**

Expose globally on window for the onclick handlers in the template.

- [x] **Step 4: Add js.Build resource to tutorial layout**

In `hugo/layouts/tutorials/single.html`, add:
```html
{{ $js := resources.Get "js/tutorial.ts" | js.Build (dict "minify" true) }}
<script src="{{ $js.RelPermalink }}" defer></script>
```

- [x] **Step 5: Verify step toggle works in browser**

Run: `hugo server --source hugo`
Expected: Clicking step headers expands/collapses steps. Open all/Close all work.

- [x] **Step 6: Commit**

```bash
git add hugo/assets/js/tutorial.ts hugo/layouts/tutorials/single.html
git commit -m "feat(hugo): step accordion toggle with event delegation"
```

---

### Task 12: Tab Switching

**Files:**
- Modify: `hugo/assets/js/tutorial.ts`

- [x] **Step 1: Implement `switchTab()`**

```typescript
function switchTab(btn: HTMLButtonElement) {
  const container = btn.closest('[data-component="tabs"]')
  if (!container) return
  const index = btn.dataset.tabIndex
  container.querySelectorAll('[role="tab"]').forEach(t => t.classList.remove('is-selected'))
  btn.classList.add('is-selected')
  container.querySelectorAll('[data-tab-panel]').forEach(p => {
    const panel = p as HTMLElement
    panel.hidden = panel.dataset.tabPanel !== index
  })
}
```

- [x] **Step 2: Verify tab switching in browser**

Run: `hugo server --source hugo` (navigate to a tutorial with option tabs)
Expected: Clicking tab buttons shows/hides corresponding panels.

- [x] **Step 3: Commit**

```bash
git add hugo/assets/js/tutorial.ts
git commit -m "feat(hugo): option tab switching"
```

---

### Task 13: API Helper, Dev Proxy, and Progress Tracking

**Files:**
- Modify: `hugo/assets/js/tutorial.ts`
- Modify: `hugo/hugo.toml` (dev environment config)

- [x] **Step 1: Add API helper functions**

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

- [x] **Step 2: Configure dev proxy for API calls**

Hugo's dev server has no built-in proxy. For local development with `cds watch`, set `data-api-base` to point directly at the CAP server. Create `hugo/config/development/hugo.toml`:

```toml
[params]
  apiBase = 'http://localhost:4004'
```

Hugo merges this with the main `hugo.toml` when running `hugo server` (which defaults to `development` environment). In production builds, `hugo.toml` keeps `apiBase = '/api'` so the approuter handles proxying.

- [x] **Step 3: Implement `markDone()`**

POST to API, update step UI (add `completed` class, check circle), update progress bar.

- [x] **Step 4: Implement progress loading on page init**

On DOMContentLoaded, GET progress from API, mark previously completed steps, update progress bar.

- [x] **Step 5: Implement progress bar rendering**

Read `data-step-count` and `data-slug` from `#progress-bar` div. Create progress segments using DOM APIs (`document.createElement`). Update segment classes as steps complete.

- [x] **Step 6: Verify end-to-end flow with local CAP backend**

Run: `cds watch` (in another terminal) + `hugo server --source hugo`
Expected: Done button → API call to `http://localhost:4004` → progress updates → refresh shows saved state.

- [x] **Step 7: Commit**

```bash
git add hugo/assets/js/tutorial.ts hugo/config/
git commit -m "feat(hugo): progress tracking with API integration and dev proxy config"
```

---

### Task 14: Validation Quiz Widget

**Files:**
- Modify: `hugo/assets/js/tutorial.ts`

- [x] **Step 1: Implement validation quiz renderer**

On DOMContentLoaded, parse `#tutorial-data` JSON. For each step with validation questions:
1. Disable the Done button (`btn.disabled = true`)
2. Find `.step-validation-mount[data-step="N"]`
3. Build the quiz form using DOM creation APIs:

```typescript
function renderQuiz(mount: HTMLElement, stepNum: string, questions: ValidationQuestion[]) {
  const form = document.createElement('form')
  form.className = 'step-validation'
  form.dataset.step = stepNum

  questions.forEach((q, qi) => {
    const fieldset = document.createElement('fieldset')
    const legend = document.createElement('legend')
    legend.textContent = q.question
    fieldset.appendChild(legend)

    if (q.type === 'multiple-choice' && q.options) {
      q.options.forEach((opt, oi) => {
        const label = document.createElement('label')
        label.className = 'option-card'
        const radio = document.createElement('input')
        radio.type = 'radio'
        radio.name = `q-${stepNum}-${qi}`
        radio.value = opt
        label.appendChild(radio)
        const span = document.createElement('span')
        span.textContent = opt
        label.appendChild(span)
        fieldset.appendChild(label)
      })
    } else {
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'fd-input'
      input.name = `q-${stepNum}-${qi}`
      input.placeholder = 'Type your answer...'
      fieldset.appendChild(input)
    }
    form.appendChild(fieldset)
  })

  const submitBtn = document.createElement('button')
  submitBtn.type = 'submit'
  submitBtn.className = 'fd-button'
  submitBtn.textContent = 'Submit Answer'
  form.appendChild(submitBtn)

  const feedback = document.createElement('div')
  feedback.className = 'validation-feedback'
  form.appendChild(feedback)

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    handleQuizSubmit(form, stepNum, questions)
  })

  mount.appendChild(form)
}
```

- [x] **Step 2: Implement `handleQuizSubmit()`**

Validate answers: exact match for multiple-choice, case-insensitive trim for text. On success: enable Done button, show success feedback. On failure: show error, allow retry.

```typescript
function handleQuizSubmit(form: HTMLFormElement, stepNum: string, questions: ValidationQuestion[]) {
  const feedback = form.querySelector('.validation-feedback') as HTMLElement
  let allCorrect = true

  questions.forEach((q, qi) => {
    const name = `q-${stepNum}-${qi}`
    if (q.type === 'multiple-choice') {
      const selected = form.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement | null
      if (!selected || selected.value !== q.correctAnswer) allCorrect = false
    } else {
      const input = form.querySelector(`input[name="${name}"]`) as HTMLInputElement | null
      if (!input || input.value.trim().toLowerCase() !== q.correctAnswer.toLowerCase()) allCorrect = false
    }
  })

  if (allCorrect) {
    feedback.textContent = 'Correct!'
    feedback.className = 'validation-feedback validation-success'
    const step = document.querySelector(`[data-step="${stepNum}"]`)
    if (step) step.setAttribute('data-validated', 'true')
    const doneBtn = step?.querySelector('[data-action="mark-done"]') as HTMLButtonElement | null
    if (doneBtn) doneBtn.disabled = false
  } else {
    feedback.textContent = 'Not quite. Try again!'
    feedback.className = 'validation-feedback validation-error'
  }
}
```

- [x] **Step 3: Verify quiz renders and validates**

Run: `hugo server --source hugo` (navigate to tutorial with validation data)
Expected: Quiz form renders, wrong answer shows error, correct answer enables Done.

- [x] **Step 4: Commit**

```bash
git add hugo/assets/js/tutorial.ts
git commit -m "feat(hugo): validation quiz widget with DOM-based rendering"
```

---

### Task 15: Sidebar TOC and Dark Mode Toggle

**Files:**
- Modify: `hugo/assets/js/tutorial.ts`
- Modify: `hugo/layouts/partials/tutorial-sidebar.html`
- Modify: `hugo/layouts/partials/header.html`

- [x] **Step 1: Implement sidebar step highlighting**

On step completion, find sidebar TOC item and add `completed` class.

- [x] **Step 2: Implement dark mode toggle**

Add toggle button in header. On click: flip `data-theme`, persist to localStorage.

- [x] **Step 3: Verify sidebar and dark mode**

Run: `hugo server --source hugo`
Expected: Sidebar items highlight on step done. Dark mode toggles correctly.

- [x] **Step 4: Commit**

```bash
git add hugo/assets/js/tutorial.ts hugo/layouts/partials/
git commit -m "feat(hugo): sidebar TOC highlighting and dark mode toggle"
```

---

## Phase 4: Vue Mini-Apps

### Task 16: Apps Vite Project Setup

**Files:**
- Create: `apps/package.json`
- Create: `apps/vite.config.ts`
- Create: `apps/tsconfig.json`
- Create: `apps/src/shared/useApi.ts`
- Create: `apps/src/shared/types.ts`

- [x] **Step 1: Create `apps/package.json`**

```json
{
  "name": "tutorial-apps",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "vue": "^3.5.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.0.0",
    "typescript": "^5.5.0",
    "vite": "^6.0.0"
  }
}
```

- [x] **Step 2: Create `apps/vite.config.ts`**

Multi-entry config per spec (navigator, app-space, event-display, nav-dropdown).

- [x] **Step 3: Create shared utilities**

Copy `useApi.ts` from current codebase, remove VitePress imports. Create shared `types.ts`.

- [x] **Step 4: Install dependencies**

Run: `npm --prefix apps install`
Expected: Dependencies installed, no errors.

- [x] **Step 5: Commit**

```bash
git add apps/
git commit -m "feat(hugo): init apps/ Vite project for Vue mini-apps"
```

---

### Task 17: TutorialNavigator Port

**Files:**
- Create: `apps/src/navigator/main.ts`
- Create: `apps/src/navigator/TutorialNavigator.vue`

- [x] **Step 1: Copy and port TutorialNavigator.vue**

Copy from `site/.vitepress/theme/components/TutorialNavigator.vue`. Remove:
- `import { useData } from 'vitepress'`
- `ClientOnly` wrapper
- Any VitePress-specific imports

Replace `useData()` dark mode with `document.documentElement.dataset.theme`.

- [x] **Step 2: Create mount entry `apps/src/navigator/main.ts`**

```typescript
import { createApp } from 'vue'
import TutorialNavigator from './TutorialNavigator.vue'

const el = document.getElementById('tutorial-navigator')
if (el) createApp(TutorialNavigator).mount(el)
```

- [x] **Step 3: Build and verify**

Run: `npm --prefix apps run build`
Expected: `hugo/static/js/navigator.js` created.

- [x] **Step 4: Test in browser**

Run: `hugo server --source hugo`
Expected: Navigator loads on home page, search/filter/cards work.

- [x] **Step 5: Commit**

```bash
git add apps/src/navigator/
git commit -m "feat(hugo): port TutorialNavigator to apps/"
```

---

### Task 18: AppSpace, EventDisplay, NavDropdown, and MiniNavigator Ports

**Files:**
- Create: `apps/src/app-space/main.ts`
- Create: `apps/src/app-space/AppSpace.vue`
- Create: `apps/src/event-display/main.ts`
- Create: `apps/src/event-display/EventDisplay.vue`
- Create: `apps/src/nav-dropdown/main.ts`
- Create: `apps/src/nav-dropdown/TutorialNavigatorDropdown.vue`
- Create: `apps/src/mini-navigator/main.ts`
- Create: `apps/src/mini-navigator/MiniNavigator.vue`
- Create: `hugo/layouts/page/app-space.html`
- Create: `hugo/layouts/page/event-display.html`

- [x] **Step 1: Port AppSpace.vue**

Copy from current, remove VitePress dependencies. Create mount entry and Hugo layout page.

- [x] **Step 2: Port EventDisplay.vue**

Same approach as AppSpace.

- [x] **Step 3: Port TutorialNavigatorDropdown.vue**

Mounts on every tutorial page's breadcrumb area. Reads `currentSlug` from mount element's `data-slug` attribute.

- [x] **Step 4: Port MiniNavigator.vue**

Copy from `site/.vitepress/theme/components/MiniNavigator.vue`. This is the sidebar navigation tree with mission/group hierarchy and progress bars. It uses `useAemEnrichment.ts` composable (which fetches from `/bin/sapdx/v2/tutorial/miniNavigator.{missionId}.json`). Port:
- Remove VitePress `useData` import
- Create mount entry `apps/src/mini-navigator/main.ts`
- Mount point: a div in `hugo/layouts/tutorials/single.html` sidebar area with `data-mission-id` attribute
- Add `mini-navigator` to `apps/vite.config.ts` rollupOptions input

- [x] **Step 5: Add NavDropdown and MiniNavigator scripts to tutorial layout**

In `hugo/layouts/tutorials/single.html`, add:
```html
<script type="module" src="/js/nav-dropdown.js"></script>
<script type="module" src="/js/mini-navigator.js"></script>
```

- [x] **Step 6: Update `apps/vite.config.ts` with MiniNavigator entry**

Add to `rollupOptions.input`:
```typescript
'mini-navigator': resolve(__dirname, 'src/mini-navigator/main.ts'),
```

- [x] **Step 7: Build all apps**

Run: `npm --prefix apps run build`
Expected: All five entry points produce JS in `hugo/static/js/`.

- [x] **Step 8: Verify each app in browser**

Run: `hugo server --source hugo`
Expected: AppSpace themes work, EventDisplay loads, NavDropdown shows in tutorial breadcrumbs, MiniNavigator shows mission hierarchy in sidebar.

- [x] **Step 9: Commit**

```bash
git add apps/src/ hugo/layouts/page/ hugo/layouts/tutorials/single.html apps/vite.config.ts
git commit -m "feat(hugo): port AppSpace, EventDisplay, NavDropdown, and MiniNavigator"
```

---

## Phase 5: Feature Parity & Polish

### Task 19: Mission and Group Layouts

**Files:**
- Create: `hugo/layouts/missions/single.html`
- Create: `hugo/layouts/groups/single.html`
- Modify: `scripts/fetch-tutorials.ts` (generate mission/group content pages)

- [x] **Step 1: Create mission layout**

Shows mission metadata, lists tutorial groups in order.

- [x] **Step 2: Create group layout**

Shows group metadata, lists tutorials in order with completion status.

- [x] **Step 3: Generate mission/group pages in fetch-tutorials**

Output `hugo/content/missions/` and `hugo/content/groups/` markdown pages with appropriate frontmatter.

- [x] **Step 4: Verify navigation flow**

Navigator → Mission → Group → Tutorial works correctly.

- [x] **Step 5: Commit**

```bash
git add hugo/layouts/missions/ hugo/layouts/groups/ scripts/fetch-tutorials.ts
git commit -m "feat(hugo): mission and group layout pages"
```

---

### Task 20: Previous/Next Navigation and Responsive Layout

**Files:**
- Modify: `hugo/layouts/partials/tutorial-nav-bottom.html`
- Modify: `hugo/static/css/sap-fundamental.css`

- [x] **Step 1: Implement prev/next links**

Read `prevTutorial` and `nextTutorial` from frontmatter params. Render as navigation links.

- [x] **Step 2: Verify responsive breakpoints**

Check mobile, tablet, desktop layouts match current VitePress output.

- [x] **Step 3: Fix any responsive issues**

Adjust CSS as needed for Hugo's output structure.

- [x] **Step 4: Commit**

```bash
git add hugo/layouts/partials/ hugo/static/css/
git commit -m "feat(hugo): prev/next navigation and responsive CSS fixes"
```

---

### Task 21: Visual Parity Verification

**Files:** (no new files — verification task)

- [x] **Step 1: Side-by-side comparison**

Run both VitePress and Hugo servers. Compare:
- Tutorial page layout
- Step accordion appearance
- Option tabs styling
- Navigator card grid
- AppSpace themes
- Dark mode appearance

- [x] **Step 2: Fix any visual discrepancies**

Adjust CSS/templates to match.

- [x] **Step 3: Run full build**

Run: `npm run fetch-tutorials:hugo -- --regenerate && npm --prefix apps run build && hugo --source hugo --minify`
Expected: Clean build, all pages generated.

- [x] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(hugo): visual parity adjustments"
```

---

## Phase 6: Deployment & Cleanup

### Task 22: Update MTA and Build Pipeline

**Files:**
- Modify: `mta.yaml`
- Modify: `package.json`

- [x] **Step 1: Update `mta.yaml` build-parameters**

Replace VitePress build commands with Hugo pipeline:
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

- [x] **Step 2: Update root package.json scripts**

Make Hugo the new default. Rename the old VitePress script:

```json
"fetch-tutorials": "tsx scripts/fetch-tutorials.ts --target hugo",
"fetch-tutorials:vitepress": "tsx scripts/fetch-tutorials.ts",
"build:apps": "npm --prefix apps run build",
"build:hugo": "hugo --source hugo --minify",
"build:display": "npm --prefix display-app run build",
"build:static": "mkdir -p approuter/static && cp -r hugo/public/* approuter/static/ && cp -r display-app/dist approuter/static/display-app",
"build": "npm run fetch-tutorials -- --regenerate && npm run build:apps && npm run build:hugo && npm run build:display && npm run build:static",
"dev:hugo": "hugo server --source hugo"
```

Note: The default `fetch-tutorials` now targets Hugo (matching the spec). The `:vitepress` variant is kept until VitePress removal in Task 24.

- [x] **Step 3: Test MTA build locally**

Run: `mbt build`
Expected: MTAR produced in `mta_archives/`.

- [x] **Step 4: Commit**

```bash
git add mta.yaml package.json
git commit -m "feat(hugo): update MTA and package.json for Hugo build pipeline"
```

---

### Task 23: Update GitHub Actions

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `.github/workflows/rebuild-content.yml`

- [x] **Step 1: Re-enable push trigger in `deploy.yml`**

Uncomment push trigger. The `mbt build` step already runs `before-all` commands from mta.yaml (which downloads Hugo binary inline via `curl`), so no additional Hugo install step is needed in this workflow.

- [x] **Step 2: Update `rebuild-content.yml` for Hugo**

This workflow rebuilds content without full MTA deploy. Replace VitePress commands with Hugo equivalents:
- Add Hugo binary download step: `curl -fsSL https://github.com/gohugoio/hugo/releases/download/v0.147.0/hugo_extended_0.147.0_linux-amd64.tar.gz | tar -xz -C /tmp hugo`
- Change "Fetch tutorials" to use `--target hugo`
- Replace "Build VitePress" with: `npm run build:apps && /tmp/hugo --source hugo --minify`
- Remove `NODE_OPTIONS: '--max-old-space-size=16384'` from env (Hugo uses <1GB, no longer needed)
- Update "Assemble static content" to copy from `hugo/public/` instead of `site/.vitepress/dist/`

- [x] **Step 3: Verify workflow syntax**

Run: `gh workflow view deploy.yml` and `gh workflow view rebuild-content.yml` or validate YAML locally.

- [x] **Step 4: Commit**

```bash
git add .github/workflows/
git commit -m "ci: update deploy and rebuild workflows for Hugo"
```

---

### Task 24: Remove VitePress (Final Cleanup)

**Files:**
- Remove: `site/.vitepress/` (entire directory)
- Remove: `site/` VitePress content (generated tutorials already in hugo/)
- Modify: `package.json` (remove VitePress dependencies)
- Remove: VitePress-specific scripts from package.json

- [ ] **Step 1: Remove VitePress dependencies**

```bash
npm uninstall vitepress vue
```

(Vue stays as a dependency only in `apps/package.json`)

- [ ] **Step 2: Remove `site/.vitepress/` directory**

- [ ] **Step 3: Remove VitePress-specific scripts from root package.json**

Remove `dev` (VitePress), `build` (VitePress), `preview`, `fetch-tutorials:vitepress`.

- [ ] **Step 4: Update CLAUDE.md**

Update project overview to reflect Hugo architecture.

- [ ] **Step 5: Final full build test**

Run: `npm run build`
Expected: Complete build succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove VitePress, migration complete"
```

---

## Summary

| Phase | Tasks | Estimated Effort |
|-------|-------|-----------------|
| 1. Hugo Skeleton | Tasks 1-5 | 1 day |
| 2. Content Generation | Tasks 6-10 | 1 day |
| 3. Client-Side Interactivity | Tasks 11-15 | 2 days |
| 4. Vue Mini-Apps | Tasks 16-18 | 2 days |
| 5. Feature Parity | Tasks 19-21 | 1 day |
| 6. Deployment & Cleanup | Tasks 22-24 | 0.5 day |
| **Total** | **24 tasks** | **~7.5 days** |
