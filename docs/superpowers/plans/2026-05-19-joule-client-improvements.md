# Joule Client Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Joule chat panel to visual and functional parity with the official Joule client across SAP — markdown rendering, structured tutorial cards, official iconography, two-zone layout, AI Notice, and conversation starters — while keeping the existing buildless vanilla-JS architecture so the panel ships on every Hugo page without a bundler.

**Architecture:** The current panel is a vanilla-JS IIFE in `hugo/static/js/joule.js` consuming SSE from `/chat/stream`. We keep that shape and add: vendored UMD bundles for `markdown-it` + `DOMPurify` (no build step), a server-side `tutorial-cards` SSE event emitted after the existing `searchTutorials` tool runs (no LLM prompt change), per-page-kind starter chips loaded from a JSON partial, and a redesigned two-zone layout (purple-gradient hero + dark chrome) matching the reference Joule UI. Markdown is rendered via `DOMParser.parseFromString` after DOMPurify sanitization — never via direct `innerHTML` assignment, to satisfy the project's XSS guardrails.

**Tech Stack:** vanilla JS (no framework), Hugo partials, CSS custom properties, SSE, `markdown-it@14` (already a dependency), `dompurify@3` (to be added as devDep), Vitest with `happy-dom` for client unit tests. No new server runtime deps.

---

## Requirements Mapping

| # | User-reported item | Plan task |
|---|---|---|
| 1 | Loading indicator before first response | Task 9 (typing dots) |
| 2 | Auto-scroll as content streams | Task 8 (stick-to-bottom) |
| 3 | Render markdown (line breaks, bold, lists, headings) | Tasks 1, 7 |
| 4 | Tutorial hyperlinks active in responses | Task 7 (links via markdown) + Task 14 (cards) |
| 5 | Agent can send content back to main screen | Task 14 (card click navigates) |
| 6 | Clear chat history | Task 12 (overflow menu) |
| 7 | Replace Joule icon with official SVG | Task 4 |
| 8 | UI Integration Cards / ui5-ai PromptInput | Resolved as homegrown lightweight equivalents — see decision below |
| 9 | AI Notice entry + dialog | Task 13 |
| 10 | "Joule uses AI. Verify results." disclaimer | Task 10 |
| 11 | Expand/collapse panel | Task 11 |
| 12 | Paper-plane circular send button | Task 6 |
| 13 | Restyle to two-zone layout | Tasks 3, 5 |
| 14 | Context-specific starter chips | Tasks 15, 16 |

## Architectural Decision: Why not adopt UI Integration Cards / `@ui5/webcomponents-ai-react`?

The official Joule client uses SAP UI Integration Cards internally to render structured AI responses, and `@ui5/webcomponents-ai` provides a `PromptInput` component. We considered adopting both. We are not, for these reasons:

1. **Bundle weight on every page.** UI Integration Cards (`sap.ui.integration`) requires the full UI5 runtime (~500KB compressed before app code). The Joule panel is loaded on every Hugo page, including marketing pages where we currently ship ~30KB of CSS+JS total. A 15× increase is not acceptable for a feature that augments — but does not replace — page content.
2. **No buildless distribution.** `@ui5/webcomponents-ai-react` ships as ESM and requires a bundler (Vite). The Joule panel's defining quality is that it has no build pipeline — adding one creates a coupling between Hugo build and the panel that we don't have today.
3. **No drop-in chat shell.** There is no public "Joule chat panel" web component. Adopting UI Integration Cards would mean *building* a chat client on top of them; that's strictly more work than the current homegrown shell.

We deliver the *outcomes* the user wanted (structured tutorial cards, AI-styled input affordance) with ~30 lines of vanilla JS and ~40 lines of CSS — see Tasks 14 and 5. If the team later commits to a build step for the panel, migrating to the UI5 components becomes a clean refactor of the renderer layer; nothing in this plan blocks that future move.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `hugo/layouts/partials/joule-panel.html` | Modify | Two-zone layout markup, overflow menu, expand button, AI Notice sub-view, footer disclaimer |
| `hugo/layouts/partials/joule-icon.html` | Create | Official Joule diamond+stars SVG (single source of truth for the mark) |
| `hugo/layouts/partials/joule-starters.html` | Create | Emits `<script id="joule-starters" type="application/json">{...}</script>` with per-page-kind starter prompts |
| `hugo/layouts/_default/baseof.html` | Modify | Pull in vendored markdown-it + DOMPurify before joule.js |
| `hugo/layouts/partials/header.html` | Modify | Replace `joule-trigger` icon with the new partial |
| `hugo/static/js/joule.js` | Modify | Auto-scroll, typing dots, expand toggle, overflow menu, AI Notice handler, tutorial-cards renderer, starters wiring |
| `hugo/static/js/joule-render.js` | Create | Buildless render module exposing `window.__jouleRender.setMarkdown` for both production and tests |
| `hugo/static/js/vendor/markdown-it.min.js` | Create (copy) | UMD bundle from `node_modules/markdown-it/dist/markdown-it.min.js` |
| `hugo/static/js/vendor/purify.min.js` | Create (copy) | UMD bundle from `node_modules/dompurify/dist/purify.min.js` |
| `hugo/static/css/joule.css` | Rewrite | Two-zone layout, hero gradient, dark chrome, typing dots, AI Notice overlay, expanded mode, round send button, card chrome |
| `srv/lib/chat-orchestrator.js` | Modify | After `searchTutorials` tool dispatch, emit `{type:'tutorial-cards', items}` SSE event |
| `test/chat-orchestrator.test.js` | Modify | Add test for the new `tutorial-cards` event |
| `test/joule-render.test.js` | Create | Vitest unit tests for the render module (happy-dom; loads real vendored bundles) |
| `vitest.config.ts` | Modify | Allow `happy-dom` env for client tests |
| `package.json` | Modify | Add `dompurify` devDep + `happy-dom` devDep + `copy-vendor` script |
| `scripts/copy-joule-vendor.mjs` | Create | One-shot copy of vendored bundles into `hugo/static/js/vendor/` |
| `test/smoke/joule-panel.test.js` | Create | Smoke test: vendored bundles return 200, partial renders icon, AI Notice button present |

---

## Phase 1 — Vendor & Test Scaffolding

Goal: lay the dependency and test foundation before touching user-visible code.

### Task 1: Vendor markdown-it and DOMPurify

