# Devtoberfest Right-Rail Navigation + Rules & FAQ Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the Devtoberfest landing-page right rail to 7 fixed internal links, and add two new admin-editable, markdown-rendered content pages (Rules and FAQ).

**Architecture:** The rail becomes a static list in `DevtoberfestHome.vue` (no longer config-URL-driven). Two new Vue islands (`devtoberfest-rules`, `devtoberfest-faq`) fetch existing/new public JSON endpoints and render markdown via the globally-loaded `window.markdownit` + `window.DOMPurify`. FAQ content comes from a new `faqText` field on `DevtoberfestConfig`, editable in the existing Fiori Elements admin OP and served by a new `/api/devtoberfest/faq` endpoint mirroring `/terms`.

**Tech Stack:** Vue 3 (`<script setup>` islands), Vite, Hugo layouts, CAP Node.js (Express-style route handlers), CDS, Fiori Elements annotations, Vitest + happy-dom + `@vue/test-utils`.

## Global Constraints

- **Markdown rendering uses globals only** — `window.markdownit({ html: false, linkify: true, breaks: true })` then `window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })`. NO new npm dependency in `hugo-apps`. (Both globals are loaded on every page via `hugo/layouts/_default/baseof.html:51-52`.)
- **Public endpoints stay anonymous-friendly** — use the `_contextMw` / `_authMw` pattern already in `srv/routes/devtoberfest-public.js`; handlers never require auth.
- **No active config row → 503 EVENT_NOT_CONFIGURED** — pages treat 503 as an empty state, not an error.
- **CDS unit-test bootstrap** — use `cds.test('serve','--project','.','--in-memory')`; do NOT rely on `cds.deploy(cds.model)` (broken in this repo). `req.reject(404)` surfaces as `{ code: 404 }`.
- **After schema change** — run `npx cds deploy --to sqlite::memory:` (compile/assert guard) and `cds build --production` for `db/last-dev/` (never hand-author `.hdbmigrationtable`).
- **Slugs / routes are lowercase** — Hugo emits lowercase; new routes are `/devtoberfest/rules/` and `/devtoberfest/faq/`.
- **Windows line endings** — keep LF; do not introduce CRLF.
- **Config URL fields retained** — `contentRulesUrl`, `activitiesUrl`, `faqUrl`, `gameboardUrl` stay in schema (Joule/chat-context read them). Only the rail stops using them.

**Spec:** `docs/superpowers/specs/2026-08-02-devtoberfest-rail-nav-rules-faq-design.md`

---

## File Structure

**New files:**
- `hugo-apps/src/devtoberfest-shared/render-markdown.ts` — shared markdown→sanitized-HTML helper.
- `hugo-apps/src/devtoberfest-shared/__tests__/render-markdown.test.ts` — helper unit tests.
- `hugo-apps/src/devtoberfest-rules/main.ts` — Rules island entry.
- `hugo-apps/src/devtoberfest-rules/App.vue` — Rules page component.
- `hugo-apps/src/devtoberfest-rules/__tests__/App.test.ts` — Rules component tests.
- `hugo-apps/src/devtoberfest-faq/main.ts` — FAQ island entry.
- `hugo-apps/src/devtoberfest-faq/App.vue` — FAQ page component.
- `hugo-apps/src/devtoberfest-faq/__tests__/App.test.ts` — FAQ component tests.
- `hugo/content/devtoberfest/rules/_index.md` — Rules Hugo page.
- `hugo/layouts/devtoberfest/rules.html` — Rules layout.
- `hugo/content/devtoberfest/faq/_index.md` — FAQ Hugo page.
- `hugo/layouts/devtoberfest/faq.html` — FAQ layout.
- `test/unit/devtoberfest-faq-endpoint.test.js` — backend endpoint test.

**Modified files:**
- `db/devtoberfest.cds` — add `faqText`.
- `srv/routes/devtoberfest-public.js` — add `faqHandler` + route.
- `app/admin-annotations.cds` — annotate + surface `faqText`.
- `hugo-apps/src/devtoberfest/DevtoberfestHome.vue` — static 7-item rail.
- `hugo-apps/src/devtoberfest/styles.css` — 7 rail accent colors.
- `hugo-apps/src/devtoberfest/__tests__/DevtoberfestHome.banner.test.ts` — (only if a rail assertion needs updating; see Task 6).
- `hugo-apps/vite.config.ts` — register two new island entries.

---

## Task 1: Static 7-item rail in DevtoberfestHome.vue

