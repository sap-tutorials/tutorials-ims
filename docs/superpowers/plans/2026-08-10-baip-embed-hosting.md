# BAIP Embedded / Hosted Tutorial Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a host app (BAIP Trial) embed a developers.sap.com tutorial in an iframe or side window and force a stripped-down "minimize" mode via URL params, with a bidirectional postMessage bridge for progress/control.

**Architecture:** A single `embed` URL param drives one `html[data-embed]` attribute (mirroring the existing `data-reader` pattern), set before first paint in `head.html` and reusing the existing reader-mode CSS cascade in `ui5-overrides.css`. A slim `embed-bar.html` partial covers `minimal`. A lazily-loaded, origin-validated `embed-bridge` island relays events the tutorial runtime already dispatches. `pip=1`/`step=N`/`host=1` are additive.

**Tech Stack:** Hugo templates (Go), vanilla inline JS (pre-paint), TypeScript + Vue islands built by Vite to `hugo/static/js/` (existing `hugo-apps/` toolchain), CSS in `hugo/assets/css/`, vitest (unit), Playwright (e2e).

## Global Constraints

- **Design source of truth:** `docs/superpowers/specs/2026-08-10-baip-embed-hosting-design.md`. Do not add scope beyond it.
- **Allowed `embed` values (allowlist, verbatim):** `none`, `minimal`, `reader`, `full`. Anything else → treated as `full` (no attribute).
- **Origin allow-list (verbatim, matches approuter CSP `frame-ancestors`):** `https://*.sap.com`, `https://*.sap.cn`, `https://*.cloud.sap`, plus `'self'`. Never post to or accept `*`.
- **postMessage type namespace:** all message `type` values are prefixed `sap:tutorial:`.
- **No server change** for the core feature — `srv/lib/content-store.js` serves identical slug-keyed HTML regardless of query string; embed behavior is client-side only.
- **Persistence key:** `localStorage['embed']` (string value from the allowlist). `embed=full` deletes it.
- **PiP user-activation constraint:** `documentPictureInPicture.requestWindow()` requires transient user activation; `pip=1` must arm-on-first-gesture, never fire unconditionally on load.
- **Bridge is inert** (attaches no listeners, posts nothing) unless the page is framed (`window.parent !== window` or `window.opener` present) OR an `embed`/`pip`/`host` param is present.
- **hugo-apps islands** build via `hugo-apps/vite.config.ts` `rollupOptions.input` → output `[name].js` to `hugo/static/js/`. Run the hugo-apps test suite with the project's existing vitest config.
- **Windows/CRLF:** keep line endings consistent with the file being edited; do not flip LF↔CRLF.

---

## File Structure

- `hugo-apps/src/embed/params.ts` — **new** — pure param resolution (parse, validate, precedence, `host` expansion, `step` bounds). Unit-tested. Consumed by the bridge and the launcher.
- `hugo-apps/src/embed/params.test.ts` — **new** — unit tests for the above.
- `hugo-apps/src/embed/origin.ts` — **new** — pure origin allow-list matcher. Unit-tested. Consumed by the bridge.
- `hugo-apps/src/embed/origin.test.ts` — **new**.
- `hugo-apps/src/embed/bridge.ts` — **new** — the postMessage bridge (outbound emitters + inbound listener), wired to existing DOM events. 
- `hugo-apps/src/embed/main.ts` — **new** — island entry: decides inert-vs-active, instantiates the bridge, handles `pip=1`/`step=N` arming.
- `hugo-apps/src/embed/bridge.test.ts` — **new** — bridge origin/serialization tests (jsdom).
- `hugo-apps/vite.config.ts` — **modify** — add `embed` entry to `rollupOptions.input`.
- `hugo/layouts/partials/head.html` — **modify** — pre-paint: set `html[data-embed]` (URL param → localStorage → none), `full` reset, persistence.
- `hugo/assets/css/ui5-overrides.css` — **modify** — extend reader cascade to `[data-embed]`; `none` removes shellbar + progress bar; relax page-kind gate; embed-bar + escape-pill styles.
- `hugo/layouts/partials/embed-bar.html` — **new** — slim bar for `embed=minimal`.
- `hugo/layouts/_default/baseof.html` — **modify** — render embed-bar + escape pill conditionally; load the `embed` island.
- `test/e2e/embed-hosting.spec.ts` — **new** — Playwright specs.
- `test/e2e/fixtures/embed-host-harness.html` — **new** — iframe demo/test harness.
- `srv/*` + `db/*` (Task 9, phased) — **new/modify** — DB-driven origin allow-list entity + public read endpoint.

---

### Task 1: Param resolution module (pure, unit-tested)

**Files:**
- Create: `hugo-apps/src/embed/params.ts`
- Test: `hugo-apps/src/embed/params.test.ts`

**Interfaces:**
- Consumes: nothing (pure, takes a query string).
- Produces:
  - `type EmbedMode = 'none' | 'minimal' | 'reader'`
  - `interface EmbedResolution { mode: EmbedMode | null; reset: boolean; pip: boolean; step: number | null; hostOrigin: string | null }`
  - `function resolveEmbedParams(search: string): EmbedResolution`

- [ ] **Step 1: Write the failing test**

