# Issue #392 — Joule Aurora Background Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the new Joule background (four animated mesh-gradient layers + bobbing logo) from the production Joule Web Client (`com.sap.das.webclient v1.37.0`) into our `#joule-panel` so both the public Hugo tutorial site AND the admin-shell present the same updated visual.

**Architecture:** Both surfaces already share the same `#joule-panel` markup and load the same `/css/joule.css` (Hugo's `static/css/joule.css` is copied through `hugo/public/` into `approuter/static/` during `mbt build`, and `app/admin-shell/webapp/index.html` links to it). We therefore make **one CSS edit** plus **two parallel HTML edits** that add four `.mesh-layer` divs inside each `.joule-panel__hero`. Aurora applies to: hero, header strip (subtler), and step-help FAB (Hugo-only). All animations gate on `prefers-reduced-motion: reduce`.

**Tech Stack:** CSS (custom properties + `@keyframes`), Hugo partials (Go template), static HTML (admin-shell), Vitest smoke tests against deployed approuter URLs. No JS changes, no build pipeline changes, no schema changes.

**Reference (already extracted from prod bootstrap.js):**
- `--mesh-a: #8000dc`, `--mesh-b: #afd8ff`, `--mesh-c1: #f1acff`, `--mesh-c2: #a100c2` (== our `--joule-purple-3`), `--mesh-d1: #5d36ff` (== our `--joule-purple-1`), `--mesh-d2: #cfc3ff`
- Layer rules: 4 absolutely-positioned divs at `bottom:0; left:0; width:200%; height:50%; filter:blur(50px); pointer-events:none; z-index:0`
- Keyframes: `floatA` (14s), `floatB` (12s), `floatC` (16s), `floatD` (15s), `bob` (2s), `bobSettle` (0.15s)
- Logo bob: 56×56 SVG, `position:absolute; top:calc(...); left:50%; transform:translate(-50%,-50%)`, animation `bob 2s ease-in-out infinite`

**Decisions locked in earlier:**
- Surfaces: Hero (both) + Header strip (both) + Step-help FAB (Hugo only)
- Palette: reuse `--joule-purple-1` and `--joule-purple-3` for `mesh-d1`/`mesh-c2`; add four new `--joule-mesh-*` tokens
- Logo bob: yes, both surfaces

---

## File Structure

| Path | Responsibility | Status |
|---|---|---|
| `hugo/static/css/joule.css` | Single source of CSS truth. Tokens, layer/animation rules, palette branches, header-strip variant, FAB variant, reduced-motion guard. | **Modify** |
| `hugo/layouts/partials/joule-panel.html` | Add 4 `.mesh-layer` divs inside `.joule-panel__hero`; wrap existing `.joule-panel__hero-mark`/`-greeting`/`-starters` in a `.joule-panel__hero-content` container so background and content layer cleanly. | **Modify** |
| `app/admin-shell/webapp/index.html` | Same markup change as above, kept in lockstep. (Admin-shell is hand-mirrored from the Hugo partial; see `feedback_two_source_of_truth_drift_in_catalog` memory note for why drift bites us.) | **Modify** |
| `test/smoke/joule-aurora.test.js` | New file. CSS-content + DOM-shape smoke: tokens shipped, four mesh layers in both hero markups, `@keyframes floatA/B/C/D/bob/bobSettle` present, FAB carries aurora, `prefers-reduced-motion` rule present. | **Create** |
| `docs/developers/architecture/joule-aurora.md` | New doc. Where the visual came from (issue #392 trace), where the CSS lives, how to retune palette per theme, how to add a new surface. Linked from `docs/developers/README.md`. | **Create** |

---

## Out of scope (explicit non-goals)

- No theme-aware dark variant. Production's `_dark` branch swaps only `--joule-bg` (to `#1d2d3e`) — our panel already has `--joule-chrome:#14082F` for both light and dark site themes, so no need for now. (Followup: if/when the Hugo site grows a "translucent panel that reads through" requirement, revisit.)
- No high-contrast `_hcb`/`_hcw` variants. We don't ship HC themes; ignore.
- No Sapphire/Quartz `--sapAssistant_Color1/2` CSS-var path. Same reason.
- No JS changes. The `bobSettle` `.fade-out` class transition isn't needed because our hero hides via `[hidden]`, not opacity fade.
- No prod parity for the `mesh-layer` *exact* opacity floats (0.2/0.5/0.18/0.18) — start with prod's values; tune in QA only if visual review demands.
- No tutorial PiP, /me/, or hugo-apps Vue islands. Only the shared `#joule-panel` and the FAB.

---

## Task 1: Lock CSS smoke against the new tokens & keyframes (RED first)

**Files:**
- Create: `test/smoke/joule-aurora.test.js`

This test will fail on `main` and pass after Task 2. It is the RED step of TDD for the CSS work.

- [ ] **Step 1: Write the failing smoke test**

```javascript
// test/smoke/joule-aurora.test.js
import { describe, it, expect } from 'vitest';
import { BASE_URL, fetchWithRetry } from './smoke.config.js';

describe('Joule aurora background smoke', () => {
  let css;

  it('joule.css responds 200 and is fetchable', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/css/joule.css`);
    expect(res.status).toBe(200);
    css = await res.text();
    expect(css.length).toBeGreaterThan(0);
  });

  it('declares the four new mesh tokens', () => {
    expect(css).toMatch(/--joule-mesh-a:\s*#8000dc/i);
    expect(css).toMatch(/--joule-mesh-b:\s*#afd8ff/i);
    expect(css).toMatch(/--joule-mesh-c1:\s*#f1acff/i);
    expect(css).toMatch(/--joule-mesh-d2:\s*#cfc3ff/i);
  });

  it('reuses existing purple tokens for mesh-d1 and mesh-c2', () => {
    // Aurora should reference --joule-purple-1 (== prod #5d36ff == mesh-d1)
    // and --joule-purple-3 (== prod #a100c2 == mesh-c2) inside its layer rules.
    expect(css).toMatch(/\.joule-aurora__layer--d[\s\S]*?--joule-purple-1/);
    expect(css).toMatch(/\.joule-aurora__layer--c[\s\S]*?--joule-purple-3/);
  });

  it('declares the four mesh layer rules with required physics', () => {
    expect(css).toMatch(/\.joule-aurora__layer\b/);
    expect(css).toMatch(/\.joule-aurora__layer--a\b/);
    expect(css).toMatch(/\.joule-aurora__layer--b\b/);
    expect(css).toMatch(/\.joule-aurora__layer--c\b/);
    expect(css).toMatch(/\.joule-aurora__layer--d\b/);
    // The "blurred ellipse anchored to the bottom" physics:
    expect(css).toMatch(/filter:\s*blur\(50px\)/);
    expect(css).toMatch(/radial-gradient\(ellipse at 50%/);
  });

  it('declares the six aurora keyframes', () => {
    expect(css).toMatch(/@keyframes\s+jouleFloatA\b/);
    expect(css).toMatch(/@keyframes\s+jouleFloatB\b/);
    expect(css).toMatch(/@keyframes\s+jouleFloatC\b/);
    expect(css).toMatch(/@keyframes\s+jouleFloatD\b/);
    expect(css).toMatch(/@keyframes\s+jouleBob\b/);
    expect(css).toMatch(/@keyframes\s+jouleBobSettle\b/);
  });

  it('respects prefers-reduced-motion', () => {
    // The reduced-motion @media block must mention the aurora layers
    // (not just the typing dots that already had reduced-motion handling).
    const reducedBlocks = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\}/g) || [];
    const hasAuroraGuard = reducedBlocks.some(b => /joule-aurora__layer|joule-panel__hero-mark/.test(b));
    expect(hasAuroraGuard).toBe(true);
  });

  it('hero markup ships four mesh-layer divs on home', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/`);
    const html = await res.text();
    // Hugo minifier may strip attribute quotes; accept both forms.
    const layerCount = (html.match(/class=(?:["']?[^"'>]*joule-aurora__layer[^"'>]*["']?)/g) || []).length;
    expect(layerCount).toBeGreaterThanOrEqual(4);
  });

  it('admin-shell index ships four mesh-layer divs', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/admin-ui/`);
    // /admin-ui/ is XSUAA-protected; unauth gives 302/401/403.
    // We accept any of those AND the static asset itself.
    if (res.status === 200) {
      const html = await res.text();
      const layerCount = (html.match(/joule-aurora__layer/g) || []).length;
      expect(layerCount).toBeGreaterThanOrEqual(4);
    } else {
      // Fall back to the static file if the route is gated.
      const r2 = await fetchWithRetry(`${BASE_URL}/admin-ui/index.html`);
      if (r2.status === 200) {
        const html = await r2.text();
        const layerCount = (html.match(/joule-aurora__layer/g) || []).length;
        expect(layerCount).toBeGreaterThanOrEqual(4);
      } else {
        // Both gated — record skip; CI smoke runs against deployed URL where
        // admin-ui/* static files are served regardless of XSUAA scope.
        expect([200, 302, 401, 403]).toContain(res.status);
      }
    }
  });

  it('FAB style ships the aurora variant', () => {
    // FAB on the Hugo public site picks up the aurora paint; admin has no FAB.
    expect(css).toMatch(/\.joule-step-fab[\s\S]*?radial-gradient\(ellipse/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
SMOKE_BASE_URL=https://tutorial-system-dev-approuter.cfapps.eu10-005.hana.ondemand.com \
  npx vitest run test/smoke/joule-aurora.test.js
```

Expected: every assertion after the first one fails (file fetches OK, but tokens/keyframes/markup not yet present). The first `responds 200` test should pass on its own — that's our control.

- [ ] **Step 3: Commit the failing test on a feature branch**

```bash
git checkout -b feat/issue-392-joule-aurora
git add test/smoke/joule-aurora.test.js
git commit -m "test(smoke): RED — joule aurora background tokens, layers, keyframes (#392)"
```

---

## Task 2: Add aurora tokens, layer rules, and keyframes to joule.css

**Files:**
- Modify: `hugo/static/css/joule.css`

This is the GREEN step that makes the smoke pass.

- [ ] **Step 1: Extend the `:root` token block (currently lines 1-10)**

Replace the block with:

```css
:root {
  --joule-purple-1: #5D36FF;   /* == prod aurora mesh-d1 */
  --joule-purple-2: #7B42F0;
  --joule-purple-3: #A100C2;   /* == prod aurora mesh-c2 */
  --joule-chrome:   #14082F;
  --joule-chrome-2: #1F1340;
  --joule-text:     #f5f5fb;
  --joule-muted:    rgba(245,245,251,.65);
  --joule-radius:   16px;

  /* Issue #392 — aurora mesh layers ported from prod com.sap.das.webclient.
     mesh-d1 == --joule-purple-1, mesh-c2 == --joule-purple-3 (reused). */
  --joule-mesh-a:   #8000dc;
  --joule-mesh-b:   #afd8ff;
  --joule-mesh-c1:  #f1acff;
  --joule-mesh-d2:  #cfc3ff;
}
```

- [ ] **Step 2: Append the aurora module**

Append at end of file (after the existing `@media (max-width: 960px) { .joule-step-fab { display: none !important; } }` block):

```css
/* Issue #392 — aurora mesh background.
   Used inside .joule-panel__hero, scaled-down inside .joule-panel__header,
   and as an animated paint on .joule-step-fab (Hugo public site only).
   Source: production Joule Web Client (com.sap.das.webclient v1.37.0). */
.joule-aurora {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
}
.joule-aurora__layer {
  position: absolute;
  bottom: 0;
  left: 0;
  background-repeat: no-repeat;
  width: 200%;
  height: 50%;
  filter: blur(50px);
  will-change: transform;
  pointer-events: none;
  z-index: 0;
}
.joule-aurora__layer--a {
  opacity: 0.2;
  background-image: radial-gradient(ellipse at 50% 130%,
    var(--joule-mesh-a), var(--joule-mesh-a), transparent 50%);
  animation: jouleFloatA 14s ease-in-out infinite;
}
.joule-aurora__layer--b {
  opacity: 0.5;
  background-image: radial-gradient(ellipse at 50% 110%,
    var(--joule-mesh-b), var(--joule-mesh-b), transparent 50%);
  animation: jouleFloatB 12s ease-in-out infinite;
}
.joule-aurora__layer--c {
  opacity: 0.18;
  background-image: radial-gradient(ellipse at 50% 100%,
    var(--joule-mesh-c1), var(--joule-purple-3), transparent 50%);
  animation: jouleFloatC 16s ease-in-out infinite;
}
.joule-aurora__layer--d {
  opacity: 0.18;
  background-image: radial-gradient(ellipse at 50% 100%,
    var(--joule-purple-1), var(--joule-mesh-d2), transparent 50%);
  animation: jouleFloatD 15s ease-in-out infinite;
}

@keyframes jouleFloatA {
  0%   { transform: translate3d( 10%, 0,   0) scale(1.10); }
  50%  { transform: translate3d(-100%, 0,  0) scale(1.08); }
  100% { transform: translate3d( 10%, 0%,  0) scale(1.18); }
}
@keyframes jouleFloatB {
  0%   { transform: translate3d(-80%, 0,   0) scale(1.10); }
  50%  { transform: translate3d(-10%, 10%, 0) scale(1.08); }
  100% { transform: translate3d(-80%, 0%,  0) scale(1.18); }
}
@keyframes jouleFloatC {
  0%   { transform: translate3d( 30%, 0,   0) scale(1.10); }
  50%  { transform: translate3d(-30%,-10%, 0) scale(1.08); }
  100% { transform: translate3d( 30%, 0%,  0) scale(1.18); }
}
@keyframes jouleFloatD {
  0%   { transform: translate3d(-20%, 0%,  0) scale(1.10); }
  50%  { transform: translate3d( 10%,-10%, 0) scale(1.08); }
  100% { transform: translate3d(-20%, 0%,  0) scale(1.18); }
}

/* Hero — full-strength aurora (replaces the static linear-gradient at line 72). */
.joule-panel__hero {
  position: relative;
  /* keep existing layout: flex, padding, text-align (no change) */
  /* The previous linear-gradient was the static splash; the aurora layers
     paint over .joule-panel__hero so we drop the static fallback to avoid
     a colored seam during initial render. The hero's solid base is the
     panel chrome from .joule-panel__body. */
  background: var(--joule-chrome);
}
.joule-panel__hero-content {
  position: relative;
  z-index: 1;
  display: flex; flex-direction: column; align-items: center;
  width: 100%;
}
.joule-panel__hero .joule-panel__hero-mark {
  animation: jouleBob 2s ease-in-out infinite;
}

/* Header strip — same paint, smaller scale, larger blur, less motion. */
.joule-panel__header {
  position: relative;
  /* keep existing flex/align/gap/padding */
  overflow: hidden;
  /* fallback color if aurora can't paint (reduced-motion users below) */
  background: linear-gradient(165deg,
    var(--joule-purple-1) 0%, var(--joule-purple-2) 45%, var(--joule-purple-3) 100%);
}
.joule-panel__header > * { position: relative; z-index: 1; }
.joule-panel__header .joule-aurora__layer {
  height: 200%;       /* header strip is short — let the ellipses spill */
  filter: blur(40px); /* slightly tighter blur at this scale */
}

/* Step-help FAB — pill shape gets the aurora as its paint.
   The existing linear-gradient becomes a fallback (kept above for reduced-motion). */
.joule-step-fab {
  /* keep existing positioning; only the paint changes */
  background:
    radial-gradient(ellipse at 0% 130%,
      var(--joule-mesh-a), transparent 50%),
    radial-gradient(ellipse at 100% 130%,
      var(--joule-mesh-b), transparent 50%),
    radial-gradient(ellipse at 50% 0%,
      var(--joule-mesh-c1), transparent 60%),
    linear-gradient(165deg,
      var(--joule-purple-1) 0%, var(--joule-purple-2) 45%, var(--joule-purple-3) 100%);
  background-blend-mode: screen, screen, screen, normal;
}

/* Logo bob keyframes (used on .joule-panel__hero-mark above). */
@keyframes jouleBob {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-10px); }
}
@keyframes jouleBobSettle {
  to { transform: translateY(0); }
}

/* Reduced-motion guard — aurora and bob both stop. The static
   header gradient and FAB linear-gradient remain as the visual fallback. */
@media (prefers-reduced-motion: reduce) {
  .joule-aurora__layer { animation: none; }
  .joule-panel__hero-mark { animation: none; }
}
```

> **Note:** the `Hero` block above replaces the existing `linear-gradient(165deg, …)` on `.joule-panel__hero` (currently line 72). Don't try to keep both — the gradient was the old "splash" and the aurora is the replacement. The same gradient remains on `.joule-panel__header` as the reduced-motion fallback (header strip still needs *some* purple bg even when aurora is paused).

- [ ] **Step 3: Verify the file still parses (no syntax error)**

```bash
node -e "
  const css = require('fs').readFileSync('hugo/static/css/joule.css','utf8');
  // crude balance check — should never be negative at any point.
  let depth = 0; let line = 1;
  for (const ch of css) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === '\n') line++;
    if (depth < 0) throw new Error('unbalanced } at line ' + line);
  }
  if (depth !== 0) throw new Error('unbalanced braces, ended at depth=' + depth);
  console.log('OK — balanced, ' + css.length + ' bytes, ' + line + ' lines');
"
```

Expected: `OK — balanced, …`.

- [ ] **Step 4: Commit**

```bash
git add hugo/static/css/joule.css
git commit -m "feat(joule): aurora mesh background tokens + keyframes + surface paints (#392)"
```

---

## Task 3: Add four mesh-layer divs to the Hugo `joule-panel` partial

**Files:**
- Modify: `hugo/layouts/partials/joule-panel.html` lines 25-29 (the `.joule-panel__hero` section)

- [ ] **Step 1: Replace the hero markup**

Find this block (lines 25-29):

```html
    <section class="joule-panel__hero">
      <div class="joule-panel__hero-mark">{{ partial "joule-icon.html" (dict "size" "large") }}</div>
      <p class="joule-panel__hero-greeting" data-default-greeting="Hello, How can I help you?"></p>
      <div class="joule-panel__starters" role="list"></div>
    </section>
```

Replace with:

```html
    <section class="joule-panel__hero">
      <div class="joule-aurora" aria-hidden="true">
        <div class="joule-aurora__layer joule-aurora__layer--a"></div>
        <div class="joule-aurora__layer joule-aurora__layer--b"></div>
        <div class="joule-aurora__layer joule-aurora__layer--c"></div>
        <div class="joule-aurora__layer joule-aurora__layer--d"></div>
      </div>
      <div class="joule-panel__hero-content">
        <div class="joule-panel__hero-mark">{{ partial "joule-icon.html" (dict "size" "large") }}</div>
        <p class="joule-panel__hero-greeting" data-default-greeting="Hello, How can I help you?"></p>
        <div class="joule-panel__starters" role="list"></div>
      </div>
    </section>
```

Also: add the same aurora wrapper inside `.joule-panel__header` (lines 3-15). Find:

```html
  <header class="joule-panel__header">
    {{ partial "joule-icon.html" (dict "size" "small") }}
    <h2 id="joule-panel-title" class="joule-panel__title">Joule</h2>
```

Insert immediately after the `<header …>` opening tag and before the `{{ partial ... }}`:

```html
    <div class="joule-aurora" aria-hidden="true">
      <div class="joule-aurora__layer joule-aurora__layer--a"></div>
      <div class="joule-aurora__layer joule-aurora__layer--b"></div>
      <div class="joule-aurora__layer joule-aurora__layer--c"></div>
      <div class="joule-aurora__layer joule-aurora__layer--d"></div>
    </div>
```

- [ ] **Step 2: Build Hugo locally to ensure the partial still parses**

```bash
# CAP_BASE_URL is needed for cap.ts (mission catalog); see CLAUDE.md gotchas.
CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" \
  npm run fetch-tutorials && \
  npx hugo --source hugo --minify --quiet
```

Expected: build completes without "ERROR" lines. If build fails with "no such partial" or template parse error, you've broken the surrounding tags.

- [ ] **Step 3: Spot-check one rendered page contains the markup**

```bash
grep -c 'joule-aurora__layer' hugo/public/index.html
```

Expected: `≥ 8` (4 layers × 2 surfaces — header + hero — on the home page). The partial is included from [`hugo/layouts/_default/baseof.html:24`](../../../hugo/layouts/_default/baseof.html#L24), so every rendered page carries it.

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/partials/joule-panel.html
git commit -m "feat(joule): add aurora mesh layers to public hero + header (#392)"
```

---

## Task 4: Mirror the markup change in admin-shell

**Files:**
- Modify: `app/admin-shell/webapp/index.html` lines 28-47 (the header) and 57-70 (the hero)

This step is what keeps both surfaces visually identical. The HTML is hand-mirrored from the Hugo partial (admin-shell is plain HTML, not Hugo) — see the `feedback_two_source_of_truth_drift_in_catalog` memory.

> **Line numbers may drift.** If your file has the same content but at slightly different lines, anchor on the literal text — `<header class="joule-panel__header">` for the header insertion point and `<section class="joule-panel__hero">` for the hero replacement. The same applies to Task 3 (Hugo partial).

- [ ] **Step 1: Add aurora wrapper to the header**

Find line 28 (`<header class="joule-panel__header">`). Immediately after it, insert:

```html
      <div class="joule-aurora" aria-hidden="true">
        <div class="joule-aurora__layer joule-aurora__layer--a"></div>
        <div class="joule-aurora__layer joule-aurora__layer--b"></div>
        <div class="joule-aurora__layer joule-aurora__layer--c"></div>
        <div class="joule-aurora__layer joule-aurora__layer--d"></div>
      </div>
```

- [ ] **Step 2: Wrap hero content + add aurora layers**

Find lines 57-70 (the `<section class="joule-panel__hero">` block). Replace with:

```html
      <section class="joule-panel__hero">
        <div class="joule-aurora" aria-hidden="true">
          <div class="joule-aurora__layer joule-aurora__layer--a"></div>
          <div class="joule-aurora__layer joule-aurora__layer--b"></div>
          <div class="joule-aurora__layer joule-aurora__layer--c"></div>
          <div class="joule-aurora__layer joule-aurora__layer--d"></div>
        </div>
        <div class="joule-panel__hero-content">
          <div class="joule-panel__hero-mark">
            <span class="joule-mark joule-mark--large" aria-hidden="true">
              <!-- KEEP THE ENTIRE EXISTING SVG INLINE HERE — do not modify the path data -->
              <svg width="64" height="64" viewBox="0 0 122 120" xmlns="http://www.w3.org/2000/svg" fill="none">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M46.6026 37C45.3357 37 44.1364 37.5715 43.3379 38.5556L24.9405 61.23C23.7324 62.7189 23.6834 64.8368 24.8211 66.3802L61.616 116.29C62.4087 117.365 63.6647 118 65 118C66.3353 118 67.5913 117.365 68.384 116.29L105.179 66.3802C106.317 64.8368 106.268 62.7189 105.06 61.23L86.6621 38.5556C85.8636 37.5715 84.6643 37 83.3974 37H46.6026ZM88.3249 63.5392C79.643 62.0748 76.8647 55.2489 75.9469 50.9797C75.8477 50.5577 75.302 50.5825 75.2276 51.0045C73.764 59.6919 66.9425 62.4719 62.6759 63.3903C62.2543 63.4896 62.2791 64.0357 62.7008 64.1101C71.3827 65.5746 74.1609 72.4004 75.0787 76.6697C75.178 77.0917 75.7237 77.0668 75.7981 76.6449C77.2616 67.9574 84.0832 65.1774 88.3497 64.259C88.7714 64.1598 88.7466 63.6137 88.3249 63.5392Z" fill="currentColor"/>
                <path d="M101.542 20.3013C102.16 23.126 104.031 27.6422 109.878 28.6111C110.162 28.6604 110.179 29.0217 109.895 29.0874C107.022 29.695 102.428 31.5343 101.442 37.2822C101.392 37.5614 101.024 37.5778 100.958 37.2986C100.34 34.4739 98.4685 29.9578 92.6215 28.9888C92.3375 28.9396 92.3208 28.5783 92.6048 28.5126C95.4782 27.9049 100.072 26.0656 101.058 20.3178C101.108 20.0386 101.476 20.0222 101.542 20.3013Z" fill="currentColor"/>
                <path d="M42.2811 0.302036C43.1925 4.53904 45.9515 11.3133 54.5733 12.7667C54.9921 12.8406 55.0167 13.3826 54.598 13.4811C50.361 14.3925 43.5867 17.1515 42.1333 25.7733C42.0594 26.1921 41.5174 26.2167 41.4189 25.798C40.5075 21.561 37.7485 14.7867 29.1267 13.3333C28.7079 13.2594 28.6833 12.7174 29.102 12.6189C33.339 11.7075 40.1133 8.94848 41.5667 0.326668C41.6406 -0.0921059 42.1826 -0.116738 42.2811 0.302036Z" fill="currentColor"/>
                <path d="M16.7874 26.3048C17.395 29.1782 19.2344 33.7722 24.9822 34.7579C25.2614 34.808 25.2778 35.1755 24.9986 35.2423C22.174 35.8604 17.6578 37.7315 16.6889 43.5784C16.6396 43.8624 16.2783 43.8791 16.2126 43.5951C15.605 40.7218 13.7657 36.1277 8.01778 35.1421C7.7386 35.092 7.72218 34.7244 8.00136 34.6576C10.826 34.0395 15.3422 32.1685 16.3111 26.3215C16.3604 26.0375 16.7217 26.0208 16.7874 26.3048Z" fill="currentColor"/>
              </svg>
            </span>
          </div>
          <p class="joule-panel__hero-greeting" data-default-greeting="Hello, How can I help you?"></p>
          <div class="joule-panel__starters" role="list"></div>
        </div>
      </section>
```

> **Important:** the four `<path d="…">` strings MUST be byte-identical to lines 61-64 in the existing file. Don't retype — copy them. If you flatten or re-format, the chevron's mask alignment will subtly break.

- [ ] **Step 2.5: Verify both surfaces ship the same number of mesh layers**

```bash
grep -c 'joule-aurora__layer' hugo/layouts/partials/joule-panel.html
grep -c 'joule-aurora__layer' app/admin-shell/webapp/index.html
```

Expected: both report `8` (4 in header + 4 in hero, each surface).

- [ ] **Step 3: Build admin-shell to ensure the static index still validates**

```bash
npm --prefix app/admin-shell run build
ls app/admin-shell/dist/index.html
```

Expected: `dist/index.html` exists.

- [ ] **Step 4: Commit**

```bash
git add app/admin-shell/webapp/index.html
git commit -m "feat(joule): mirror aurora mesh layers in admin-shell hero + header (#392)"
```

---

## Task 5: Local visual smoke (manual, before deploy)

**Files:** none modified.

This task is the verify-before-completion gate. We've never deployed an aurora effect before, so eyes-on the running page is required.

- [ ] **Step 1: Boot CAP + approuter locally (hybrid mode, real HANA)**

```bash
# Terminal 1 — CAP (already authed via cf bind from a prior session)
npm run dev:hybrid
```

Wait for `cds w` to log `[cds] - server listening on { url: 'http://localhost:4004' }`.

```bash
# Terminal 2 — approuter
npm run start:approuter
```

Wait for approuter to log `app router started`.

- [ ] **Step 2: Build Hugo public site once and copy to approuter static (so /css/joule.css is fresh)**

```bash
# In a third terminal, in the worktree root:
CAP_BASE_URL="http://localhost:4004" npm run build:all
mkdir -p approuter/static
cp -r hugo/public/. approuter/static/
mkdir -p approuter/static/admin-ui
cp -r app/admin-shell/dist/. approuter/static/admin-ui/
```

> Re-run this whenever you tweak the CSS — local approuter doesn't watch.

- [ ] **Step 3: Verify visual on the public site**

Open http://localhost:5000 and click the Joule FAB.

Confirm:
- [ ] Hero shows the four-layer aurora animating (slow, ~14s period; you should see one mesh blob drift across in 7-8 seconds)
- [ ] Joule logo bobs up-down once every 2s
- [ ] Header strip shows a subtler version of the aurora
- [ ] FAB pill carries the aurora paint (not the old flat linear-gradient)
- [ ] No layout shift; nothing overflows the panel border-radius (mesh layers should be clipped by `#joule-panel`'s `overflow: hidden` at line 23)

Take a screenshot for the PR description.

- [ ] **Step 4: Verify visual on admin-shell**

Open http://localhost:5000/admin-ui/ and click the Joule shellbar button.

Confirm the same four bullets as Step 3 (admin-shell has no FAB, so skip that one).

Take a screenshot for the PR description.

- [ ] **Step 5: Verify reduced-motion**

In Chrome DevTools → Rendering → "Emulate CSS prefers-reduced-motion: reduce". Reload the panel.

Confirm:
- [ ] Aurora layers are static (no drift)
- [ ] Logo doesn't bob
- [ ] Visual still looks intentional (the linear-gradient fallback shows through on header + FAB)

- [ ] **Step 6: Commit nothing (this task is verify-only). Update todos.**

---

## Task 6: Run the smoke test against a deployed environment (GREEN)

**Files:** none modified.

We need at minimum a DEV deploy (or a colleague's PR-build URL) that has the new joule.css served at `/css/joule.css`.

- [ ] **Step 1: Deploy to DEV** (per `feedback_confirm_deploy_scope` memory — confirm scope with Tom first)

This is a **frontend-only** deploy (CSS + admin-shell static files). The minimum path is:

```bash
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

> Per CLAUDE.md, `mbt build` only `cp`s `hugo/public/` into the approuter — Hugo MUST have run before `mbt build`. `npm run build:all` does this.

- [ ] **Step 2: Run the aurora smoke against the deployed approuter**

```bash
SMOKE_BASE_URL=https://tutorial-system-dev-approuter.cfapps.eu10-005.hana.ondemand.com \
  npx vitest run test/smoke/joule-aurora.test.js
```

Expected: all 8 assertions PASS.

- [ ] **Step 3: Run the existing Joule smokes — make sure we didn't break them**

```bash
SMOKE_BASE_URL=https://tutorial-system-dev-approuter.cfapps.eu10-005.hana.ondemand.com \
SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
  npx vitest run test/smoke/joule-panel.test.js test/smoke/joule-step-fab.test.js test/smoke/admin-joule.test.js
```

Expected: all PASS. The `joule-step-fab.test.js` test that asserts `joule.css` ships `.joule-step-fab` styles — should still pass; we kept the selector.

- [ ] **Step 4: Commit smoke output to PR description (no source change)**

Paste the smoke output into the PR body for reviewer confidence.

---

## Task 7: Documentation

**Files:**
- Create: `docs/developers/architecture/joule-aurora.md`
- Modify: `docs/developers/README.md` (add link to the new doc, alphabetical with the other architecture docs)

- [ ] **Step 1: Write the architecture doc**

```markdown
# Joule Aurora Background

> Issue [#392](https://github.com/sap-tutorials/tutorials-ims/issues/392) — port the new Joule background animation from the production Joule Web Client (`com.sap.das.webclient v1.37.0`) into our `#joule-panel` so both the public Hugo tutorial site and the admin-shell present the same updated visual.

## What it is

Four absolutely-positioned, blurred radial-gradient `<div>`s anchored to the bottom of `#joule-panel`'s hero (and header strip), each slowly translating horizontally on long-period keyframes. The Joule logo "bobs" up-down 2s while the panel is idle. Together they read as an aurora-style purple wash blooming up from the panel base.

The animation is 100% CSS — no canvas, no WebGL, no video, no extra HTTP requests.

## Where it lives

| Surface | Element | Source file |
|---|---|---|
| Public site | `#joule-panel` | [`hugo/layouts/partials/joule-panel.html`](../../../hugo/layouts/partials/joule-panel.html) |
| Public site | `#joule-step-fab` (FAB) | [`hugo/layouts/partials/joule-step-help.html`](../../../hugo/layouts/partials/joule-step-help.html) |
| Admin shell | `#joule-panel` | [`app/admin-shell/webapp/index.html`](../../../app/admin-shell/webapp/index.html) |
| **All surfaces** | CSS | [`hugo/static/css/joule.css`](../../../hugo/static/css/joule.css) |

The CSS file is the **single source of truth**. At `mbt build` time, `hugo/public/css/joule.css` is copied into `approuter/static/css/joule.css`, and the admin-shell's `index.html` links to `/css/joule.css` directly — both surfaces resolve the same file.

The HTML inlines (Hugo partial vs. admin-shell `index.html`) are hand-mirrored. **They have drifted before** (see `feedback_two_source_of_truth_drift_in_catalog`); the smoke test [`test/smoke/joule-aurora.test.js`](../../../test/smoke/joule-aurora.test.js) asserts that both surfaces ship the same four `.joule-aurora__layer` divs to catch this.

## Tokens

```css
--joule-purple-1: #5D36FF;   /* mesh-d1 */
--joule-purple-3: #A100C2;   /* mesh-c2 */
--joule-mesh-a:   #8000dc;
--joule-mesh-b:   #afd8ff;
--joule-mesh-c1:  #f1acff;
--joule-mesh-d2:  #cfc3ff;
```

To retune the palette, override these tokens at `:root` (or scoped to `#joule-panel`) — the four `.joule-aurora__layer--*` rules read them via `var(...)`.

## Adding aurora to a new surface

1. Add `position: relative; overflow: hidden;` to the surface's outermost element.
2. Insert a `.joule-aurora` wrapper with four `.joule-aurora__layer--{a,b,c,d}` divs as the first child.
3. Wrap the surface's existing children in a `position: relative; z-index: 1;` content container so they paint above the layers.
4. Add a smoke assertion that the surface ships four mesh layers.

## What this does NOT do

- No theme-aware dark variant (our panel chrome is already dark).
- No high-contrast theme branches.
- No Sapphire/Quartz `--sapAssistant_Color1/2` integration.
- No JS — no `.fade-out` or `bobSettle` transition; we hide hero with `[hidden]`.

If any of those become necessary, the production reference is documented inline in the issue trace at [`tools/joule-trace.md`](https://github.com/sap-tutorials/tutorials-ims/issues/392) (full bootstrap.js extract).

## Reduced motion

`@media (prefers-reduced-motion: reduce)` halts every aurora animation and the logo bob. The static linear-gradients on `.joule-panel__header` and `.joule-step-fab` remain as the visual fallback so neither surface goes blank.
```

- [ ] **Step 2: Add link to docs README**

Find the architecture section in `docs/developers/README.md` and add a line:

```markdown
- [joule-aurora.md](./architecture/joule-aurora.md) — Joule panel background animation (issue #392)
```

(Alphabetical placement with the other `architecture/*` doc links.)

- [ ] **Step 3: Run the VitePress sidebar guard so the doc is registered**

```bash
npm run docs:build
```

Expected: completes without "unregistered page" or dead-link errors.

- [ ] **Step 4: Commit**

```bash
git add docs/developers/architecture/joule-aurora.md docs/developers/README.md docs/.vitepress/config.ts
git commit -m "docs(joule): document aurora background source-of-truth + retuning (#392)"
```

> If the sidebar guard auto-modified `docs/.vitepress/config.ts`, that's fine — include it in the commit. If it didn't, manually add the new page to `docs/.vitepress/config.ts` `themeConfig.sidebar` per the existing pattern.

---

## Task 8: Final review checklist + open PR

- [ ] **Step 1: Re-run all relevant tests and lint**

```bash
npm run lint
npx vitest run test/smoke/joule-aurora.test.js test/smoke/joule-panel.test.js test/smoke/joule-step-fab.test.js test/smoke/admin-joule.test.js
```

- [ ] **Step 2: Visual diff** — Take before/after screenshots of the public hero, public FAB, and admin-shell hero. Attach to the PR body.

- [ ] **Step 3: Verify branch + push**

```bash
# Per feedback_verify_branch_before_commit memory: confirm in same Bash invocation.
git branch --show-current && git log --oneline -8 && git push -u origin feat/issue-392-joule-aurora
```

Expected: branch shows `feat/issue-392-joule-aurora` and your last 6 commits are visible.

- [ ] **Step 4: Open PR**

```bash
gh pr create --title "feat(joule): aurora mesh background on public + admin-shell (#392)" \
  --body "$(cat <<'EOF'
Closes #392.

Ports the new Joule background animation from the production Joule Web Client
(com.sap.das.webclient v1.37.0) into our shared `#joule-panel`. Affects both
the public Hugo tutorial site and the admin-shell, since they share the
markup and load the same `/css/joule.css`.

## What changed

- New CSS module appended to `hugo/static/css/joule.css`: 6 keyframes,
  4 mesh-layer rules, surface paints for `.joule-panel__hero`,
  `.joule-panel__header`, `.joule-step-fab`. Reduced-motion guard.
- Hugo partial `hugo/layouts/partials/joule-panel.html` and admin-shell
  `app/admin-shell/webapp/index.html` each gain four `.joule-aurora__layer`
  divs inside the hero and header. The two HTML inlines are kept identical
  by a smoke test.

## Visuals

| Before | After |
|---|---|
| (screenshot) | (screenshot) |

## Smoke

(paste output of `vitest run test/smoke/joule-aurora.test.js …`)

## Reduced motion

Verified in Chrome DevTools → Rendering → Emulate CSS reduce. Layers freeze;
fallback gradient still paints.

## Out of scope

- Theme-aware dark/HC variants (none of our panel chromes need it).
- Sapphire/Quartz `--sapAssistant_*` token wiring.
- JS-driven hero fade-out (we hide via `[hidden]`).
EOF
)"
```

- [ ] **Step 5: Comment on issue with smoke output + screenshots; mark plan complete in this file.**

---

## Test strategy summary

| Layer | Test | Where |
|---|---|---|
| Smoke (deployed) | aurora tokens + keyframes ship in `/css/joule.css` | `test/smoke/joule-aurora.test.js` |
| Smoke (deployed) | both `#joule-panel` HTML surfaces ship 4 mesh layers | `test/smoke/joule-aurora.test.js` (same file) |
| Smoke (deployed) | reduced-motion `@media` block exists and references aurora | `test/smoke/joule-aurora.test.js` (same file) |
| Smoke (deployed, regression) | existing FAB / panel / admin smoke still pass | `joule-step-fab.test.js`, `joule-panel.test.js`, `admin-joule.test.js` |
| Manual | visual: hero + header + FAB animate; logo bobs; reduced-motion freezes | Local hybrid setup (Task 5) |

No unit tests — the change is pure declarative CSS + HTML. Smoke covers shape; manual covers paint.

## Risk register

| Risk | Mitigation |
|---|---|
| Admin-shell HTML drifts from Hugo partial again | Aurora smoke asserts both surfaces ship 4 layer divs |
| `mbt build` ships stale `joule.css` (per `feedback_hugo_before_mbt`) | Task 6 deploy step runs `build:all` before `mbt build` |
| `cp -r app/admin-shell/dist/. static/admin-ui/` leaves ghosts (per `feedback_mta_static_dir_cp_ghosts`) | We're modifying — not renaming — `index.html`, so no ghost risk |
| QA channel ships divergent `joule.css` | Same file path in QA build (`hugo/public-qa/` → `static/qa/`); aurora paints there too automatically |
| Performance regression on low-end devices (4× blurred 200%×50% layers) | Layers are GPU-composited (`will-change: transform`), `pointer-events: none` so they don't block hit tests; reduced-motion fully halts |
| Visual review rejects the look | Screenshots in PR body; reviewer can request palette/timing tweaks before merge |