**Files:**
- Modify: `hugo-apps/src/devtoberfest/DevtoberfestHome.vue:122-136`
- Modify: `hugo-apps/src/devtoberfest/styles.css:373-376`
- Test: `hugo-apps/src/devtoberfest/__tests__/DevtoberfestHome.rail.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: rail with 7 anchors, hrefs are fixed internal `/devtoberfest/*` routes. No dependency on `status.*Url`.

- [ ] **Step 1: Write the failing test**

Create `hugo-apps/src/devtoberfest/__tests__/DevtoberfestHome.rail.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DevtoberfestHome from '../DevtoberfestHome.vue'

const CONFIG = {
  apiStatus: '/api/devtoberfest/status', apiTerms: '/api/devtoberfest/terms',
  apiJoin: '/api/devtoberfest/join', apiMe: '/api/devtoberfest/me',
  imgKasimir: '/k.svg', imgTeched: '/t.svg', imgDevtoberfest: '/d.svg',
}

function stubStatusJoined() {
  const body = {
    event: { name: 'Devtoberfest', startDate: '2026-09-21', endDate: '2026-10-18' },
    joined: true, termsVersion: 1, termsRequired: false,
    // Intentionally empty URL fields — rail must NOT depend on them.
    contentRulesUrl: '', faqUrl: '', gameboardUrl: '', activitiesUrl: '', bannerUrl: '',
  }
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => body,
  })) as unknown as typeof fetch)
}

describe('DevtoberfestHome rail', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders exactly 7 fixed internal rail links regardless of status URLs', async () => {
    stubStatusJoined()
    const wrapper = mount(DevtoberfestHome, { props: { config: CONFIG } })
    await flushPromises()
    const links = wrapper.findAll('.dtf-rail-item')
    expect(links).toHaveLength(7)
    const pairs = links.map((a) => [a.text().trim(), a.attributes('href')])
    expect(pairs).toEqual([
      ['THE WEEKS', '/devtoberfest/calendar/'],
      ['ACTIVITIES', '/devtoberfest/schedule/'],
      ['SESSIONS', '/devtoberfest/sessions/'],
      ['ARCADE', '/devtoberfest/arcade/'],
      ['LEADERBOARD', '/devtoberfest/gameboard/'],
      ['THE RULES', '/devtoberfest/rules/'],
      ['FAQ', '/devtoberfest/faq/'],
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest/__tests__/DevtoberfestHome.rail.test.ts`
Expected: FAIL — rail currently renders 4 items with empty hrefs (`#`).

- [ ] **Step 3: Replace the railItems computed**

In `DevtoberfestHome.vue`, replace the `RailItem` interface + `railItems` computed (lines ~122-136) with a static constant. The `<aside>` template block already iterates `railItems` — leave it unchanged. Replace:

```ts
interface RailItem {
  label: string
  href: string
}

const railItems = computed<RailItem[]>(() => {
  const s = status.value
  if (!s) return []
  return [
    { label: 'THE RULES', href: s.contentRulesUrl || '#' },
    { label: 'THE WEEKS', href: s.activitiesUrl   || '#' },
    { label: 'FAQ',       href: s.faqUrl          || '#' },
    { label: 'GAMEBOARD', href: s.gameboardUrl    || '#' },
  ]
})
```

with:

```ts
interface RailItem {
  label: string
  href: string
}

// Fixed internal navigation — independent of admin-entered config URLs.
// Order is intentional (spec 2026-08-02). All targets are stable Hugo routes.
const railItems: RailItem[] = [
  { label: 'THE WEEKS',   href: '/devtoberfest/calendar/' },
  { label: 'ACTIVITIES',  href: '/devtoberfest/schedule/' },
  { label: 'SESSIONS',    href: '/devtoberfest/sessions/' },
  { label: 'ARCADE',      href: '/devtoberfest/arcade/' },
  { label: 'LEADERBOARD', href: '/devtoberfest/gameboard/' },
  { label: 'THE RULES',   href: '/devtoberfest/rules/' },
  { label: 'FAQ',         href: '/devtoberfest/faq/' },
]
```

Note: `railItems` is now a plain array, not a `computed`. The template `v-for="(item, i) in railItems"` works unchanged. If `computed` becomes an unused import, leave it — it's still used elsewhere in the file (`eventName`, `ctaLabel`, etc.).

- [ ] **Step 4: Extend rail accent colors from 4 to 7**

In `styles.css`, replace the 4 `nth-child` color rules (lines ~373-376):

```css
.dtf-rail-item:nth-child(1) { --rail-color: #0070f2; }
.dtf-rail-item:nth-child(2) { --rail-color: #7858ff; }
.dtf-rail-item:nth-child(3) { --rail-color: #1ea672; }
.dtf-rail-item:nth-child(4) { --rail-color: #f5a623; }
```

with 7:

```css
.dtf-rail-item:nth-child(1) { --rail-color: #0070f2; }
.dtf-rail-item:nth-child(2) { --rail-color: #7858ff; }
.dtf-rail-item:nth-child(3) { --rail-color: #1ea672; }
.dtf-rail-item:nth-child(4) { --rail-color: #f5a623; }
.dtf-rail-item:nth-child(5) { --rail-color: #e76500; }
.dtf-rail-item:nth-child(6) { --rail-color: #d20a0a; }
.dtf-rail-item:nth-child(7) { --rail-color: #aa0dc9; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest/__tests__/DevtoberfestHome.rail.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the existing banner test to confirm no regression**

Run: `cd hugo-apps && npx vitest run src/devtoberfest/__tests__/DevtoberfestHome.banner.test.ts`
Expected: PASS (banner test doesn't assert rail contents).

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/devtoberfest/DevtoberfestHome.vue hugo-apps/src/devtoberfest/styles.css hugo-apps/src/devtoberfest/__tests__/DevtoberfestHome.rail.test.ts
git commit -m "feat(devtoberfest): static 7-item right rail with fixed internal links"
```

---

## Task 2: Shared markdown render helper

**Files:**
- Create: `hugo-apps/src/devtoberfest-shared/render-markdown.ts`
- Test: `hugo-apps/src/devtoberfest-shared/__tests__/render-markdown.test.ts`

**Interfaces:**
- Consumes: `window.markdownit`, `window.DOMPurify` (global, may be absent in tests).
- Produces: `export function renderMarkdown(src: string): string` — returns sanitized HTML, or HTML-escaped plain text if globals absent/empty input.

- [ ] **Step 1: Write the failing test**

Create `hugo-apps/src/devtoberfest-shared/__tests__/render-markdown.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderMarkdown } from '../render-markdown'

// Minimal markdown-it stand-in: renders # heading and returns HTML.
function installGlobals() {
  ;(globalThis as any).window = globalThis as any
  ;(globalThis as any).markdownit = () => ({
    render: (src: string) =>
      src.replace(/^# (.*)$/m, '<h1>$1</h1>').replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>'),
  })
  ;(globalThis as any).DOMPurify = {
    // Pass-through sanitizer that strips <script>.
    sanitize: (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, ''),
  }
}

describe('renderMarkdown', () => {
  beforeEach(() => installGlobals())
  afterEach(() => {
    delete (globalThis as any).markdownit
    delete (globalThis as any).DOMPurify
  })

  it('renders markdown headings and links to HTML', () => {
    const out = renderMarkdown('# Hello\n\n[link](https://x.test)')
    expect(out).toContain('<h1>Hello</h1>')
    expect(out).toContain('<a href="https://x.test">link</a>')
  })

  it('strips script tags via DOMPurify', () => {
    const out = renderMarkdown('ok<script>alert(1)</script>')
    expect(out).not.toContain('<script>')
  })

  it('returns empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('')
  })

  it('falls back to escaped text when globals are absent', () => {
    delete (globalThis as any).markdownit
    delete (globalThis as any).DOMPurify
    const out = renderMarkdown('<b>hi & bye</b>')
    expect(out).toBe('&lt;b&gt;hi &amp; bye&lt;/b&gt;')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-shared/__tests__/render-markdown.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the helper**

Create `hugo-apps/src/devtoberfest-shared/render-markdown.ts`:

```ts
// Renders markdown to sanitized HTML using the globally-loaded
// window.markdownit + window.DOMPurify (see hugo/layouts/_default/baseof.html).
// Mirrors the config in hugo/static/js/joule-render.js exactly.
// Falls back to HTML-escaped plain text when the globals are unavailable
// (e.g. a load race or a unit test without them) so pages stay readable.

declare global {
  interface Window {
    markdownit?: (opts?: Record<string, unknown>) => { render: (src: string) => string }
    DOMPurify?: { sanitize: (html: string, opts?: Record<string, unknown>) => string }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function renderMarkdown(src: string): string {
  if (!src) return ''
  const md = typeof window !== 'undefined' ? window.markdownit : undefined
  const purify = typeof window !== 'undefined' ? window.DOMPurify : undefined
  if (!md || !purify) {
    return escapeHtml(src)
  }
  const renderer = md({ html: false, linkify: true, breaks: true })
  const dirty = renderer.render(src)
  return purify.sanitize(dirty, { USE_PROFILES: { html: true } })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-shared/__tests__/render-markdown.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/devtoberfest-shared/render-markdown.ts hugo-apps/src/devtoberfest-shared/__tests__/render-markdown.test.ts
git commit -m "feat(devtoberfest): shared markdown render helper (markdown-it + DOMPurify globals)"
```

---

## Task 3: Rules island (component + entry)

**Files:**
- Create: `hugo-apps/src/devtoberfest-rules/main.ts`
- Create: `hugo-apps/src/devtoberfest-rules/App.vue`
- Test: `hugo-apps/src/devtoberfest-rules/__tests__/App.test.ts`

**Interfaces:**
- Consumes: `renderMarkdown` from `../devtoberfest-shared/render-markdown`; `GET /api/devtoberfest/terms` → `{ text: string, version: number }` (503 when no active event).
- Produces: mounts into `#devtoberfest-rules-mount`. Root element `.dtf-doc-page` with states `.dtf-doc-loading` / `.dtf-doc-error` / `.dtf-doc-empty` / `.dtf-doc-body`.

- [ ] **Step 1: Write the failing test**

Create `hugo-apps/src/devtoberfest-rules/__tests__/App.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import App from '../App.vue'

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch)
}

describe('devtoberfest-rules App', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders the terms text on 200', async () => {
    stubFetch(200, { text: '# Rules\n\nBe nice.', version: 3 })
    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.find('.dtf-doc-body').exists()).toBe(true)
    expect(wrapper.find('.dtf-doc-body').html()).toContain('Rules')
    expect(wrapper.text()).toContain('v3')
  })

  it('shows empty state on 503', async () => {
    stubFetch(503, { error: 'EVENT_NOT_CONFIGURED' })
    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.find('.dtf-doc-empty').exists()).toBe(true)
    expect(wrapper.find('.dtf-doc-error').exists()).toBe(false)
  })

  it('shows empty state when text is blank', async () => {
    stubFetch(200, { text: '', version: 1 })
    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.find('.dtf-doc-empty').exists()).toBe(true)
  })

  it('shows error + retry on 500', async () => {
    stubFetch(500, { error: 'INTERNAL' })
    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.find('.dtf-doc-error').exists()).toBe(true)
    expect(wrapper.find('.dtf-doc-retry').exists()).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-rules/__tests__/App.test.ts`
Expected: FAIL — `App.vue` does not exist.

- [ ] **Step 3: Write App.vue**

Create `hugo-apps/src/devtoberfest-rules/App.vue`:

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { renderMarkdown } from '../devtoberfest-shared/render-markdown'

type State = 'loading' | 'ok' | 'empty' | 'error'

const state = ref<State>('loading')
const html = ref<string>('')
const version = ref<number>(0)
const errorMsg = ref<string>('')

async function load(): Promise<void> {
  state.value = 'loading'
  errorMsg.value = ''
  try {
    const res = await fetch('/api/devtoberfest/terms', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (res.status === 503) {
      state.value = 'empty'
      return
    }
    if (!res.ok) {
      errorMsg.value = `Couldn't load the rules (HTTP ${res.status}).`
      state.value = 'error'
      return
    }
    const data = (await res.json()) as { text?: string; version?: number }
    const text = (data.text || '').trim()
    version.value = data.version || 0
    if (!text) {
      state.value = 'empty'
      return
    }
    html.value = renderMarkdown(text)
    state.value = 'ok'
  } catch {
    errorMsg.value = "Couldn't reach the Devtoberfest service."
    state.value = 'error'
  }
}

onMounted(load)
</script>

<template>
  <article class="dtf-doc-page">
    <header class="dtf-doc-header">
      <h1 class="dtf-doc-title">Devtoberfest Rules</h1>
      <span v-if="version" class="dtf-doc-version">v{{ version }}</span>
    </header>

    <p v-if="state === 'loading'" class="dtf-doc-loading">Loading the rules&hellip;</p>
    <p v-else-if="state === 'empty'" class="dtf-doc-empty">
      The rules will be posted soon. Check back closer to the event.
    </p>
    <p v-else-if="state === 'error'" class="dtf-doc-error">
      {{ errorMsg }}
      <button type="button" class="dtf-doc-retry" @click="load">Retry</button>
    </p>
    <!-- eslint-disable-next-line vue/no-v-html -- sanitized via DOMPurify in renderMarkdown -->
    <div v-else class="dtf-doc-body" v-html="html"></div>
  </article>
</template>

<style>
.dtf-doc-page {
  max-width: 52rem;
  margin: 0 auto;
  padding: 1.5rem 1rem 3rem;
}
.dtf-doc-header {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.dtf-doc-title {
  font-size: 1.75rem;
  margin: 0;
}
.dtf-doc-version {
  font-size: 0.8rem;
  color: var(--sapContent_LabelColor, #6a6d70);
  border: 1px solid var(--sapTile_BorderColor, #e4e7ea);
  border-radius: 999px;
  padding: 0.1rem 0.6rem;
}
.dtf-doc-body {
  line-height: 1.6;
}
.dtf-doc-body h1, .dtf-doc-body h2, .dtf-doc-body h3 { margin-top: 1.5rem; }
.dtf-doc-body a { color: var(--sapLinkColor, #0a6ed1); }
.dtf-doc-body ul, .dtf-doc-body ol { padding-left: 1.5rem; }
.dtf-doc-loading, .dtf-doc-empty { color: var(--sapContent_LabelColor, #6a6d70); }
.dtf-doc-error {
  padding: 0.5rem 0.75rem;
  background: var(--sapErrorBackground, #ffeaea);
  border-left: 3px solid var(--sapNegativeColor, #aa0808);
  border-radius: 0 4px 4px 0;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.dtf-doc-retry {
  padding: 0.25rem 0.75rem;
  background: var(--sapButton_Background, #fff);
  border: 1px solid var(--sapNegativeColor, #aa0808);
  border-radius: 4px;
  cursor: pointer;
}
</style>
```

- [ ] **Step 4: Write main.ts**

Create `hugo-apps/src/devtoberfest-rules/main.ts`:

```ts
import { createApp } from 'vue';
import App from './App.vue';
const mount = document.getElementById('devtoberfest-rules-mount');
if (mount) createApp(App).mount(mount);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-rules/__tests__/App.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/devtoberfest-rules/
git commit -m "feat(devtoberfest): Rules island rendering termsText as markdown"
```

---

## Task 4: FAQ island (component + entry)

**Files:**
- Create: `hugo-apps/src/devtoberfest-faq/main.ts`
- Create: `hugo-apps/src/devtoberfest-faq/App.vue`
- Test: `hugo-apps/src/devtoberfest-faq/__tests__/App.test.ts`

**Interfaces:**
- Consumes: `renderMarkdown` from `../devtoberfest-shared/render-markdown`; `GET /api/devtoberfest/faq` → `{ text: string }` (503 when no active event).
- Produces: mounts into `#devtoberfest-faq-mount`. Same `.dtf-doc-*` state classes as Rules.

- [ ] **Step 1: Write the failing test**

Create `hugo-apps/src/devtoberfest-faq/__tests__/App.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import App from '../App.vue'

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch)
}

describe('devtoberfest-faq App', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders the faq text on 200', async () => {
    stubFetch(200, { text: '## Q: Really?\n\nYes.' })
    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.find('.dtf-doc-body').exists()).toBe(true)
    expect(wrapper.find('.dtf-doc-body').html()).toContain('Really?')
  })

  it('shows empty state on 503', async () => {
    stubFetch(503, { error: 'EVENT_NOT_CONFIGURED' })
    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.find('.dtf-doc-empty').exists()).toBe(true)
  })

  it('shows empty state when text is blank', async () => {
    stubFetch(200, { text: '' })
    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.find('.dtf-doc-empty').exists()).toBe(true)
  })

  it('shows error + retry on 500', async () => {
    stubFetch(500, { error: 'INTERNAL' })
    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.find('.dtf-doc-error').exists()).toBe(true)
    expect(wrapper.find('.dtf-doc-retry').exists()).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-faq/__tests__/App.test.ts`
Expected: FAIL — `App.vue` does not exist.

- [ ] **Step 3: Write App.vue**

Create `hugo-apps/src/devtoberfest-faq/App.vue` (identical structure to Rules; different title, endpoint, no version badge, different empty copy):

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { renderMarkdown } from '../devtoberfest-shared/render-markdown'

type State = 'loading' | 'ok' | 'empty' | 'error'

const state = ref<State>('loading')
const html = ref<string>('')
const errorMsg = ref<string>('')

async function load(): Promise<void> {
  state.value = 'loading'
  errorMsg.value = ''
  try {
    const res = await fetch('/api/devtoberfest/faq', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (res.status === 503) {
      state.value = 'empty'
      return
    }
    if (!res.ok) {
      errorMsg.value = `Couldn't load the FAQ (HTTP ${res.status}).`
      state.value = 'error'
      return
    }
    const data = (await res.json()) as { text?: string }
    const text = (data.text || '').trim()
    if (!text) {
      state.value = 'empty'
      return
    }
    html.value = renderMarkdown(text)
    state.value = 'ok'
  } catch {
    errorMsg.value = "Couldn't reach the Devtoberfest service."
    state.value = 'error'
  }
}

onMounted(load)
</script>

<template>
  <article class="dtf-doc-page">
    <header class="dtf-doc-header">
      <h1 class="dtf-doc-title">Devtoberfest FAQ</h1>
    </header>

    <p v-if="state === 'loading'" class="dtf-doc-loading">Loading the FAQ&hellip;</p>
    <p v-else-if="state === 'empty'" class="dtf-doc-empty">
      FAQ coming soon. Check back closer to the event.
    </p>
    <p v-else-if="state === 'error'" class="dtf-doc-error">
      {{ errorMsg }}
      <button type="button" class="dtf-doc-retry" @click="load">Retry</button>
    </p>
    <!-- eslint-disable-next-line vue/no-v-html -- sanitized via DOMPurify in renderMarkdown -->
    <div v-else class="dtf-doc-body" v-html="html"></div>
  </article>
</template>

<style>
/* Reuses the .dtf-doc-* styles defined in the Rules App.vue when both are
   present; duplicated here so the FAQ page is self-contained if loaded alone. */