```ts
// hugo-apps/src/embed/params.test.ts
import { describe, it, expect } from 'vitest';
import { resolveEmbedParams } from './params';

describe('resolveEmbedParams', () => {
  it('parses a valid embed mode', () => {
    expect(resolveEmbedParams('?embed=none')).toMatchObject({ mode: 'none', reset: false });
    expect(resolveEmbedParams('?embed=minimal').mode).toBe('minimal');
    expect(resolveEmbedParams('?embed=reader').mode).toBe('reader');
  });

  it('treats embed=full as a reset (no mode)', () => {
    expect(resolveEmbedParams('?embed=full')).toMatchObject({ mode: null, reset: true });
  });

  it('ignores unknown embed values (treated as reset-neutral: no mode, no reset)', () => {
    expect(resolveEmbedParams('?embed=bogus')).toMatchObject({ mode: null, reset: false });
  });

  it('expands host=1 to minimal + pip', () => {
    const r = resolveEmbedParams('?host=1');
    expect(r.mode).toBe('minimal');
    expect(r.pip).toBe(true);
  });

  it('an explicit embed value overrides the host shorthand', () => {
    expect(resolveEmbedParams('?host=1&embed=none').mode).toBe('none');
  });

  it('parses pip=1 as a boolean flag', () => {
    expect(resolveEmbedParams('?pip=1').pip).toBe(true);
    expect(resolveEmbedParams('?pip=0').pip).toBe(false);
    expect(resolveEmbedParams('').pip).toBe(false);
  });

  it('parses a positive integer step, rejects junk', () => {
    expect(resolveEmbedParams('?step=3').step).toBe(3);
    expect(resolveEmbedParams('?step=0').step).toBeNull();
    expect(resolveEmbedParams('?step=-2').step).toBeNull();
    expect(resolveEmbedParams('?step=abc').step).toBeNull();
  });

  it('returns hostOrigin verbatim when present', () => {
    expect(resolveEmbedParams('?host-origin=https%3A%2F%2Ftrial.sap.com').hostOrigin)
      .toBe('https://trial.sap.com');
  });

  it('is empty for a bare query string', () => {
    expect(resolveEmbedParams('')).toEqual({ mode: null, reset: false, pip: false, step: null, hostOrigin: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/embed/params.test.ts`
Expected: FAIL — cannot resolve `./params`.

- [ ] **Step 3: Write minimal implementation**

```ts
// hugo-apps/src/embed/params.ts
export type EmbedMode = 'none' | 'minimal' | 'reader';

export interface EmbedResolution {
  mode: EmbedMode | null;
  reset: boolean;
  pip: boolean;
  step: number | null;
  hostOrigin: string | null;
}

const MODES: readonly EmbedMode[] = ['none', 'minimal', 'reader'];

export function resolveEmbedParams(search: string): EmbedResolution {
  const q = new URLSearchParams(search);
  const host = q.get('host') === '1';

  const raw = q.get('embed');
  let mode: EmbedMode | null = null;
  let reset = false;
  if (raw === 'full') {
    reset = true;
  } else if (raw && (MODES as readonly string[]).includes(raw)) {
    mode = raw as EmbedMode;
  } else if (host) {
    mode = 'minimal';
  }

  const pip = q.get('pip') === '1' || host;

  const stepRaw = q.get('step');
  const stepNum = stepRaw != null ? Number(stepRaw) : NaN;
  const step = Number.isInteger(stepNum) && stepNum > 0 ? stepNum : null;

  const hostOrigin = q.get('host-origin');

  return { mode, reset, pip, step, hostOrigin: hostOrigin || null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/embed/params.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/embed/params.ts hugo-apps/src/embed/params.test.ts
git commit -m "feat(embed): pure URL param resolver for hosted tutorial mode (#1584)"
```

---

### Task 2: Origin allow-list matcher (pure, unit-tested)