**Files:**
- Modify: `package.json`
- Create: `scripts/copy-joule-vendor.mjs`
- Create: `hugo/static/js/vendor/.gitkeep`

- [ ] **Step 1: Verify candidate version is older than 24h**

The global npmrc enforces `min-release-age=86400` (24h). Before pinning, check publish times and pick the newest version that is at least 24h old:

```bash
npm view dompurify versions --json | tail -20
npm view dompurify@3.2.4 time.created
```

If the chosen version is newer than 24h, step back to the previous patch (e.g., `3.2.3`). Record the chosen version below before installing.

- [ ] **Step 2: Add devDependency**

```bash
npm add -D dompurify@<chosen-version>
```

Expected: `dompurify` appears under `devDependencies` in `package.json` with an exact version (no `^`, due to global `save-exact=true`). (`markdown-it` is already present.)

- [ ] **Step 3: Add the copy script**

Create `scripts/copy-joule-vendor.mjs`:

```js
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'hugo/static/js/vendor');
await mkdir(target, { recursive: true });

const files = [
  ['node_modules/markdown-it/dist/markdown-it.min.js', 'markdown-it.min.js'],
  ['node_modules/dompurify/dist/purify.min.js',         'purify.min.js']
];

for (const [src, name] of files) {
  await copyFile(resolve(root, src), resolve(target, name));
  console.log(`copied ${name}`);
}
```

- [ ] **Step 4: Wire the script into npm**

Add to `package.json` `scripts`:

```json
"copy-joule-vendor": "node scripts/copy-joule-vendor.mjs"
```

Make `build:all` invoke it before `build:hugo`:

```json
"build:all": "npm run fetch-tutorials && npm run build:css && npm run build:apps && npm run copy-joule-vendor && npm run build:hugo && npm run build:highlight && npm run build:display"
```

- [ ] **Step 4: Run the copy script**

Run: `npm run copy-joule-vendor`
Expected output: `copied markdown-it.min.js` and `copied purify.min.js`. Both files exist under `hugo/static/js/vendor/`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json scripts/copy-joule-vendor.mjs hugo/static/js/vendor/
git commit -m "chore(joule): vendor markdown-it and DOMPurify for buildless rendering"
```

---

### Task 2: Add `happy-dom` to the unit test workspace

**Files:**
- Modify: `package.json`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Install happy-dom**

```bash
npm add -D happy-dom@15
```

- [ ] **Step 2: Update vitest config**

In `vitest.config.ts`, find the `unit` project and set `environment: 'happy-dom'`. Other workspaces (hybrid, smoke) are unchanged.

```ts
{
  test: {
    name: 'unit',
    environment: 'happy-dom',
    include: ['test/**/*.test.js', 'scripts/**/*.test.ts'],
    exclude: ['test/hybrid/**', 'test/smoke/**']
  }
}
```

- [ ] **Step 3: Verify existing tests still pass**

Run: `npm test`
Expected: all existing unit tests pass. `chat-orchestrator.test.js` runs unchanged (it doesn't touch `document`).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "test(joule): switch unit workspace to happy-dom for client tests"
```

---

## Phase 2 — Visual Identity

Goal: official iconography, layout shell, and the chrome that the rest of the work will hang off.

### Task 3: Restructure the panel partial to two zones

**Files:**
- Modify: `hugo/layouts/partials/joule-panel.html`

Replace the whole file with the markup below. Two zones:
- `.joule-panel__hero` — purple gradient empty state (greeting + starters)
- `.joule-panel__chat` — dark chrome (messages + input)

Initial state shows the hero only. As soon as the first message is sent, JS toggles to the chat zone.

- [ ] **Step 1: Replace the partial**

```html
<div id="joule-panel" hidden role="dialog" aria-modal="false" aria-labelledby="joule-panel-title">
  <header class="joule-panel__header">
    {{ partial "joule-icon.html" . }}
    <h2 id="joule-panel-title" class="joule-panel__title">Joule</h2>
    <button type="button" class="joule-panel__icon-btn" data-action="expand" aria-label="Expand">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h5v2H4v3H2zM9 2h5v5h-2V4H9zM2 9h2v3h3v2H2zM12 9h2v5H9v-2h3z"/></svg>
    </button>
    <button type="button" class="joule-panel__icon-btn" data-action="overflow" aria-label="More options" aria-haspopup="true" aria-expanded="false">
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>
    </button>
    <button type="button" class="joule-panel__icon-btn joule-panel__close" aria-label="Close">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
    </button>
  </header>

  <div class="joule-panel__overflow" hidden role="menu">
    <button type="button" role="menuitem" data-overflow="clear">Clear chat</button>
    <button type="button" role="menuitem" data-overflow="ai-notice">AI Notice</button>
  </div>

  <section class="joule-panel__banner" hidden></section>

  <section class="joule-panel__hero">
    <div class="joule-panel__hero-mark">{{ partial "joule-icon.html" (dict "size" "large") }}</div>
    <p class="joule-panel__hero-greeting" data-default-greeting="Hello, How can I help you?"></p>
    <div class="joule-panel__starters" role="list"></div>
  </section>

  <section class="joule-panel__chat" hidden>
    <div class="joule-panel__transcript" aria-live="polite"></div>
  </section>

  <section class="joule-panel__ai-notice" hidden aria-labelledby="joule-ai-notice-title">
    <header class="joule-panel__ai-notice-header">
      <button type="button" class="joule-panel__icon-btn" data-action="ai-notice-back" aria-label="Back">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 2L4 8l6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <h3 id="joule-ai-notice-title">AI Notice</h3>
    </header>
    <div class="joule-panel__ai-notice-body">
      <p>Joule is an AI assistant. Generative AI may produce inaccurate, incomplete, or biased information. Always verify important details before acting on them.</p>
      <p>Conversations are sent to SAP-hosted large language models for processing. Do not include personal data, credentials, or confidential information in your messages.</p>
      <p>Joule's responses are based on the SAP tutorial catalog and may not reflect the latest product changes. For authoritative guidance, consult the linked tutorials and official SAP documentation.</p>
    </div>
  </section>

  <footer class="joule-panel__footer">
    <form class="joule-panel__form" autocomplete="off">
      <input class="joule-panel__input" name="message" type="text" placeholder="Message Joule" aria-label="Message Joule" />
      <button type="submit" class="joule-panel__send" aria-label="Send">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.5L21 3l-8.5 18-2.5-8z" fill="currentColor"/></svg>
      </button>
    </form>
    <p class="joule-panel__disclaimer">Joule uses AI. Verify results.</p>
  </footer>
</div>
```