.dtf-doc-page { max-width: 52rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
.dtf-doc-header { display: flex; align-items: baseline; gap: 0.75rem; margin-bottom: 1rem; }
.dtf-doc-title { font-size: 1.75rem; margin: 0; }
.dtf-doc-body { line-height: 1.6; }
.dtf-doc-body h1, .dtf-doc-body h2, .dtf-doc-body h3 { margin-top: 1.5rem; }
.dtf-doc-body a { color: var(--sapLinkColor, #0a6ed1); }
.dtf-doc-body ul, .dtf-doc-body ol { padding-left: 1.5rem; }
.dtf-doc-loading, .dtf-doc-empty { color: var(--sapContent_LabelColor, #6a6d70); }
.dtf-doc-error {
  padding: 0.5rem 0.75rem; background: var(--sapErrorBackground, #ffeaea);
  border-left: 3px solid var(--sapNegativeColor, #aa0808); border-radius: 0 4px 4px 0;
  display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;
}
.dtf-doc-retry {
  padding: 0.25rem 0.75rem; background: var(--sapButton_Background, #fff);
  border: 1px solid var(--sapNegativeColor, #aa0808); border-radius: 4px; cursor: pointer;
}
</style>
```

- [ ] **Step 4: Write main.ts**

Create `hugo-apps/src/devtoberfest-faq/main.ts`:

```ts
import { createApp } from 'vue';
import App from './App.vue';
const mount = document.getElementById('devtoberfest-faq-mount');
if (mount) createApp(App).mount(mount);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-faq/__tests__/App.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/devtoberfest-faq/
git commit -m "feat(devtoberfest): FAQ island rendering faqText as markdown"
```

---

## Task 5: Register island build entries

**Files:**
- Modify: `hugo-apps/vite.config.ts:277-279`

**Interfaces:**
- Consumes: the two `main.ts` files from Tasks 3 & 4.
- Produces: `/js/devtoberfest-rules.js` and `/js/devtoberfest-faq.js` build outputs.

- [ ] **Step 1: Add the two input entries**

In `hugo-apps/vite.config.ts`, in the `rollupOptions.input` map, after the existing `'devtoberfest-sessions-calendar'` line (~279), add:

```ts
        'devtoberfest-rules': resolve(__dirname, 'src/devtoberfest-rules/main.ts'),
        'devtoberfest-faq': resolve(__dirname, 'src/devtoberfest-faq/main.ts'),
```

- [ ] **Step 2: Build the islands to verify entries resolve**

Run: `cd hugo-apps && npm run build`
Expected: build succeeds; `hugo/static/js/devtoberfest-rules.js` and `hugo/static/js/devtoberfest-faq.js` are emitted.

- [ ] **Step 3: Verify outputs exist**

Run: `ls hugo/static/js/devtoberfest-rules.js hugo/static/js/devtoberfest-faq.js`
Expected: both files listed.

- [ ] **Step 4: Commit**

```bash
git add hugo-apps/vite.config.ts
git commit -m "build(devtoberfest): register rules + faq island entries"
```

Note: emitted `hugo/static/js/*.js` bundles may be gitignored (generated). Only commit `vite.config.ts`; do not force-add generated bundles unless the repo already tracks the other `devtoberfest-*.js` outputs (check `git status` — follow the existing convention).

---

## Task 6: Hugo pages & layouts for Rules and FAQ

**Files:**
- Create: `hugo/content/devtoberfest/rules/_index.md`
- Create: `hugo/layouts/devtoberfest/rules.html`
- Create: `hugo/content/devtoberfest/faq/_index.md`
- Create: `hugo/layouts/devtoberfest/faq.html`

**Interfaces:**
- Consumes: `/js/devtoberfest-rules.js`, `/js/devtoberfest-faq.js` (Task 5 outputs); mount IDs `#devtoberfest-rules-mount`, `#devtoberfest-faq-mount` (Tasks 3 & 4).
- Produces: Hugo routes `/devtoberfest/rules/` and `/devtoberfest/faq/`.

- [ ] **Step 1: Create the Rules content file**

Create `hugo/content/devtoberfest/rules/_index.md`:

```markdown
---
title: "Devtoberfest Rules"
description: "The Devtoberfest content rules and terms you accept when you register."
type: "devtoberfest"
layout: "rules"
---
```

- [ ] **Step 2: Create the Rules layout**

Create `hugo/layouts/devtoberfest/rules.html`:

```html
{{ define "main" }}
<main id="devtoberfest-rules-mount"></main>
<noscript>The Devtoberfest rules require JavaScript.</noscript>
<script type="module" src="{{ "/js/devtoberfest-rules.js" | relURL }}?v={{ now.Unix }}"></script>
{{ end }}
```

- [ ] **Step 3: Create the FAQ content file**

Create `hugo/content/devtoberfest/faq/_index.md`:

```markdown
---
title: "Devtoberfest FAQ"
description: "Frequently asked questions about Devtoberfest."
type: "devtoberfest"
layout: "faq"
---
```

- [ ] **Step 4: Create the FAQ layout**

Create `hugo/layouts/devtoberfest/faq.html`:

```html
{{ define "main" }}
<main id="devtoberfest-faq-mount"></main>
<noscript>The Devtoberfest FAQ requires JavaScript.</noscript>
<script type="module" src="{{ "/js/devtoberfest-faq.js" | relURL }}?v={{ now.Unix }}"></script>
{{ end }}
```

- [ ] **Step 5: Verify Hugo builds the two routes**

Run: `npm run fetch-tutorials >/dev/null 2>&1; npx hugo --source hugo --quiet && ls hugo/public/devtoberfest/rules/index.html hugo/public/devtoberfest/faq/index.html`
Expected: both `index.html` files exist. (If `fetch-tutorials` is heavy/slow and already cached, Hugo alone suffices — the two new pages don't depend on tutorial content.)

- [ ] **Step 6: Commit**

```bash
git add hugo/content/devtoberfest/rules/ hugo/content/devtoberfest/faq/ hugo/layouts/devtoberfest/rules.html hugo/layouts/devtoberfest/faq.html
git commit -m "feat(devtoberfest): Rules and FAQ Hugo pages + layouts"
```

---

## Task 7: Add faqText to the schema

**Files:**
- Modify: `db/devtoberfest.cds:31` (add after `termsText`)

**Interfaces:**
- Consumes: nothing.
- Produces: `DevtoberfestConfig.faqText` (LargeString) — read by Task 8's endpoint and edited via Task 9's admin annotation.

- [ ] **Step 1: Add the field**

In `db/devtoberfest.cds`, inside `entity DevtoberfestConfig`, add after the `termsVersion` line:

```cds
  faqText           : LargeString;          // markdown body for the public FAQ page
```

Place it near `termsText`/`termsVersion` so related content fields group together.

- [ ] **Step 2: Compile-guard the model**

Run: `npx cds deploy --to sqlite::memory: 2>&1 | tail -5`
Expected: deploys with no compile error, no `@assert.unique` violation.

- [ ] **Step 3: Rebuild for the migration table**

Run: `cds build --production 2>&1 | tail -5`
Expected: build succeeds; `db/last-dev/` / the hdbmigrationtable is regenerated automatically (do NOT hand-edit it).

- [ ] **Step 4: Commit**

```bash
git add db/devtoberfest.cds db/last-dev/ gen/ 2>/dev/null; git add db/devtoberfest.cds
git commit -m "feat(devtoberfest): add faqText field to DevtoberfestConfig"
```

Note: check `git status` after `cds build` — commit whatever generated migration artifacts the repo tracks (e.g. `db/last-dev/*.hdbmigrationtable`, `db/src/gen/`), following the existing convention. Do not commit `gen/` if it's gitignored.

---

## Task 8: FAQ public endpoint

**Files:**
- Modify: `srv/routes/devtoberfest-public.js` (add `faqHandler`, register route, export)
- Test: `test/unit/devtoberfest-faq-endpoint.test.js` (create)

**Interfaces:**
- Consumes: `DevtoberfestConfig.faqText` (Task 7); the existing `_contextMw` / `_authMw` middleware pattern.
- Produces: `GET /api/devtoberfest/faq` → `200 { text: string }` (active row) or `503 { error: 'EVENT_NOT_CONFIGURED' }`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/devtoberfest-faq-endpoint.test.js`. Follow the repo's CAP unit-test bootstrap convention (`cds.test('serve', ...)`). Inspect a sibling test in `test/unit/` for the exact import + app-handle style if this differs, but the shape is:

```js
const cds = require('@sap/cds');
const { expect } = require('chai');

describe('GET /api/devtoberfest/faq', () => {
  const { GET, POST } = cds.test('serve', '--project', '.', '--in-memory');

  it('returns 503 when no active config row exists', async () => {
    // Fresh in-memory DB: no active DevtoberfestConfig row seeded.
    try {
      await GET('/api/devtoberfest/faq');
      expect.fail('expected 503');
    } catch (e) {
      expect(e.response?.status || e.status).to.equal(503);
    }
  });

  it('returns { text } for the active config row', async () => {
    const db = await cds.connect.to('db');
    const { DevtoberfestConfig, Events } = cds.entities('com.sap.developers.ims');
    const ev = { ID: cds.utils.uuid(), name: 'DTF Test' };
    await INSERT.into(Events).entries(ev);
    await INSERT.into(DevtoberfestConfig).entries({
      ID: cds.utils.uuid(), isActive: true, currentEvent_ID: ev.ID,
      faqText: '## Q\n\nA.', termsVersion: 1,
    });
    const res = await GET('/api/devtoberfest/faq');
    expect(res.status).to.equal(200);
    expect(res.data.text).to.contain('## Q');
  });
});
```

Note: if `Events` requires more mandatory fields to insert, add them minimally (check `db/schema.cds` for `Events`). Adjust the 503-assertion style to match how sibling tests assert non-2xx (some use `expect(err.response.status)`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/devtoberfest-faq-endpoint.test.js` (or `npm test -- devtoberfest-faq-endpoint` if the repo uses a wrapper)
Expected: FAIL — route not registered (404/handler missing).

- [ ] **Step 3: Add faqHandler and register the route**

In `srv/routes/devtoberfest-public.js`, add after `termsHandler` (before `bannerHandler`):

```js
async function faqHandler(_req, res) {
  try {
    await cds.connect.to('db');
    const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
    const config = await SELECT.one.from(DevtoberfestConfig).where({ isActive: true });
    if (!config) {
      return res.status(503).json({ error: 'EVENT_NOT_CONFIGURED' });
    }
    return res.status(200).json({ text: config.faqText || '' });
  } catch (err) {
    LOG.error('GET /api/devtoberfest/faq failed:', err);
    return res.status(500).json({ error: 'INTERNAL' });
  }
}
```

In `register(app)`, after the `/terms` line, add:

```js
  app.get('/api/devtoberfest/faq', _contextMw, _authMw, faqHandler);
```

Update the final export line to include it:

```js
export { statusHandler, termsHandler, faqHandler, bannerHandler };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/devtoberfest-faq-endpoint.test.js`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add srv/routes/devtoberfest-public.js test/unit/devtoberfest-faq-endpoint.test.js
git commit -m "feat(devtoberfest): GET /api/devtoberfest/faq endpoint"
```

---

## Task 9: Surface faqText in the admin Object Page

**Files:**
- Modify: `app/admin-annotations.cds:2794-2804` (field block) and `:2844-2846` (FieldGroup#Terms) and `:2834` (facet label)

**Interfaces:**
- Consumes: `DevtoberfestConfig.faqText` (Task 7).
- Produces: editable `faqText` multi-line field in the FE Object Page at `/admin-ui/#/devtoberfest`.

- [ ] **Step 1: Annotate faqText**

In `app/admin-annotations.cds`, in the `annotate AdminService.DevtoberfestConfig with { ... }` field block, add after the `termsText` annotation (after line ~2796):

```cds
  faqText           @title: 'FAQ (markdown)'
                    @Common.Label: 'FAQ (markdown)'
                    @UI.MultiLineText;
```

- [ ] **Step 2: Add faqText to the Terms field group and relabel the facet**

In the `@UI` block, change the Terms facet label (line ~2834) from:

```cds
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Terms',    Label: 'Content Rules / Terms' },
```

to:

```cds
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Terms',    Label: 'Content Rules, Terms & FAQ' },
```

And extend `FieldGroup#Terms` (line ~2844) from:

```cds
  FieldGroup#Terms: { Data: [
    { Value: termsText }
  ]},
```

to:

```cds
  FieldGroup#Terms: { Data: [
    { Value: termsText },
    { Value: faqText }
  ]},
```

- [ ] **Step 3: Compile-guard the annotations**

Run: `npx cds compile srv --to json >/dev/null 2>&1 && echo OK || npx cds compile srv 2>&1 | tail -20`
Expected: `OK` (annotations compile against the `faqText` element added in Task 7).

- [ ] **Step 4: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(devtoberfest): surface faqText in admin Object Page"
```

---

## Task 10: Full-suite verification + e2e coverage spec

**Files:**
- Create: `test/e2e/devtoberfest-rail-nav.spec.ts` (advisory e2e nudge for UI change)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a post-deploy Playwright spec asserting the 7 rail links + Rules/FAQ pages load.

- [ ] **Step 1: Run the hugo-apps unit suite**

Run: `cd hugo-apps && npx vitest run src/devtoberfest src/devtoberfest-rules src/devtoberfest-faq src/devtoberfest-shared`
Expected: all PASS.

- [ ] **Step 2: Run the backend unit suite (devtoberfest slice)**

Run: `npx vitest run test/unit/devtoberfest-faq-endpoint.test.js`
Expected: PASS.

- [ ] **Step 3: Write the e2e spec**

Create `test/e2e/devtoberfest-rail-nav.spec.ts`. Follow the auth/skip pattern in `test/e2e/README.md` and a sibling spec (self-skips when `SMOKE_BASE_URL`/`PLAYWRIGHT_BASE_URL` absent):

```ts
import { test, expect } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || process.env.SMOKE_BASE_URL;

test.describe('Devtoberfest rail navigation', () => {
  test.skip(!BASE, 'requires a deployed base URL');

  test('rail shows 7 links and Rules/FAQ pages load', async ({ page }) => {
    await page.goto(`${BASE}/devtoberfest/`);
    const rail = page.locator('.dtf-rail-item');
    await expect(rail).toHaveCount(7);

    await page.goto(`${BASE}/devtoberfest/rules/`);
    // Either rendered rules or the friendly empty state — never an error box.
    await expect(page.locator('.dtf-doc-error')).toHaveCount(0);
    await expect(page.locator('.dtf-doc-title')).toContainText('Rules');

    await page.goto(`${BASE}/devtoberfest/faq/`);
    await expect(page.locator('.dtf-doc-error')).toHaveCount(0);
    await expect(page.locator('.dtf-doc-title')).toContainText('FAQ');
  });
});
```

Adjust imports/config to match the existing `test/e2e/` specs (they may import a shared fixture for auth).

- [ ] **Step 4: Commit**

```bash
git add test/e2e/devtoberfest-rail-nav.spec.ts
git commit -m "test(devtoberfest): e2e spec for rail nav + Rules/FAQ pages"
```

---

## Task 11: Ship — PR

**Files:** none (git/PR only).

- [ ] **Step 1: Confirm branch and clean tree**

Run: `git branch --show-current && git status --porcelain`
Expected: on the worktree branch; only intended changes present.

- [ ] **Step 2: Push and open a draft PR**

```bash
git push -u origin HEAD
gh pr create --draft --title "feat(devtoberfest): right-rail nav + Rules & FAQ pages" --body "Implements docs/superpowers/specs/2026-08-02-devtoberfest-rail-nav-rules-faq-design.md

- 7-item static right rail (Weeks/Activities/Sessions/Arcade/Leaderboard/Rules/FAQ)
- Rules page renders termsText as markdown (existing /api/devtoberfest/terms)
- FAQ page: new faqText field + GET /api/devtoberfest/faq, admin-editable
- markdown via global window.markdownit + DOMPurify (no new dep)

FAQ renders empty until an admin pastes 2025 content into faqText via /admin-ui/#/devtoberfest.

Deploy note: FULL deploy required (admin annotation + islands) — npm run deploy -- --env dev (no --skip-build, no -m)."
```

- [ ] **Step 3: Report the PR URL**

State the PR URL back to Tom. Do NOT merge (open PR for review per project convention).

---

## Deploy checklist (post-merge, human-run)

Not a task — reference for whoever deploys:

- `git fetch origin` then deploy from primary tree on `main` (never a worktree).
- `npm run build:all` (Hugo must finish before `mbt build`).
- FULL deploy: `npm run deploy -- --env dev` — NO `--skip-build`, NO `-m` scoping (admin annotation + island bundles + Step 3.5 bundle gate).
- After deploy: admin pastes FAQ content into `faqText` at `/admin-ui/#/devtoberfest`; verify all 7 rail links + both pages in a browser (Tom's #1 rule: test the real thing).