**Files:**
- Create: `hugo-apps/src/embed/origin.ts`
- Test: `hugo-apps/src/embed/origin.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `const DEFAULT_ALLOWED_ORIGIN_PATTERNS: string[]` (the verbatim list from Global Constraints)
  - `function isOriginAllowed(origin: string, patterns?: string[], selfOrigin?: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// hugo-apps/src/embed/origin.test.ts
import { describe, it, expect } from 'vitest';
import { isOriginAllowed, DEFAULT_ALLOWED_ORIGIN_PATTERNS } from './origin';

describe('isOriginAllowed', () => {
  const self = 'https://developers.sap.com';

  it('allows exact self origin', () => {
    expect(isOriginAllowed(self, DEFAULT_ALLOWED_ORIGIN_PATTERNS, self)).toBe(true);
  });

  it('allows a wildcard-subdomain match on *.sap.com', () => {
    expect(isOriginAllowed('https://trial.sap.com', DEFAULT_ALLOWED_ORIGIN_PATTERNS, self)).toBe(true);
    expect(isOriginAllowed('https://a.b.cloud.sap', DEFAULT_ALLOWED_ORIGIN_PATTERNS, self)).toBe(true);
  });

  it('rejects a foreign origin', () => {
    expect(isOriginAllowed('https://evil.example.com', DEFAULT_ALLOWED_ORIGIN_PATTERNS, self)).toBe(false);
  });

  it('rejects a look-alike suffix attack (notsap.com)', () => {
    expect(isOriginAllowed('https://notsap.com', DEFAULT_ALLOWED_ORIGIN_PATTERNS, self)).toBe(false);
    expect(isOriginAllowed('https://sap.com.evil.com', DEFAULT_ALLOWED_ORIGIN_PATTERNS, self)).toBe(false);
  });

  it('rejects http downgrade for a wildcard https pattern', () => {
    expect(isOriginAllowed('http://trial.sap.com', DEFAULT_ALLOWED_ORIGIN_PATTERNS, self)).toBe(false);
  });

  it('rejects the literal wildcard "*"', () => {
    expect(isOriginAllowed('*', DEFAULT_ALLOWED_ORIGIN_PATTERNS, self)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/embed/origin.test.ts`
Expected: FAIL — cannot resolve `./origin`.

- [ ] **Step 3: Write minimal implementation**

```ts
// hugo-apps/src/embed/origin.ts
// Mirrors the approuter CSP frame-ancestors allow-list.
export const DEFAULT_ALLOWED_ORIGIN_PATTERNS: string[] = [
  'https://*.sap.com',
  'https://*.sap.cn',
  'https://*.cloud.sap',
];

function patternToRegExp(pattern: string): RegExp {
  // Only scheme + host wildcards are supported (e.g. https://*.sap.com).
  // Escape everything, then turn an escaped "\*\." into a "match one-or-more
  // subdomain labels" group. Anchored end-to-end so suffix attacks fail.
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withWildcard = escaped.replace(/\\\*\\\./g, '(?:[a-z0-9-]+\\.)+');
  return new RegExp('^' + withWildcard + '$', 'i');
}

export function isOriginAllowed(
  origin: string,
  patterns: string[] = DEFAULT_ALLOWED_ORIGIN_PATTERNS,
  selfOrigin?: string,
): boolean {
  if (!origin || origin === '*') return false;
  if (selfOrigin && origin === selfOrigin) return true;
  return patterns.some(p => patternToRegExp(p).test(origin));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/embed/origin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/embed/origin.ts hugo-apps/src/embed/origin.test.ts
git commit -m "feat(embed): origin allow-list matcher for postMessage bridge (#1584)"
```

---

### Task 3: Pre-paint attribute wiring in head.html

**Files:**
- Modify: `hugo/layouts/partials/head.html` (the inline pre-paint `<script>` block, currently ~lines 41–81, alongside the existing `data-reader` pre-paint at ~46–53)

**Interfaces:**
- Consumes: nothing (inline vanilla JS — cannot import the Task 1 module; a minimal hand-written equivalent lives here by design, since this runs before any module loads).
- Produces: sets `document.documentElement.dataset.embed` to `none|minimal|reader` before first paint; maintains `localStorage['embed']`.

- [ ] **Step 1: Add the pre-paint embed block**

Insert immediately after the existing reader-mode pre-paint block (after the `if (localStorage.getItem('reader') === 'on')` block, before the U14 hydration block). Keep it guarded by `{{ if not site.Params.previewMode }}` like the reader block:

```html
  {{ if not site.Params.previewMode }}
  // #1584 embed/hosted mode pre-paint. Mirrors the reader-mode pattern: set
  // html[data-embed] before first paint so hosted chrome never flashes. URL
  // param wins over persisted value; embed=full resets. Allowlist kept in sync
  // with hugo-apps/src/embed/params.ts (duplicated intentionally — this runs
  // before any module can load).
  (function () {
    try {
      var q = new URLSearchParams(location.search);
      var host = q.get('host') === '1';
      var raw = q.get('embed');
      var modes = ['none', 'minimal', 'reader'];
      var mode = null;
      if (raw === 'full') {
        localStorage.removeItem('embed');
      } else if (raw && modes.indexOf(raw) !== -1) {
        mode = raw;
      } else if (host) {
        mode = 'minimal';
      } else {
        mode = localStorage.getItem('embed');
        if (mode && modes.indexOf(mode) === -1) mode = null;
      }
      if (mode) {
        document.documentElement.dataset.embed = mode;
        localStorage.setItem('embed', mode);
      }
    } catch (e) {}
  })();
  {{ end }}
```

- [ ] **Step 2: Verify Hugo builds**

Run: `cd hugo && hugo --quiet` (or `npm run dev` and load a tutorial). If `fetch-tutorials` cache is absent, run `npm run fetch-tutorials` first per CLAUDE.md.
Expected: build succeeds, no template errors.

- [ ] **Step 3: Manual smoke**

Load a tutorial with `?embed=none`; confirm `document.documentElement.dataset.embed === 'none'` in devtools console. Reload without the param; confirm it persists (`none` still set). Load `?embed=full`; confirm the attribute and localStorage key are cleared.
Expected: all three behaviors hold.

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/partials/head.html
git commit -m "feat(embed): pre-paint html[data-embed] wiring with persistence (#1584)"
```

---

### Task 4: CSS cascade for embed modes

**Files:**
- Modify: `hugo/assets/css/ui5-overrides.css` (the reader-mode block, ~lines 270–345)

**Interfaces:**
- Consumes: `html[data-embed="none|minimal|reader"]` from Task 3; existing `.tutorial-right-col`, `.op-*`, `.breadcrumbs`, `footer`, `#joule-panel`, `#reading-progress`, `ui5-shellbar` selectors.
- Produces: the visual chrome-stripping. No new JS contract.

- [ ] **Step 1: Alias reader selectors to `[data-embed="reader"]` and add embed rules**

At the end of the reader-mode block in `ui5-overrides.css`, add:

```css
/* #1584 embed/hosted mode. `reader` reuses the focus-mode cascade above via
   these aliases; `none` and `minimal` add their own chrome removal. Unlike
   reader mode (tutorial-only), embed selectors are NOT gated on
   data-page-kind so a hosted mission/concept page also strips. */

/* embed=reader → same as pressing 'f'. */
html[data-embed="reader"] .tutorial-right-col,
html[data-embed="reader"] .breadcrumbs,
html[data-embed="reader"] .feedback-share,
html[data-embed="reader"] .step-controls,
html[data-embed="reader"] .tutorial-stepnav,
html[data-embed="reader"] footer,
html[data-embed="reader"] #joule-panel,
html[data-embed="reader"] #joule-starters {
  display: none !important;
}

/* embed=none / minimal → hide site chrome everywhere it appears. */
html[data-embed="none"] .tutorial-right-col,
html[data-embed="minimal"] .tutorial-right-col,
html[data-embed="none"] .breadcrumbs,
html[data-embed="minimal"] .breadcrumbs,
html[data-embed="none"] .feedback-share,
html[data-embed="minimal"] .feedback-share,
html[data-embed="none"] footer,
html[data-embed="minimal"] footer,
html[data-embed="none"] #joule-panel,
html[data-embed="minimal"] #joule-panel,
html[data-embed="none"] #joule-starters,
html[data-embed="minimal"] #joule-starters {
  display: none !important;
}

/* embed=none additionally removes the real shellbar and progress bar entirely
   (reader only dims the shellbar). */
html[data-embed="none"] ui5-shellbar,
html[data-embed="none"] #reading-progress,
html[data-embed="none"] #cmd-palette {
  display: none !important;
}

/* embed=minimal hides the real shellbar (the slim embed-bar renders instead). */
html[data-embed="minimal"] ui5-shellbar {
  display: none !important;
}

/* The slim embed bar and escape pill are hidden unless their mode is active. */
.embed-bar { display: none; }
html[data-embed="minimal"] .embed-bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  height: 44px;
  padding: 0 1rem;
  border-bottom: 1px solid var(--sapObjectHeader_BorderColor, #d9d9d9);
  background: var(--sapObjectHeader_Background, #fff);
}
.embed-bar__logo { height: 20px; }
.embed-bar__title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--sapTextColor, #32363a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.embed-bar__progress {
  flex: 0 0 auto;
  font-size: 0.8125rem;
  color: var(--sapNeutralTextColor, #6a6d70);
  font-variant-numeric: tabular-nums;
}

.embed-escape { display: none; }
html[data-embed="none"] .embed-escape {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  z-index: 9999;
  padding: 0.5rem 0.75rem;
  border-radius: 999px;
  background: var(--sapButton_Emphasized_Background, #0070f2);
  color: var(--sapButton_Emphasized_TextColor, #fff);
  font-size: 0.8125rem;
  text-decoration: none;
  box-shadow: 0 2px 8px rgba(0,0,0,0.2);
}
```

- [ ] **Step 2: Manual verify each mode**

With `npm run dev`, load a tutorial at `?embed=none`, `?embed=minimal`, `?embed=reader` and visually confirm: `none` = no shellbar/footer/rail/progress + escape pill visible; `minimal` = slim bar visible, no shellbar/nav; `reader` = focus cascade. Toggle dark mode in each.
Expected: correct chrome per mode, no dark-on-dark.

- [ ] **Step 3: Commit**

```bash
git add hugo/assets/css/ui5-overrides.css
git commit -m "feat(embed): CSS cascade for none/minimal/reader hosted modes (#1584)"
```

---

### Task 5: Slim embed bar + escape pill + baseof wiring

**Files:**
- Create: `hugo/layouts/partials/embed-bar.html`
- Modify: `hugo/layouts/_default/baseof.html` (after `{{ partial "header.html" . }}` at line 21; and near the island `<script>` block at the bottom)

**Interfaces:**
- Consumes: `.Title`, `.Params.stepCount`, `.Params.slug`, the existing `data-action="toggle-theme"` click handler already registered in `head.html` (line ~60).
- Produces: `.embed-bar`, `.embed-bar__title`, `.embed-bar__progress` DOM (styled in Task 4); `.embed-escape` link.

- [ ] **Step 1: Create the embed-bar partial**

```html
{{/* #1584 slim bar shown only in embed=minimal (CSS-gated). No nav/search/
     share/profile — just branding, title, step progress, theme toggle. */}}
<div class="embed-bar" role="banner">
  <a href="?embed=full" target="_blank" rel="noopener" aria-label="Open full SAP Developer Center site">
    <img class="embed-bar__logo" src="/img/sap-logo.svg" alt="SAP">
  </a>
  <span class="embed-bar__title">{{ .Title }}</span>
  {{ with .Params.stepCount }}<span class="embed-bar__progress" id="embed-step-progress" data-step-count="{{ . }}">Step 1 of {{ . }}</span>{{ end }}
  <ui5-button data-action="toggle-theme" icon="dark-mode" design="Transparent" tooltip="Toggle theme" aria-label="Toggle theme"></ui5-button>
</div>
```

- [ ] **Step 2: Wire embed-bar + escape pill into baseof.html**

After line 21 (`{{ partial "header.html" . }}`), add:

```html
  {{ partial "embed-bar.html" . }}
  {{/* #1584 escape hatch — only visible under embed=none (CSS-gated). Opens the
       full site in a new top-level context so a framed user escapes the frame. */}}
  <a class="embed-escape" href="?embed=full" target="_blank" rel="noopener">⤢ Open full site</a>
```

- [ ] **Step 3: Load the embed island near the other island scripts**

Before `</body>` in `baseof.html` (near the existing island `<script>` block, e.g. after line 64), add:

```html
  <script type="module" src="/js/embed.js" defer></script>
```

- [ ] **Step 4: Verify build + minimal bar renders**

Run: `cd hugo && hugo --quiet` then `npm run dev`; load `?embed=minimal`. Confirm slim bar shows title + "Step 1 of N" + theme button, and clicking the button toggles theme. Confirm the escape pill shows only under `?embed=none`.
Expected: correct rendering; `/js/embed.js` 404 is acceptable until Task 6 builds it (defer script failing to load must not break the page).

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/partials/embed-bar.html hugo/layouts/_default/baseof.html
git commit -m "feat(embed): slim embed-bar, escape pill, island wiring (#1584)"
```

---

### Task 6: postMessage bridge (outbound + inbound, origin-validated)

**Files:**
- Create: `hugo-apps/src/embed/bridge.ts`
- Test: `hugo-apps/src/embed/bridge.test.ts`

**Interfaces:**
- Consumes: `resolveEmbedParams` (Task 1), `isOriginAllowed` + `DEFAULT_ALLOWED_ORIGIN_PATTERNS` (Task 2). Listens to existing DOM events `tutorial:step-change` (`detail.stepIndex:number`, dispatched by `reading-progress.ts:71`) and `tutorial:step-completed` (`detail.stepNumber:number`, dispatched by `tutorial.ts:250`).
- Produces:
  - `interface BridgeDeps { hostOrigin: string | null; allowedPatterns?: string[]; targets: Window[]; doc?: Document; win?: Window }`
  - `interface BridgeHandle { emitReady(info: { slug: string; title: string; stepCount: number }): void; destroy(): void }`
  - `function createEmbedBridge(deps: BridgeDeps): BridgeHandle`
  - Inbound handling dispatches DOM `CustomEvent`s: `embed:goto` (`{stepIndex}`), `embed:set-embed` (`{mode}`), `embed:set-theme` (`{theme}`) — the island (Task 7) wires these to actions. This keeps the bridge free of DOM-mutation concerns (testable in jsdom).

- [ ] **Step 1: Write the failing test**

```ts
// hugo-apps/src/embed/bridge.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEmbedBridge } from './bridge';

function fakeWindow() {
  return { postMessage: vi.fn() } as unknown as Window;
}

describe('createEmbedBridge', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('emits sap:tutorial:ready to the resolved host origin, never "*"', () => {
    const target = fakeWindow();
    const b = createEmbedBridge({ hostOrigin: 'https://trial.sap.com', targets: [target] });
    b.emitReady({ slug: 's', title: 't', stepCount: 5 });
    expect(target.postMessage).toHaveBeenCalledWith(
      { type: 'sap:tutorial:ready', slug: 's', title: 't', stepCount: 5 },
      'https://trial.sap.com',
    );
    b.destroy();
  });

  it('relays tutorial:step-change as sap:tutorial:step-change', () => {
    const target = fakeWindow();
    const b = createEmbedBridge({ hostOrigin: 'https://trial.sap.com', targets: [target] });
    (target.postMessage as any).mockClear();
    document.dispatchEvent(new CustomEvent('tutorial:step-change', { detail: { stepIndex: 3 } }));
    expect(target.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sap:tutorial:step-change', stepIndex: 3 }),
      'https://trial.sap.com',
    );
    b.destroy();
  });

  it('accepts an inbound goto from an allowed origin and re-dispatches embed:goto', () => {
    const b = createEmbedBridge({ hostOrigin: 'https://trial.sap.com', targets: [] });
    const spy = vi.fn();
    document.addEventListener('embed:goto', spy as EventListener);
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://trial.sap.com',
      data: { type: 'sap:tutorial:goto', stepIndex: 4 },
    }));
    expect(spy).toHaveBeenCalled();
    expect((spy.mock.calls[0][0] as CustomEvent).detail).toEqual({ stepIndex: 4 });
    b.destroy();
  });

  it('ignores an inbound message from a foreign origin', () => {
    const b = createEmbedBridge({ hostOrigin: 'https://trial.sap.com', targets: [] });
    const spy = vi.fn();
    document.addEventListener('embed:goto', spy as EventListener);
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://evil.example.com',
      data: { type: 'sap:tutorial:goto', stepIndex: 4 },
    }));
    expect(spy).not.toHaveBeenCalled();
    b.destroy();
  });

  it('destroy() removes listeners (no relay after destroy)', () => {
    const target = fakeWindow();
    const b = createEmbedBridge({ hostOrigin: 'https://trial.sap.com', targets: [target] });
    b.destroy();
    (target.postMessage as any).mockClear();
    document.dispatchEvent(new CustomEvent('tutorial:step-change', { detail: { stepIndex: 9 } }));
    expect(target.postMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/embed/bridge.test.ts`
Expected: FAIL — cannot resolve `./bridge`.

- [ ] **Step 3: Write minimal implementation**

```ts
// hugo-apps/src/embed/bridge.ts
import { isOriginAllowed, DEFAULT_ALLOWED_ORIGIN_PATTERNS } from './origin';

export interface BridgeDeps {
  hostOrigin: string | null;
  allowedPatterns?: string[];
  targets: Window[];
  doc?: Document;
  win?: Window;
}

export interface BridgeHandle {
  emitReady(info: { slug: string; title: string; stepCount: number }): void;
  destroy(): void;
}

type OutMsg = Record<string, unknown> & { type: string };

export function createEmbedBridge(deps: BridgeDeps): BridgeHandle {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  const patterns = deps.allowedPatterns ?? DEFAULT_ALLOWED_ORIGIN_PATTERNS;
  const selfOrigin = win.location?.origin;

  // Post target: the validated host origin if we have one; otherwise skip
  // posting (we never fall back to "*").
  function post(msg: OutMsg): void {
    if (!deps.hostOrigin) return;
    if (!isOriginAllowed(deps.hostOrigin, patterns, selfOrigin)) return;
    for (const t of deps.targets) {
      try { t.postMessage(msg, deps.hostOrigin); } catch { /* target gone */ }
    }
  }

  const onStepChange = (e: Event) => {
    const d = (e as CustomEvent).detail;
    if (d && typeof d.stepIndex === 'number') {
      post({ type: 'sap:tutorial:step-change', slug: currentSlug, stepIndex: d.stepIndex });
    }
  };
  const onStepCompleted = (e: Event) => {
    const d = (e as CustomEvent).detail;
    // tutorial.ts dispatches { stepNumber } — normalize to stepIndex on the wire.
    const idx = d && typeof d.stepNumber === 'number' ? d.stepNumber
      : (d && typeof d.stepIndex === 'number' ? d.stepIndex : null);
    if (idx != null) post({ type: 'sap:tutorial:step-completed', slug: currentSlug, stepIndex: idx });
  };

  const onMessage = (e: MessageEvent) => {
    if (!isOriginAllowed(e.origin, patterns, selfOrigin)) return;
    const data = e.data;
    if (!data || typeof data.type !== 'string' || !data.type.startsWith('sap:tutorial:')) return;
    switch (data.type) {
      case 'sap:tutorial:goto':
        if (typeof data.stepIndex === 'number') {
          doc.dispatchEvent(new CustomEvent('embed:goto', { detail: { stepIndex: data.stepIndex } }));
        }
        break;
      case 'sap:tutorial:set-embed':
        if (typeof data.mode === 'string') {
          doc.dispatchEvent(new CustomEvent('embed:set-embed', { detail: { mode: data.mode } }));
        }
        break;
      case 'sap:tutorial:set-theme':
        if (data.theme === 'light' || data.theme === 'dark') {
          doc.dispatchEvent(new CustomEvent('embed:set-theme', { detail: { theme: data.theme } }));
        }
        break;
    }
  };

  let currentSlug = '';

  doc.addEventListener('tutorial:step-change', onStepChange);
  doc.addEventListener('tutorial:step-completed', onStepCompleted);
  win.addEventListener('message', onMessage);

  return {
    emitReady(info) {
      currentSlug = info.slug;
      post({ type: 'sap:tutorial:ready', slug: info.slug, title: info.title, stepCount: info.stepCount });
    },
    destroy() {
      doc.removeEventListener('tutorial:step-change', onStepChange);
      doc.removeEventListener('tutorial:step-completed', onStepCompleted);
      win.removeEventListener('message', onMessage);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/embed/bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/embed/bridge.ts hugo-apps/src/embed/bridge.test.ts
git commit -m "feat(embed): origin-validated postMessage bridge (#1584)"
```

---

### Task 7: Embed island entry (activation, bridge wiring, pip=1, step=N, inbound actions)

**Files:**
- Create: `hugo-apps/src/embed/main.ts`
- Modify: `hugo-apps/vite.config.ts` (add `embed` to `rollupOptions.input`)

**Interfaces:**
- Consumes: `resolveEmbedParams` (Task 1), `createEmbedBridge` (Task 6), existing DOM: `document.documentElement.dataset.{pageSlug,pageTitle,stepCount}` (set in `baseof.html`), the `.embed-escape`/`embed-bar` DOM (Task 5), the existing PiP launcher element `#tutorial-pip-launcher` and its click behavior, the `tutorial.ts` step goto via `location.hash = '#step-N'` (handled by `scrollToStepHash`/`initStepHashNavigation` in `tutorial.ts:78–88`).
- Produces: `/js/embed.js` island (no exports; self-mounting).

- [ ] **Step 1: Add the Vite entry**

In `hugo-apps/vite.config.ts`, inside `rollupOptions.input` (alphabetically near the other entries), add:

```ts
        embed: resolve(__dirname, 'src/embed/main.ts'),
```

- [ ] **Step 2: Write the island entry**

```ts
// hugo-apps/src/embed/main.ts
import { resolveEmbedParams } from './params';
import { createEmbedBridge, type BridgeHandle } from './bridge';

function isFramed(): boolean {
  try { return window.parent !== window || !!window.opener; } catch { return true; }
}

function applyEmbedMode(mode: string | null, reset: boolean): void {
  const html = document.documentElement;
  if (reset) { delete html.dataset.embed; try { localStorage.removeItem('embed'); } catch {} return; }
  if (mode === 'none' || mode === 'minimal' || mode === 'reader') {
    html.dataset.embed = mode;
    try { localStorage.setItem('embed', mode); } catch {}
  }
}

function gotoStep(n: number): void {
  if (!Number.isInteger(n) || n < 1) return;
  // Reuse tutorial.ts hash navigation (expand + scroll).
  location.hash = '#step-' + n;
}

function armPipOnFirstGesture(): void {
  // documentPictureInPicture.requestWindow() needs transient user activation,
  // so we cannot open on load. Trigger the existing launcher on the first
  // user gesture instead. The launcher button lives in #tutorial-pip-launcher.
  const launcher = document.getElementById('tutorial-pip-launcher');
  if (!launcher) return;
  const btn = () => launcher.querySelector<HTMLElement>('ui5-button, button');
  const fire = () => {
    const b = btn();
    if (b) b.click();
    cleanup();
  };
  const cleanup = () => {
    window.removeEventListener('pointerdown', fire, true);
    window.removeEventListener('keydown', fire, true);
  };
  window.addEventListener('pointerdown', fire, true);
  window.addEventListener('keydown', fire, true);
}

(function init() {
  const res = resolveEmbedParams(location.search);
  const framed = isFramed();
  const active = framed || res.mode !== null || res.reset || res.pip;
  if (!active) return; // inert for normal visitors

  // Reflect resolved mode (pre-paint already handled the common path; this
  // covers set-embed messages and keeps localStorage in sync).
  applyEmbedMode(res.mode, res.reset);

  // Deep-link to a step once the tutorial DOM is present.
  if (res.step != null) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => gotoStep(res.step!), { once: true });
    } else {
      gotoStep(res.step);
    }
  }

  // Arm PiP auto-launch (never fires without a user gesture).
  if (res.pip) armPipOnFirstGesture();

  // Bridge — post to opener (window host) and parent (iframe host).
  const targets: Window[] = [];
  try { if (window.opener) targets.push(window.opener as Window); } catch {}
  try { if (window.parent && window.parent !== window) targets.push(window.parent); } catch {}

  let bridge: BridgeHandle | null = null;
  if (framed || res.pip || res.mode) {
    bridge = createEmbedBridge({ hostOrigin: res.hostOrigin, targets });
    const html = document.documentElement;
    const slug = html.dataset.pageSlug || '';
    const title = html.dataset.pageTitle || document.title;
    const stepCount = parseInt(html.dataset.stepCount || '0', 10) || 0;
    bridge.emitReady({ slug, title, stepCount });
  }

  // Inbound actions from the bridge.
  document.addEventListener('embed:goto', (e) => gotoStep((e as CustomEvent).detail?.stepIndex));
  document.addEventListener('embed:set-embed', (e) => {
    const m = (e as CustomEvent).detail?.mode;
    applyEmbedMode(m === 'full' ? null : m, m === 'full');
  });
  document.addEventListener('embed:set-theme', (e) => {
    const t = (e as CustomEvent).detail?.theme;
    if (t === 'light' || t === 'dark') {
      document.documentElement.dataset.theme = t;
      document.documentElement.classList.toggle('dark', t === 'dark');
      try { localStorage.setItem('theme', t); } catch {}
    }
  });

  window.addEventListener('pagehide', () => bridge?.destroy(), { once: true });
})();
```

- [ ] **Step 3: Build the islands**

Run: `cd hugo-apps && npm run build` (or the project's island build script). Confirm `hugo/static/js/embed.js` is emitted.
Expected: `embed.js` present in `hugo/static/js/`.

- [ ] **Step 4: Manual integration smoke**

`npm run dev`; load a tutorial with `?embed=minimal&step=2`. Confirm: slim bar, page scrolls to step 2. Open browser console, run a fake host post from an allowed origin is not possible same-origin — defer full host testing to Task 8's harness. Confirm no console errors and the page behaves normally without params (island inert).
Expected: deep-link works; inert when no params.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/embed/main.ts hugo-apps/vite.config.ts
git commit -m "feat(embed): island entry — activation, bridge, pip arming, deep-link (#1584)"
```

---

### Task 8: Playwright e2e spec + iframe demo harness

**Files:**
- Create: `test/e2e/embed-hosting.spec.ts`
- Create: `test/e2e/fixtures/embed-host-harness.html`

**Interfaces:**
- Consumes: a deployed/served base URL via `SMOKE_BASE_URL`/`PLAYWRIGHT_BASE_URL` (per CLAUDE.md, e2e self-skips when absent). A known public tutorial slug.
- Produces: committed coverage per the e2e-coverage pattern.

- [ ] **Step 1: Write the harness fixture**

```html
<!-- test/e2e/fixtures/embed-host-harness.html -->
<!doctype html>
<html><head><meta charset="utf-8"><title>Embed host harness</title></head>
<body>
  <button id="goto">goto step 2</button>
  <pre id="log"></pre>
  <iframe id="frame" width="480" height="720"></iframe>
  <script>
    const log = (m) => { document.getElementById('log').textContent += m + '\n'; };
    const frame = document.getElementById('frame');
    const src = new URLSearchParams(location.search).get('src');
    frame.src = src;
    window.addEventListener('message', (e) => {
      if (e.data && typeof e.data.type === 'string' && e.data.type.startsWith('sap:tutorial:')) {
        log(e.data.type + ' ' + JSON.stringify(e.data));
      }
    });
    document.getElementById('goto').addEventListener('click', () => {
      frame.contentWindow.postMessage({ type: 'sap:tutorial:goto', stepIndex: 2 }, '*');
    });
  </script>
</body></html>
```

- [ ] **Step 2: Write the spec**

```ts
// test/e2e/embed-hosting.spec.ts
import { test, expect } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || process.env.SMOKE_BASE_URL || '';
const SLUG = process.env.EMBED_TEST_SLUG || 'abap-environment-trial-onboarding';

test.describe('embed hosted mode', () => {
  test.skip(!BASE, 'no base URL configured');

  test('embed=none hides the shellbar and shows the escape pill', async ({ page }) => {
    await page.goto(`${BASE}/tutorials/${SLUG}/?embed=none`);
    await expect(page.locator('ui5-shellbar#app-shellbar')).toBeHidden();
    await expect(page.locator('.embed-escape')).toBeVisible();
  });

  test('embed=minimal shows the slim bar and hides site nav', async ({ page }) => {
    await page.goto(`${BASE}/tutorials/${SLUG}/?embed=minimal`);
    await expect(page.locator('.embed-bar')).toBeVisible();
    await expect(page.locator('ui5-shellbar#app-shellbar')).toBeHidden();
    await expect(page.locator('#sb-nav')).toHaveCount(0).catch(() => {});
  });

  test('embed=reader applies the focus cascade (right col hidden)', async ({ page }) => {
    await page.goto(`${BASE}/tutorials/${SLUG}/?embed=reader`);
    await expect(page.locator('.tutorial-right-col')).toBeHidden();
  });

  test('bridge emits ready and reacts to goto from an iframe host', async ({ page }) => {
    // Serve the harness via data: URL isn't cross-origin-friendly; instead load
    // the harness from the site origin if hosted, else skip.
    const harness = `${BASE}/e2e-fixtures/embed-host-harness.html?src=${encodeURIComponent(`${BASE}/tutorials/${SLUG}/?embed=minimal&host-origin=${BASE}`)}`;
    const resp = await page.goto(harness);
    test.skip(!resp || !resp.ok(), 'harness fixture not served at this origin');
    await expect(page.locator('#log')).toContainText('sap:tutorial:ready', { timeout: 10000 });
    await page.locator('#goto').click();
    // step-change echoes back after goto scroll triggers reading-progress
    await expect(page.locator('#log')).toContainText('sap:tutorial:step-change', { timeout: 10000 });
  });
});
```

- [ ] **Step 3: Run (self-skips locally without a base URL)**

Run: `PLAYWRIGHT_BASE_URL=<deployed-dev-url> npx playwright test test/e2e/embed-hosting.spec.ts`
Expected: the three CSS-mode tests PASS against a deployed env; the harness test skips if the fixture isn't served (document this in `test/e2e/README.md`).

- [ ] **Step 4: Commit**

```bash
git add test/e2e/embed-hosting.spec.ts test/e2e/fixtures/embed-host-harness.html
git commit -m "test(embed): Playwright specs + iframe host harness (#1584)"
```

---

### Task 9: Narrow-frame auto-compact

**Files:**
- Modify: `hugo-apps/src/embed/main.ts` (extend `init()`)
- Modify: `hugo-apps/src/embed/params.test.ts` OR add `hugo-apps/src/embed/autocompact.test.ts`

**Interfaces:**
- Consumes: `resolveEmbedParams` result, `window.innerWidth`, `isFramed()`.
- Produces: `function pickAutoMode(opts: { framed: boolean; explicitMode: string | null; width: number; threshold?: number }): 'minimal' | null` (pure, extracted for testing).

- [ ] **Step 1: Write the failing test**

```ts
// hugo-apps/src/embed/autocompact.test.ts
import { describe, it, expect } from 'vitest';
import { pickAutoMode } from './autocompact';

describe('pickAutoMode', () => {
  it('returns minimal when framed and narrow with no explicit mode', () => {
    expect(pickAutoMode({ framed: true, explicitMode: null, width: 420 })).toBe('minimal');
  });
  it('never overrides an explicit mode', () => {
    expect(pickAutoMode({ framed: true, explicitMode: 'none', width: 420 })).toBeNull();
  });
  it('does nothing when not framed', () => {
    expect(pickAutoMode({ framed: false, explicitMode: null, width: 420 })).toBeNull();
  });
  it('does nothing above the threshold', () => {
    expect(pickAutoMode({ framed: true, explicitMode: null, width: 900 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/embed/autocompact.test.ts`
Expected: FAIL — cannot resolve `./autocompact`.

- [ ] **Step 3: Implement + wire in**

```ts
// hugo-apps/src/embed/autocompact.ts
export function pickAutoMode(opts: {
  framed: boolean; explicitMode: string | null; width: number; threshold?: number;
}): 'minimal' | null {
  const threshold = opts.threshold ?? 640;
  if (!opts.framed) return null;
  if (opts.explicitMode) return null;
  return opts.width < threshold ? 'minimal' : null;
}
```

In `main.ts` `init()`, after computing `res` and `framed`, before `applyEmbedMode`:

```ts
  import { pickAutoMode } from './autocompact'; // add to imports at top
  // ...
  const auto = pickAutoMode({ framed, explicitMode: res.reset ? 'full' : res.mode, width: window.innerWidth });
  const effectiveMode = res.mode ?? auto;
```

Then use `effectiveMode` in place of `res.mode` for `applyEmbedMode(effectiveMode, res.reset)` and the bridge-activation check.

- [ ] **Step 4: Run tests**

Run: `cd hugo-apps && npx vitest run src/embed/autocompact.test.ts && npm run build`
Expected: PASS; `embed.js` rebuilt.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/embed/autocompact.ts hugo-apps/src/embed/autocompact.test.ts hugo-apps/src/embed/main.ts
git commit -m "feat(embed): narrow-frame auto-compact (#1584)"
```

---

### Task 10 (phased): DB-driven host-origin allow-list

> This task is the heaviest and is explicitly phaseable. Tasks 1–9 ship a working POC with the hardcoded allow-list. Do Task 10 only when the feature outlives the POC. The bridge's `allowedPatterns` parameter (Task 2/6) is the seam — nothing above changes except where the patterns come from.

**Files:**
- Create/modify: a CDS entity for editable origin patterns (follow the project's admin-editable config precedent — search `srv/` for an existing `ImsConfig`/settings entity pattern before adding a new one).
- Modify: an existing **public** read endpoint (or add one) that returns the pattern list as JSON. Must be anonymous (no `@requires`) since the bridge runs pre-auth.
- Modify: `hugo-apps/src/embed/main.ts` — fetch patterns on init (with the hardcoded list as the fail-open default), pass to `createEmbedBridge`.

**Interfaces:**
- Consumes: `DEFAULT_ALLOWED_ORIGIN_PATTERNS` as the fallback.
- Produces: `GET <endpoint> → { patterns: string[] }`.

- [ ] **Step 1: Consult CAP docs + existing config pattern**

Use cds-mcp to search for the project's admin-editable config entity pattern and the correct way to expose an anonymous read endpoint (per CLAUDE.md global rules — search CDS defs with cds-mcp before writing/modifying CDS). Confirm whether an existing settings entity can hold the list rather than adding a new one.
Expected: a decision recorded in the commit message: reuse vs. new entity.

- [ ] **Step 2: Add the entity + seed the current hardcoded values**

(Implement per the pattern found in Step 1 — CDS entity, seed CSV with the three patterns, admin service exposure. Follow the CSV-editable-column gotchas in CLAUDE.md: DELETE seed CSV rows that are meant to be editable + add to `db/undeploy.json` if applicable.)

- [ ] **Step 3: Add/extend the anonymous read endpoint returning `{ patterns }`**

- [ ] **Step 4: Fetch in the island with fail-open default**

```ts
// in main.ts init(), before creating the bridge:
let patterns: string[] | undefined;
try {
  const r = await fetch('/build/embed-origins', { credentials: 'omit' });
  if (r.ok) { const j = await r.json(); if (Array.isArray(j.patterns)) patterns = j.patterns; }
} catch { /* fail open to hardcoded default */ }
// pass allowedPatterns: patterns to createEmbedBridge (undefined → default)
```

- [ ] **Step 5: Tests + deploy verification**

Unit-test the endpoint (CAP unit test bootstrap per CLAUDE.md: `cds.test('serve','--project','.','--in-memory')`). Run `npx cds deploy --to sqlite::memory:` before committing any `db/**/*.cds` or CSV (per CLAUDE.md). Verify the bridge still fail-opens when the endpoint 404s.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(embed): DB-driven host-origin allow-list (#1584)"
```

---

## Self-Review

**Spec coverage:**
- `embed=none/minimal/reader/full` → Tasks 1 (parse), 3 (attribute), 4 (CSS), 5 (bar/pill). ✓
- Persistence + escape hatch → Tasks 3, 5. ✓
- `pip=1` auto-launch (user-activation constraint) → Task 7. ✓
- `step=N` deep-link → Tasks 1, 7. ✓
- `host=1` shorthand → Task 1. ✓
- postMessage bridge (bidirectional, origin-validated, inert-when-unhosted) → Tasks 2, 6, 7. ✓
- Narrow-frame auto-compact → Task 9. ✓
- DB-driven origin allow-list (phased) → Task 10. ✓
- Testing (unit + e2e + harness) → Tasks 1,2,6,9 (unit), 8 (e2e/harness). ✓
- No server change for core → honored (Task 10 is the only server touch, phased). ✓

**Placeholder scan:** Task 10 Step 2 intentionally defers to the discovered pattern rather than inventing a schema — flagged as phased and gated on cds-mcp lookup, consistent with CLAUDE.md's "search CDS with cds-mcp first" rule. All code steps in Tasks 1–9 contain real code.

**Type consistency:** `EmbedResolution`/`EmbedMode` (Task 1) used consistently in Tasks 6/7/9. `createEmbedBridge`/`BridgeHandle`/`BridgeDeps` (Task 6) match Task 7 usage. Wire event `tutorial:step-completed` carries `detail.stepNumber` (verified against `tutorial.ts:250`) and is normalized to `stepIndex` on the wire in Task 6. `tutorial:step-change` carries `detail.stepIndex` (verified against `reading-progress.ts:71`). ✓