- [ ] **Step 2: Build Hugo and visually inspect**

```bash
npm run build:hugo
```

Open any built HTML page from `hugo/public/` and confirm the panel structure renders (it stays `hidden` until `joule.js` opens it; we'll wire JS in later tasks).

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/partials/joule-panel.html
git commit -m "feat(joule): two-zone layout (hero + chat) with overflow + AI Notice scaffold"
```

---

### Task 4: Add the official Joule SVG mark

**Files:**
- Create: `hugo/layouts/partials/joule-icon.html`
- Modify: `hugo/layouts/partials/header.html`

- [ ] **Step 1: Create the icon partial**

The official mark is a 122×120 viewBox with the diamond + 3 stars. Use the variable `--dasSplashScreenImageColor` so the icon respects the SAP Design Asset System color when present, and falls back to white.

```html
{{- $size := default "small" .size -}}
{{- $w := cond (eq $size "large") "64" "24" -}}
<span class="joule-mark joule-mark--{{ $size }}" aria-hidden="true">
  <svg width="{{ $w }}" viewBox="0 0 122 120" xmlns="http://www.w3.org/2000/svg" fill="none">
    <path d="M61 8 L102 60 L61 112 L20 60 Z" fill="var(--dasSplashScreenImageColor, #ffffff)"/>
    <path d="M101 12 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 z" fill="var(--dasSplashScreenImageColor, #ffffff)"/>
    <path d="M114 38 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2 z" fill="var(--dasSplashScreenImageColor, #ffffff)"/>
    <path d="M97 88 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2 z" fill="var(--dasSplashScreenImageColor, #ffffff)"/>
  </svg>
</span>
```

> **Note:** The path coordinates above are an approximation of the brand mark proportions Tom shared. If the design team provides the exact SVG asset, drop it in here verbatim — the rest of the plan does not depend on these specific coordinates.

- [ ] **Step 2: Replace the trigger icon in the header partial**

In `hugo/layouts/partials/header.html`, find the `<button id="joule-trigger" ...>` and replace its inner CSS-rotated diamond span with the partial:

```html
<button id="joule-trigger" type="button" hidden aria-label="Open Joule">
  {{ partial "joule-icon.html" . }}
</button>
```

- [ ] **Step 3: Build and verify**

```bash
npm run build:hugo
```

Open any built page; the trigger icon in the header should now be the SVG mark, not the CSS diamond.

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/partials/joule-icon.html hugo/layouts/partials/header.html
git commit -m "feat(joule): replace trigger icon with official Joule SVG mark"
```

---

### Task 5: Rewrite the panel CSS (two-zone)

**Files:**
- Rewrite: `hugo/static/css/joule.css`

- [ ] **Step 1: Replace the file**

```css
:root {
  --joule-purple-1: #5D36FF;
  --joule-purple-2: #7B42F0;
  --joule-purple-3: #A100C2;
  --joule-chrome:   #14082F;
  --joule-chrome-2: #1F1340;
  --joule-text:     #f5f5fb;
  --joule-muted:    rgba(245,245,251,.65);
  --joule-radius:   16px;
}

#joule-panel {
  position: fixed; top: 4rem; right: 1rem;
  width: min(420px, calc(100vw - 2rem));
  height: min(640px, calc(100vh - 5rem));
  display: none;
  flex-direction: column;
  background: var(--joule-chrome);
  color: var(--joule-text);
  border-radius: var(--joule-radius);
  box-shadow: 0 20px 60px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.06);
  z-index: 9000;
  overflow: hidden;
}
#joule-panel:not([hidden]) { display: flex; }
#joule-panel[data-expanded="true"] {
  width: min(720px, calc(100vw - 2rem));
  height: calc(100vh - 5rem);
}

.joule-panel__header {
  display: flex; align-items: center; gap: .5rem;
  padding: .9rem 1rem;
  background: linear-gradient(165deg, var(--joule-purple-1) 0%, var(--joule-purple-2) 45%, var(--joule-purple-3) 100%);
}
.joule-panel__title { flex: 1; margin: 0; font-size: 1rem; font-weight: 600; }
.joule-panel__icon-btn {
  background: none; border: 0; color: inherit;
  width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 6px; cursor: pointer;
}
.joule-panel__icon-btn:hover { background: rgba(255,255,255,.12); }
.joule-panel__icon-btn svg { width: 16px; height: 16px; fill: currentColor; }

.joule-panel__overflow {
  position: absolute; top: 3.4rem; right: 3rem;
  background: var(--joule-chrome-2);
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 8px; padding: .25rem; min-width: 160px;
  box-shadow: 0 8px 24px rgba(0,0,0,.4); z-index: 1;
}
.joule-panel__overflow button {
  display: block; width: 100%; text-align: left;
  background: none; border: 0; color: inherit;
  padding: .5rem .75rem; border-radius: 6px; cursor: pointer; font-size: .9rem;
}
.joule-panel__overflow button:hover { background: rgba(255,255,255,.08); }

.joule-panel__banner { padding: .5rem 1rem; font-size: .85rem; opacity: .85;
  background: rgba(0,0,0,.2); }

.joule-panel__hero {
  flex: 1; overflow-y: auto;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 1.5rem 1rem;
  background: linear-gradient(165deg, var(--joule-purple-1) 0%, var(--joule-purple-2) 45%, var(--joule-purple-3) 100%);
  text-align: center;
}
.joule-panel__hero-mark { margin-bottom: 1rem; }
.joule-panel__hero-greeting { margin: 0 0 1.25rem; font-size: 1.15rem; font-weight: 500; }
.joule-panel__starters {
  display: flex; flex-direction: column; gap: .5rem;
  width: 100%; max-width: 320px;
}
.joule-panel__starter {
  background: rgba(255,255,255,.12);
  border: 1px solid rgba(255,255,255,.18);
  color: inherit; padding: .55rem .85rem; border-radius: 999px;
  cursor: pointer; font-size: .85rem; text-align: left;
  transition: background .15s;
}
.joule-panel__starter:hover { background: rgba(255,255,255,.22); }

.joule-panel__chat { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.joule-panel__chat[hidden] { display: none; }
.joule-panel__footer[hidden] { display: none; }
.joule-panel__transcript {
  flex: 1; overflow-y: auto; padding: 1rem;
  display: flex; flex-direction: column; gap: .5rem;
  scroll-behavior: smooth;
}

.joule-msg {
  padding: .65rem .85rem; border-radius: 12px; max-width: 85%;
  line-height: 1.5; word-wrap: break-word; font-size: .92rem;
}
.joule-msg--user { align-self: flex-end; background: rgba(255,255,255,.1); }
.joule-msg--assistant { align-self: flex-start; background: var(--joule-chrome-2); }
.joule-msg--error { background: #5a1f1f; }
.joule-msg p { margin: 0 0 .5rem; }
.joule-msg p:last-child { margin-bottom: 0; }
.joule-msg pre { background: rgba(0,0,0,.35); padding: .5rem .65rem; border-radius: 6px; overflow-x: auto; }
.joule-msg code { background: rgba(0,0,0,.35); padding: .1em .3em; border-radius: 3px; font-size: .9em; }
.joule-msg pre code { background: none; padding: 0; }
.joule-msg ul, .joule-msg ol { margin: .25rem 0 .5rem 1.25rem; padding: 0; }
.joule-msg a { color: #b487ff; text-decoration: underline; }
.joule-msg a:hover { color: #d4b8ff; }

.joule-typing {
  display: inline-flex; gap: 4px; align-items: center;
  padding: .65rem .85rem; background: var(--joule-chrome-2); border-radius: 12px;
  align-self: flex-start;
}
.joule-typing span {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--joule-muted);
  animation: jouleBlink 1.2s infinite ease-in-out;
}
.joule-typing span:nth-child(2) { animation-delay: .2s; }
.joule-typing span:nth-child(3) { animation-delay: .4s; }
@keyframes jouleBlink { 0%,80%,100% { opacity:.25 } 40% { opacity:1 } }

.joule-tool-chip {
  align-self: flex-start; font-size: .75rem;
  padding: .15rem .55rem; border-radius: 999px;
  background: rgba(255,255,255,.12);
}

.joule-cards { display: flex; flex-direction: column; gap: .5rem; align-self: stretch; }
.joule-card {
  background: var(--joule-chrome-2);
  border: 1px solid rgba(255,255,255,.08);
  border-radius: 10px; padding: .65rem .8rem; cursor: pointer; text-align: left;
  color: inherit; font: inherit;
  transition: background .15s, border-color .15s;
}
.joule-card:hover { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.2); }
.joule-card__title { font-weight: 600; margin: 0 0 .15rem; font-size: .92rem; }
.joule-card__desc  { margin: 0 0 .25rem; font-size: .82rem; color: var(--joule-muted); }
.joule-card__tag   { font-size: .7rem; color: var(--joule-muted); text-transform: uppercase; letter-spacing: .05em; }

.joule-panel__ai-notice { flex: 1; display: flex; flex-direction: column; min-height: 0;
  background: var(--joule-chrome); }
.joule-panel__ai-notice[hidden] { display: none; }
.joule-panel__ai-notice-header {
  display: flex; align-items: center; gap: .5rem; padding: .5rem 1rem;
  border-bottom: 1px solid rgba(255,255,255,.1);
}
.joule-panel__ai-notice-header h3 { margin: 0; font-size: 1rem; }
.joule-panel__ai-notice-body { overflow-y: auto; padding: 1rem; line-height: 1.5; font-size: .9rem; }
.joule-panel__ai-notice-body p { margin: 0 0 .75rem; }

.joule-panel__footer { background: var(--joule-chrome); border-top: 1px solid rgba(255,255,255,.1); }
.joule-panel__form { display: flex; gap: .5rem; padding: .75rem 1rem .25rem; align-items: center; }
.joule-panel__input {
  flex: 1; padding: .65rem .85rem; border-radius: 999px; border: 1px solid rgba(255,255,255,.15);
  background: var(--joule-chrome-2); color: var(--joule-text); font-size: .9rem;
}
.joule-panel__input::placeholder { color: var(--joule-muted); }
.joule-panel__input:focus { outline: none; border-color: var(--joule-purple-2); }
.joule-panel__send {
  width: 36px; height: 36px; border-radius: 50%; border: 0;
  background: var(--joule-purple-1); color: #fff; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
}
.joule-panel__send:hover { background: var(--joule-purple-2); }
.joule-panel__send:disabled { background: rgba(255,255,255,.15); cursor: not-allowed; }
.joule-panel__send svg { width: 16px; height: 16px; }
.joule-panel__disclaimer { margin: 0; padding: 0 1rem .65rem; font-size: .7rem;
  color: var(--joule-muted); text-align: center; }

.joule-mark--small svg { width: 24px; height: 24px; }
.joule-mark--large svg { width: 64px; height: 64px;
  filter: drop-shadow(0 4px 12px rgba(0,0,0,.35)); }
```

- [ ] **Step 2: Build and visually verify**

```bash
npm run build:css && npm run build:hugo
```

Open any page in a browser, click the trigger. The panel should show the hero (purple gradient) with the large mark, an empty greeting, and the input area at the bottom (dark, round button). The chat zone is hidden until messages exist.

- [ ] **Step 3: Commit**

```bash
git add hugo/static/css/joule.css
git commit -m "feat(joule): two-zone layout styles (hero gradient + dark chrome)"
```

---

### Task 6: Wire close button + keep stub JS working

**Files:**
- Modify: `hugo/static/js/joule.js`

The existing `close()` handler queries `.joule-panel__close`. The new markup keeps that class, so close still works. We need to confirm the input/form selectors still match (they do: `.joule-panel__input`, `.joule-panel__form`).

- [ ] **Step 1: Smoke-run the existing JS against the new markup**

Run: `npm run build:hugo && python3 -m http.server -d hugo/public 8080` (or any static server). Open a page, click the trigger, type "hi", verify a request is sent to `/chat/stream` (it will fail without CAP running — that's fine, we're checking the JS still wires up).

No code changes in this step — just confirm the markup change didn't break the wiring. If the existing handlers throw, fix the selectors before moving on.

- [ ] **Step 2: Commit if any selector fixes were needed**

(Skip if Step 1 was clean.)

---

## Phase 3 — Core UX Fixes

Goal: markdown, scroll, typing indicator, disclaimer.

### Task 7: Render markdown safely

**Files:**
- Modify: `hugo/layouts/_default/baseof.html`
- Create: `hugo/static/js/joule-render.js`
- Modify: `hugo/static/js/joule.js`
- Create: `test/joule-render.test.js`

> **Why a separate `joule-render.js`?** The existing `joule.js` is an IIFE — its internals can't be imported by a test. Rather than duplicate the renderer in the test (which guarantees drift), we extract the pure render helpers into a tiny sibling script that exposes `window.__jouleRender` for both production and tests. Same buildless model, no extra runtime cost.

- [ ] **Step 1: Load the vendored bundles + render module**

In `hugo/layouts/_default/baseof.html`, before the existing `<script defer src="{{ "/js/joule.js" | relURL }}"></script>`, add — order matters, defer scripts execute in document order:

```html
<script defer src="{{ "/js/vendor/markdown-it.min.js" | relURL }}"></script>
<script defer src="{{ "/js/vendor/purify.min.js" | relURL }}"></script>
<script defer src="{{ "/js/joule-render.js" | relURL }}"></script>
```

- [ ] **Step 2: Create the render module**

Create `hugo/static/js/joule-render.js`:

```js
(function () {
  'use strict';
  if (!window.markdownit || !window.DOMPurify) return;

  const md = window.markdownit({ html: false, linkify: true, breaks: true });

  function setMarkdown(target, source) {
    if (!source) { target.replaceChildren(); return; }
    const dirty = md.render(source);
    const clean = window.DOMPurify.sanitize(dirty, { USE_PROFILES: { html: true } });
    // Materialize sanitized HTML as DOM nodes without an innerHTML write on a live element.
    const doc = new DOMParser().parseFromString(clean, 'text/html');
    target.replaceChildren(...doc.body.childNodes);
    target.querySelectorAll('a[href]').forEach(a => {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    });
  }

  window.__jouleRender = { setMarkdown };
})();
```

- [ ] **Step 3: Use it from joule.js**

Replace `appendMessage` so assistant messages render as markdown and user messages stay plain:

```js
function appendMessage(role, content, opts = {}) {
  const div = document.createElement('div');
  div.className = `joule-msg joule-msg--${role}`;
  if (role === 'assistant') window.__jouleRender.setMarkdown(div, content);
  else div.textContent = content;
  if (opts.id) div.dataset.id = opts.id;
  transcript.appendChild(div);
  return div;
}
```

In the SSE delta branch, swap `assistantBubble.textContent = assistantText` for `window.__jouleRender.setMarkdown(assistantBubble, assistantText)`.

- [ ] **Step 4: Write a unit test**

Create `test/joule-render.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

beforeAll(() => {
  // Load the actual vendored libs and render module into the happy-dom window.
  const root = resolve(process.cwd());
  const mdSrc     = readFileSync(resolve(root, 'hugo/static/js/vendor/markdown-it.min.js'), 'utf8');
  const purifySrc = readFileSync(resolve(root, 'hugo/static/js/vendor/purify.min.js'),       'utf8');
  const renderSrc = readFileSync(resolve(root, 'hugo/static/js/joule-render.js'),            'utf8');
  // happy-dom exposes globals already; eval into the document scope
  // eslint-disable-next-line no-eval
  (0, eval)(mdSrc + ';' + purifySrc + ';' + renderSrc);
});

describe('joule render', () => {
  it('renders bold and lists as DOM nodes', () => {
    const div = document.createElement('div');
    window.__jouleRender.setMarkdown(div, 'Hello **world**\n\n- one\n- two');
    expect(div.querySelector('strong')?.textContent).toBe('world');
    expect(div.querySelectorAll('li').length).toBe(2);
  });

  it('opens links in a new tab with rel=noopener', () => {
    const div = document.createElement('div');
    window.__jouleRender.setMarkdown(div, '[click](https://example.com)');
    const a = div.querySelector('a');
    expect(a?.target).toBe('_blank');
    expect(a?.rel).toMatch(/noopener/);
  });

  it('strips script tags via DOMPurify', () => {
    const div = document.createElement('div');
    window.__jouleRender.setMarkdown(div, 'safe<script>alert(1)</script>text');
    expect(div.querySelector('script')).toBeNull();
  });

  it('clears content for empty source', () => {
    const div = document.createElement('div');
    div.textContent = 'old';
    window.__jouleRender.setMarkdown(div, '');
    expect(div.textContent).toBe('');
  });
});
```

> Loading the real vendor bundles into happy-dom catches DOMPurify config drift that a stub renderer would miss.

- [ ] **Step 5: Run the test**

Run: `npx vitest run test/joule-render.test.js`
Expected: 4 tests pass.

- [ ] **Step 6: Visual check**

Run the dev server, send a message that asks for a list ("give me three SAP CAP tutorials as a bulleted list"). Confirm the response renders as a real `<ul>` with proper line breaks, not raw markdown.

- [ ] **Step 7: Commit**

```bash
git add hugo/layouts/_default/baseof.html hugo/static/js/joule-render.js hugo/static/js/joule.js test/joule-render.test.js
git commit -m "feat(joule): render markdown safely via DOMPurify + DOMParser"
```

---

### Task 8: Stick-to-bottom auto-scroll

**Files:**
- Modify: `hugo/static/js/joule.js`

- [ ] **Step 1: Add the helper**

Inside the IIFE:

```js
const STICK_THRESHOLD_PX = 80;

function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
}

function scrollToBottom(el, force = false) {
  if (force || isNearBottom(el)) el.scrollTop = el.scrollHeight;
}
```

- [ ] **Step 2: Call it in the right places**

After `appendMessage` returns: `scrollToBottom(transcript, true)` (force on new bubble append, the user just sent a message).

In the delta branch, after `setMarkdown(assistantBubble, assistantText)`: `scrollToBottom(transcript)` (no force — only follow if the user is near the bottom).

- [ ] **Step 3: Manual test**

Send a long question. Scroll up while the response streams. Confirm the panel does NOT yank you back down. Scroll back near the bottom; confirm new content brings you with it.

- [ ] **Step 4: Commit**

```bash
git add hugo/static/js/joule.js
git commit -m "feat(joule): stick-to-bottom auto-scroll during streaming"
```

---

### Task 9: Typing indicator before first delta

**Files:**
- Modify: `hugo/static/js/joule.js`

- [ ] **Step 1: Add a typing-dots element**

In the `send` function, replace the existing `const assistantBubble = appendMessage('assistant', '');` and the `let assistantText = '';` block with:

```js
const typingEl = document.createElement('div');
typingEl.className = 'joule-typing';
for (let i = 0; i < 3; i++) typingEl.appendChild(document.createElement('span'));
transcript.appendChild(typingEl);
scrollToBottom(transcript, true);

let assistantBubble = null;
let assistantText = '';

function ensureBubble() {
  if (assistantBubble) return assistantBubble;
  typingEl.remove();
  assistantBubble = appendMessage('assistant', '');
  return assistantBubble;
}
```

In the delta event branch, swap the bubble update for:

```js
if (payload.type === 'delta') {
  assistantText += payload.content;
  window.__jouleRender.setMarkdown(ensureBubble(), assistantText);
  scrollToBottom(transcript);
}
```

In the `done`, `error`, and tool branches, also call `typingEl.remove()` (idempotent — it's a no-op if already removed).

- [ ] **Step 2: Manual test**

Send a message. Confirm three pulsing dots appear immediately, then disappear when the first delta arrives.

- [ ] **Step 3: Commit**

```bash
git add hugo/static/js/joule.js
git commit -m "feat(joule): typing indicator before first streaming token"
```

---

### Task 10: Wire the disclaimer (already in markup)

**Files:** none — Task 3 already added `.joule-panel__disclaimer` with the literal text. This task is a verification only.

- [ ] **Step 1: Verify**

Open any page, open the panel, confirm "Joule uses AI. Verify results." is visible below the input.

(Skip commit — nothing changed.)

---

## Phase 4 — Information Architecture

Goal: expand/collapse, overflow menu (clear chat), AI Notice routing.

### Task 11: Expand / collapse

**Files:**
- Modify: `hugo/static/js/joule.js`

- [ ] **Step 1: Wire the button**

Inside the IIFE, after the existing button bindings:

```js
const expandBtn = panel.querySelector('[data-action="expand"]');
expandBtn.addEventListener('click', () => {
  const expanded = panel.dataset.expanded === 'true';
  panel.dataset.expanded = expanded ? 'false' : 'true';
  expandBtn.setAttribute('aria-label', expanded ? 'Expand' : 'Collapse');
});
```

- [ ] **Step 2: Manual test**

Click the expand button. Panel grows to ~720×viewport. Click again. Returns to default.

- [ ] **Step 3: Commit**

```bash
git add hugo/static/js/joule.js
git commit -m "feat(joule): expand/collapse panel toggle"
```

---

### Task 12: Overflow menu — Clear chat

**Files:**
- Modify: `hugo/static/js/joule.js`

- [ ] **Step 1: Wire overflow button + clear**

```js
const overflowBtn = panel.querySelector('[data-action="overflow"]');
const overflowMenu = panel.querySelector('.joule-panel__overflow');

overflowBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = !overflowMenu.hidden;
  overflowMenu.hidden = open;
  overflowBtn.setAttribute('aria-expanded', String(!open));
});
document.addEventListener('click', (e) => {
  if (!overflowMenu.hidden && !overflowMenu.contains(e.target) && e.target !== overflowBtn) {
    overflowMenu.hidden = true;
    overflowBtn.setAttribute('aria-expanded', 'false');
  }
});

overflowMenu.querySelector('[data-overflow="clear"]').addEventListener('click', () => {
  sessionStorage.removeItem(HISTORY_KEY);
  transcript.replaceChildren();
  showHero();
  overflowMenu.hidden = true;
  overflowBtn.setAttribute('aria-expanded', 'false');
});
```

Add a `showHero` helper that toggles between the hero and chat zones:

```js
const heroEl = panel.querySelector('.joule-panel__hero');
const chatEl = panel.querySelector('.joule-panel__chat');

function showHero() { heroEl.hidden = false; chatEl.hidden = true; }
function showChat() { heroEl.hidden = true; chatEl.hidden = false; }
```

In `send`, call `showChat()` at the top before appending the user message. In `open`, call `showHero()` if there's no history, otherwise `showChat()`.

- [ ] **Step 2: Manual test**

Send messages, click overflow → Clear chat. Transcript empties, hero returns. Reload page; history is gone.

- [ ] **Step 3: Commit**

```bash
git add hugo/static/js/joule.js
git commit -m "feat(joule): overflow menu + clear chat history"
```

---

### Task 13: AI Notice sub-view

**Files:**
- Modify: `hugo/static/js/joule.js`

- [ ] **Step 1: Wire AI Notice navigation**

```js
const aiNoticeEl = panel.querySelector('.joule-panel__ai-notice');
const footerEl = panel.querySelector('.joule-panel__footer');

function showAINotice() {
  heroEl.hidden = true;
  chatEl.hidden = true;
  aiNoticeEl.hidden = false;
  footerEl.hidden = true;
}

function hideAINotice() {
  aiNoticeEl.hidden = true;
  footerEl.hidden = false;
  const hasHistory = (loadHistory() || []).length > 0;
  if (hasHistory) showChat(); else showHero();
}

overflowMenu.querySelector('[data-overflow="ai-notice"]').addEventListener('click', () => {
  showAINotice();
  overflowMenu.hidden = true;
  overflowBtn.setAttribute('aria-expanded', 'false');
});

panel.querySelector('[data-action="ai-notice-back"]').addEventListener('click', hideAINotice);
```

- [ ] **Step 2: Manual test**

Click overflow → AI Notice. Sub-view appears with the disclaimer text. Click back arrow. Returns to whatever was previously visible (hero or chat).

- [ ] **Step 3: Commit**

```bash
git add hugo/static/js/joule.js
git commit -m "feat(joule): AI Notice sub-view with back navigation"
```

---

## Phase 5 — Structured Responses & Starters

Goal: tutorial cards from server tool, per-page starter chips.

### Task 14: Server emits `tutorial-cards` SSE event

**Files:**
- Modify: `srv/lib/chat-orchestrator.js`
- Modify: `test/chat-orchestrator.test.js`

> **Tool-call shape note (read first):** The SDK's `getToolCalls()` returns objects shaped `{ id, function: { name, arguments } }`, and the production code at [srv/lib/chat-orchestrator.js:128-131](../../../srv/lib/chat-orchestrator.js#L128-L131) reads `tc.function?.name` / `tc.function?.arguments`. The existing tests at [test/chat-orchestrator.test.js:70-73](../../../test/chat-orchestrator.test.js#L70-L73) use a flat `{ id, name, args }` fixture — that is stale and only passes because its assertions check surface SSE patterns. Before adding the new test, fix the existing fixtures in the file so they emit the canonical `function: { name, arguments }` shape; otherwise the new behavior under test in this task may regress silently.

- [ ] **Step 1: Realign existing fixtures to the canonical SDK shape**

In `test/chat-orchestrator.test.js`, find every `getToolCalls: () => [...]` and replace flat-shape fixtures with:

```js
getToolCalls: () => [{ id: 't1', function: { name: 'searchTutorials', arguments: '{"query":"cap"}' } }]
```

Run `npx vitest run test/chat-orchestrator.test.js` — all existing tests should still pass. If any now fail, the production code was relying on the wrong shape; fix the test fixture to match the SDK, never the other way around.

- [ ] **Step 2: Write the failing test for the new event**

Append:

```js
it('emits a tutorial-cards SSE event after searchTutorials returns hits', async () => {
  const searchRun = vi.fn().mockResolvedValue([
    { slug: 'a', title: 'A', description: 'desc', type: 'tutorial', primaryTag: 'cap' }
  ]);
  connectMock.mockResolvedValue({ run: searchRun });

  streamMock.mockReturnValueOnce(makeStream([
    { getDeltaContent: () => null,
      getToolCalls: () => [{ id: 't1', function: { name: 'searchTutorials', arguments: '{"query":"cap"}' } }] }
  ]));
  streamMock.mockReturnValueOnce(makeStream([
    { getDeltaContent: () => 'ok', getToolCalls: () => null }
  ]));

  const res = fakeRes();
  await streamChat({ res, system: 's', messages: [{ role: 'user', content: 'find cap' }], deploymentId: 'd1' });

  const joined = res.chunks.join('');
  expect(joined).toMatch(/"type":"tutorial-cards"/);
  expect(joined).toMatch(/"slug":"a"/);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/chat-orchestrator.test.js`
Expected: the new test FAILS (no `tutorial-cards` event emitted yet); all other tests still pass.

- [ ] **Step 4: Implement**

In `srv/lib/chat-orchestrator.js`, find the for-of loop that runs tools (around line 150):

```js
for (const tc of collectedToolCalls) {
  const result = await dispatchTool(tc.name, tc.args || {});
  history.push({
    role: 'tool',
    tool_call_id: tc.id,
    content: JSON.stringify(result)
  });
  if (tc.name === 'searchTutorials' && Array.isArray(result) && result.length > 0) {
    sse(res, { type: 'tutorial-cards', items: result });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/chat-orchestrator.test.js`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/chat-orchestrator.js test/chat-orchestrator.test.js
git commit -m "feat(joule): emit tutorial-cards SSE event after searchTutorials"
```

---

### Task 15: Client renders tutorial cards

**Files:**
- Modify: `hugo/static/js/joule.js`

- [ ] **Step 1: Add the renderer**

Inside the IIFE:

```js
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/i;

function safeNavigate(type, slug) {
  if (typeof slug !== 'string' || !SAFE_SLUG_RE.test(slug)) {
    LOG_NOOP(); // see comment below
    return;
  }
  const path = type === 'mission' ? `/missions/${slug}/`
             : type === 'group'   ? `/groups/${slug}/`
             :                      `/tutorials/${slug}/`;
  window.location.href = path;
}

// Inline log helper that won't pollute prod consoles; swap for console.warn during dev.
function LOG_NOOP() {}

function renderTutorialCards(items) {
  const wrap = document.createElement('div');
  wrap.className = 'joule-cards';
  for (const it of items) {
    if (!it || !SAFE_SLUG_RE.test(String(it.slug || ''))) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'joule-card';
    btn.dataset.slug = it.slug;
    btn.dataset.type = it.type || 'tutorial';

    const title = document.createElement('p');
    title.className = 'joule-card__title';
    title.textContent = it.title || it.slug;
    btn.appendChild(title);

    if (it.description) {
      const desc = document.createElement('p');
      desc.className = 'joule-card__desc';
      desc.textContent = it.description;
      btn.appendChild(desc);
    }
    if (it.primaryTag) {
      const tag = document.createElement('p');
      tag.className = 'joule-card__tag';
      tag.textContent = it.primaryTag;
      btn.appendChild(tag);
    }

    btn.addEventListener('click', () => safeNavigate(it.type, it.slug));
    wrap.appendChild(btn);
  }
  if (wrap.childElementCount > 0) {
    transcript.appendChild(wrap);
    scrollToBottom(transcript);
  }
}
```

> **Why the regex?** `it.slug` flows from server JSON straight into a URL. Without a strict allowlist a malicious or buggy slug like `..%2Fevil.com` or a fully-qualified URL could redirect off-site. Slugs in this codebase are alphanumeric with dashes (see `Missions.slug` / `CompletionPaths.slug`), so the regex `^[a-z0-9][a-z0-9-]{0,127}$/i` is strictly tighter than the data shape and catches every escape attempt.

- [ ] **Step 2: Handle the new SSE event**

In the SSE switch:

```js
} else if (payload.type === 'tutorial-cards') {
  if (Array.isArray(payload.items) && payload.items.length) {
    renderTutorialCards(payload.items);
  }
}
```

- [ ] **Step 3: Manual test**

Run dev server with CAP backend. Send "find me a CAP getting started tutorial". After the assistant text streams in, a card list should appear with clickable items that navigate to `/tutorials/<slug>/`.

- [ ] **Step 4: Commit**

```bash
git add hugo/static/js/joule.js
git commit -m "feat(joule): render tutorial cards inline with click-to-navigate"
```

---

### Task 16: Per-page-kind conversation starters

**Files:**
- Create: `hugo/layouts/partials/joule-starters.html`
- Modify: `hugo/layouts/_default/baseof.html`
- Modify: `hugo/static/js/joule.js`

- [ ] **Step 1: Emit starter prompts as JSON**

Create `hugo/layouts/partials/joule-starters.html`:

```html
<script id="joule-starters" type="application/json">
{
  "tutorial": [
    "Summarize this tutorial in 3 bullets.",
    "What do I need before I start?",
    "I'm stuck on the current step — help me debug."
  ],
  "search":   [
    "Find me a CAP getting-started tutorial.",
    "Show me ABAP Cloud tutorials for beginners.",
    "What missions cover SAP BTP?"
  ],
  "mission":  [
    "Explain this mission's path.",
    "Which tutorial should I do first?",
    "What skills will I have after completing this?"
  ],
  "group":    [
    "What's in this group?",
    "Suggest a learning order.",
    "What's the next group after this one?"
  ],
  "generic":  [
    "What's new in SAP BTP?",
    "Help me find a tutorial.",
    "Explain CAP in 30 seconds."
  ]
}
</script>
```

In `hugo/layouts/_default/baseof.html`, add `{{ partial "joule-starters.html" . }}` immediately after the existing `{{ partial "joule-panel.html" . }}` include and BEFORE the `<script defer src=".../joule.js">` tag. The partial emits a `<script type="application/json">` element — `getElementById('joule-starters')` resolves regardless of where it sits in the document, but placing it next to the panel keeps related markup together.

- [ ] **Step 2: Render starter chips on hero**

In `joule.js`, add:

```js
function loadStarters() {
  try {
    const el = document.getElementById('joule-starters');
    return el ? JSON.parse(el.textContent) : {};
  } catch { return {}; }
}

function renderStarters() {
  const starters = loadStarters();
  const ctx = readPageContext();
  const list = starters[ctx.kind] || starters.generic || [];
  const wrap = panel.querySelector('.joule-panel__starters');
  wrap.replaceChildren();
  for (const text of list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'joule-panel__starter';
    btn.textContent = text;
    btn.addEventListener('click', () => { input.value = text; send(text); });
    wrap.appendChild(btn);
  }
}
```

In `open`, call `renderStarters()` after the greeting renders:

```js
async function open() {
  const user = await ensureAuth();
  if (!user) { /* existing redirect */ return; }
  panel.hidden = false;
  const messages = loadHistory();
  if (messages.length) { showChat(); renderTranscript(messages); }
  else { showHero(); renderGreeting(user.firstName); renderStarters(); }
  input.focus();
}
```

- [ ] **Step 3: Manual test**

On a tutorial page, open Joule. Confirm the three tutorial-specific starters appear. On the search page, confirm search starters appear. Click a starter; it submits as a message.

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/partials/joule-starters.html hugo/layouts/_default/baseof.html hugo/static/js/joule.js
git commit -m "feat(joule): per-page-kind conversation starter chips"
```

---

## Phase 6 — Smoke Coverage

### Task 17: Smoke test for the panel

**Files:**
- Create: `test/smoke/joule-panel.test.js`

- [ ] **Step 1: Write the test**

```js
import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:5000';

describe('joule panel smoke', () => {
  it('serves the markdown-it vendor bundle', async () => {
    const r = await fetch(`${BASE}/js/vendor/markdown-it.min.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') || '').toMatch(/javascript/);
  });

  it('serves the DOMPurify vendor bundle', async () => {
    const r = await fetch(`${BASE}/js/vendor/purify.min.js`);
    expect(r.status).toBe(200);
  });

  it('home page contains the AI Notice button and disclaimer', async () => {
    const r = await fetch(`${BASE}/`);
    const html = await r.text();
    expect(html).toMatch(/data-overflow="ai-notice"/);
    expect(html).toMatch(/Joule uses AI\. Verify results\./);
  });

  it('home page embeds starter prompts JSON', async () => {
    const r = await fetch(`${BASE}/`);
    const html = await r.text();
    expect(html).toMatch(/<script id="joule-starters"/);
  });
});
```

- [ ] **Step 2: Run locally**

```bash
SMOKE_BASE_URL=http://localhost:5000 npm run test:smoke
```

Expected: all four tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/joule-panel.test.js
git commit -m "test(joule): smoke checks for vendored bundles, AI Notice, starters"
```

---

## Final Verification Checklist

After all tasks, run through this manually on a deployed-or-hybrid stack:

- [ ] Joule trigger in header shows the official mark (not CSS diamond)
- [ ] Click trigger → panel opens with purple hero + greeting
- [ ] 3 starter chips appear, contextual to current page kind
- [ ] Click a starter → message submits, hero swaps to chat
- [ ] Three pulsing dots show before the first delta
- [ ] Streaming text renders with proper line breaks, bold, lists
- [ ] Auto-scroll follows when at bottom; doesn't yank when scrolled up
- [ ] Tutorial cards appear after a search-style ask; clicking navigates
- [ ] Hyperlinks in responses are clickable and open in a new tab
- [ ] Expand button enlarges panel; click again restores
- [ ] Overflow menu → "Clear chat" empties transcript and history
- [ ] Overflow menu → "AI Notice" shows the disclaimer sub-view; back arrow returns
- [ ] "Joule uses AI. Verify results." persists below the input
- [ ] Send button is a circular paper-plane icon
- [ ] Input area is dark; hero remains purple gradient
- [ ] Closing the panel and reopening preserves the chat (until cleared)
- [ ] All vendored bundles return 200 from the AppRouter
- [ ] No console errors in DevTools across the full flow

---

## Notes for the Executor

- **Worktree:** Run this plan in a dedicated worktree. Per `feedback_local_deploy_process` and `feedback_standalone_approuter_deploy`, do NOT deploy from this worktree until the plan is complete and reviewed.
- **No drive-by refactors.** This plan keeps `joule.js` as an IIFE. Do not split it into modules — that would force a build step. If you find yourself wanting to, push back to Tom first.
- **Commit per task.** Each numbered task ends with a commit. Don't batch.
- **No new server deps.** All server changes are in one function in `chat-orchestrator.js`. If you find yourself adding `npm` packages on the CAP side, stop and reconsider.
- **Markdown rendering must be safe.** Always: render → sanitize via DOMPurify → parse via DOMParser → append nodes. Never `innerHTML = unsanitized`. The plan's `setMarkdown` is the only path for assistant content.
- **Card click navigation must be relative.** Use `/tutorials/<slug>/`, never absolute URLs — the AppRouter handles routing.
- **Don't change the system prompt.** The agent already calls `searchTutorials` when appropriate. The new `tutorial-cards` event is purely a server-side post-processing of an already-collected tool result.
- **Vendored bundles count for git LFS.** They're ~80KB combined — fine to commit directly. Don't add LFS.

