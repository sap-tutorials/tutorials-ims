# Contextual Joule Help per Step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a desktop-only floating action button on every Object Page tutorial that opens the existing Joule chat panel pre-populated with step-aware starter chips, making the per-step grounding (already wired via `readPageContext()`) discoverable as a single-click affordance.

**Architecture:** Pure frontend. One new Hugo partial for the FAB shell, one extension to the existing `joule-starters.html` JSON, one include in `u1-object-page.html`, ~80 lines of JS added to `hugo/static/js/joule.js` (`openWithStepContext()` API, step-detection helper, starter substitution branch), CSS rules in `hugo/static/css/joule.css` for position + theme + ≤960px hide. No CAP changes, no schema changes, no `/chat/stream` request-shape changes.

**Tech Stack:** Hugo, vanilla JS (IIFE in joule.js), CSS custom properties, existing UI5 web components from prior U-series work, vitest smoke test (HTTP-only).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `hugo/layouts/partials/joule-step-help.html` | **create** | Renders the FAB shell (button + Joule mark + label). Hidden by default until `loadConfig()` resolves. |
| `hugo/layouts/partials/joule-starters.html` | **modify** | Add a `tutorial-step` array with three template strings containing `{n}` and `{heading}` placeholders. |
| `hugo/layouts/tutorials/u1-object-page.html` | **modify** | Include the new partial near existing wizard/sheet markup; expose `getCurrentStepFromViewport` as `window.opGetCurrentStep` so joule.js can reuse it without duplication. |
| `hugo/static/js/joule.js` | **modify** | Add `window.joule.openWithStepContext(ctx)` API; extend `renderStarters()` to accept a `tutorial-step` branch with `{n}`/`{heading}` substitution; wire FAB click handler with current-step derivation; gate FAB visibility behind `loadConfig().enabled`. |
| `hugo/static/css/joule.css` | **modify** | FAB position, theme variables, hover/focus state, ≤960px hide rule, `prefers-reduced-motion` honoring. |
| `test/smoke/joule-step-fab.test.js` | **create** | One HTTP smoke test asserting the FAB element renders on a deployed Object Page tutorial. |

No backend, no schema, no new service or endpoint.

---

## Pre-implementation Notes for Implementer

Read these before starting any task. They reflect corrections discovered during spec review and a re-read of `u1-object-page.html`.

### Correction: `.tutorial-step.in-view` does NOT exist

The spec mentions `.tutorial-step.in-view` as if it were a maintained class. **It is not.** The active layout `hugo/layouts/tutorials/u1-object-page.html` derives the current step dynamically via `getCurrentStepFromViewport()` (lines 465-481), which uses center-of-viewport scoring against `.tutorial-step` element bounding rects. Do **not** rely on a `.in-view` class. Two valid options:

1. **(Preferred)** Expose the existing helper from `u1-object-page.html`'s IIFE as `window.opGetCurrentStep`, then call it from joule.js. Single source of truth.
2. Duplicate the same scoring logic inside joule.js. Acceptable but creates drift risk.

This plan uses option 1 — see Task 3.

### Visibility gate: JS removal, not server-conditional render

The existing shellbar trigger at `joule.js:578-580` calls `trigger.remove()` when `loadConfig().enabled === false`. The FAB uses the **same gate** with the same mechanism — render the partial unconditionally on every Object Page tutorial, then `loadConfig()` either reveals it (`hidden = false`) or removes it (`fab.remove()`). No server-side `ChatSettings` lookup at template-render time; mirroring the shellbar is the consistent pattern.

### Empty heading edge case

When a step's `.step-header-text` is empty or missing, the template `"I'm stuck on Step {n}: {heading}."` would render as `"I'm stuck on Step 3: ."`. The substitution helper must drop the `: {heading}` segment when heading is empty, producing `"I'm stuck on Step 3."`. Templates 2 and 3 don't reference `{heading}` so are unaffected. Test this in Task 4.

### Smoke-test slug

Pick a stable slug that has been published to HANA in DEV and renders into Object Page. **Use `abap-environment-trial-onboarding`** — it's a long-lived ABAP tutorial that has been published since the U-series began and is unlikely to be retired. If the smoke test fails on slug-not-found in CI, swap to any tutorial slug returned by `GET /content/hashes` against the deployed srv. Confirm the slug exists with: `curl -s "$SMOKE_BASE_URL/tutorials/abap-environment-trial-onboarding/" | head -1`.

### ChatConfig vs ChatSettings naming

The CAP entity is `ChatSettings` (singular admin-managed config). The browser-facing config object returned by `/chat/config` and cached in sessionStorage is `ChatConfig` (`{ enabled, bannerText }`). Plan uses `ChatConfig` consistently when referring to the JS object — it's what `loadConfig()` returns.

### Worktree setup (controller responsibility)

Before any task runs, the executing controller (SDD or executing-plans) must invoke **superpowers:using-git-worktrees** to create an isolated workspace. Branch name: `feature/joule-step-help`. Verify clean test baseline (`npm test`) before Task 1.

---

## Task 1: Add `tutorial-step` starter templates

**Files:**
- Modify: `hugo/layouts/partials/joule-starters.html`

This is a content-only change to the embedded starters JSON. No JS yet — Task 4 will read these.

- [ ] **Step 1: Add the new key to `joule-starters.html`**

Modify `hugo/layouts/partials/joule-starters.html` to insert a `tutorial-step` array immediately after the existing `tutorial` array. The final file must be:

```html
<script id="joule-starters" type="application/json">
{
  "tutorial": [
    "Summarize this tutorial in 3 bullets.",
    "What do I need before I start?",
    "I'm stuck on the current step — help me debug."
  ],
  "tutorial-step": [
    "I'm stuck on Step {n}: {heading}.",
    "Explain Step {n} in simpler terms.",
    "What should I check before moving to the next step?"
  ],
  "search": [
    "Find me a CAP getting-started tutorial.",
    "Show me ABAP Cloud tutorials for beginners.",
    "What missions cover SAP BTP?"
  ],
  "mission": [
    "Explain this mission's path.",
    "Which tutorial should I do first?",
    "What skills will I have after completing this?"
  ],
  "group": [
    "What's in this group?",
    "Suggest a learning order.",
    "What's the next group after this one?"
  ],
  "generic": [
    "What's new in SAP BTP?",
    "Help me find a tutorial.",
    "Explain CAP in 30 seconds."
  ]
}
</script>
```

- [ ] **Step 2: Verify the JSON is valid**

Run: `node -e "const fs=require('fs');const html=fs.readFileSync('hugo/layouts/partials/joule-starters.html','utf8');const m=html.match(/<script[^>]*>([\s\S]*?)<\/script>/);JSON.parse(m[1]);console.log('OK')"`
Expected: prints `OK`. If JSON parse fails, fix syntax errors.

- [ ] **Step 3: Verify Hugo build still succeeds**

Run: `npm run hugo:build` (or `cd hugo && hugo --quiet`)
Expected: build exits 0, no template errors.

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/partials/joule-starters.html
git commit -m "feat(joule): add tutorial-step starter templates"
```

---

## Task 2: Create the FAB partial

**Files:**
- Create: `hugo/layouts/partials/joule-step-help.html`

The partial renders the button shell. It includes the existing `joule-icon.html` mark and a visible label. It is hidden by default; joule.js reveals it after `loadConfig()` resolves with `enabled: true`.

- [ ] **Step 1: Create the partial file**

Create `hugo/layouts/partials/joule-step-help.html` with exactly:

```html
<button type="button" id="joule-step-fab" class="joule-step-fab" hidden aria-label="Help with this step">
  {{ partial "joule-icon.html" (dict "size" "small") }}
  <span class="joule-step-fab__label">Help with this step</span>
</button>
```

Notes:
- `hidden` attribute and `class="joule-step-fab"` — both set up the visibility gate (CSS hides via `[hidden]`, JS toggles `hidden`).
- `aria-label` set to the same text as the visible label so screen readers don't double-announce.
- `id="joule-step-fab"` — used as the JS handle in Task 4.

- [ ] **Step 2: Verify the partial parses**

Run: `cd hugo && hugo --quiet --renderToMemory`
Expected: exits 0, no template errors. (The partial is not yet referenced from any layout, so this only checks syntax.)

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/partials/joule-step-help.html
git commit -m "feat(joule): add joule-step-help partial (FAB shell)"
```

---

## Task 3: Include the FAB and expose step helper from `u1-object-page.html`

**Files:**
- Modify: `hugo/layouts/tutorials/u1-object-page.html`

Two surgical changes: (1) include the FAB partial near the existing mobile-sheet FAB so the markup co-locates with related affordances, (2) expose `getCurrentStepFromViewport()` as `window.opGetCurrentStep` so joule.js can call it without duplication.

- [ ] **Step 1: Find the existing mobile-sheet FAB markup**

Run: `grep -n "id=\"op-step-fab\"" hugo/layouts/tutorials/u1-object-page.html`
Expected: one or two lines printed. Note the line number — Task step 2 inserts the new partial immediately AFTER the closing tag of the existing FAB so they are visually adjacent in the layout source (and the desktop FAB renders alongside the mobile FAB; CSS keeps them apart at runtime).

If `op-step-fab` is not found, search instead for the U18 sheet markup and place the new partial just after the `<ui5-dialog id="op-step-sheet">` block.

- [ ] **Step 2: Include the new partial**

Add this line on its own line, immediately after the closing tag identified in Step 1:

```html
{{ partial "joule-step-help.html" . }}
```

- [ ] **Step 3: Expose `getCurrentStepFromViewport` for joule.js**

Locate the IIFE in `u1-object-page.html` containing `function getCurrentStepFromViewport()` (line ~465). At the **end** of that IIFE (before its closing `})();`), add:

```js
  // Exposed for joule.js step-FAB to derive the current step at click time.
  // Returns 1-indexed step number based on viewport-center scoring.
  window.opGetCurrentStep = getCurrentStepFromViewport;
```

Place it just before the IIFE's closing `})();` so it captures the closure-scoped function.

- [ ] **Step 4: Verify Hugo builds and the partial renders**

Run: `npm run fetch-tutorials && npm run hugo:build`
Then: `grep -l "joule-step-fab" hugo/public/tutorials/*/index.html | head -3`
Expected: at least one tutorial HTML file contains `joule-step-fab`. If zero matches, verify the partial include path and rebuild.

- [ ] **Step 5: Verify `window.opGetCurrentStep` ships in the rendered page**

Run: `grep -l "window.opGetCurrentStep" hugo/public/tutorials/*/index.html | head -3`
Expected: at least one tutorial HTML file contains the global. If zero, check the IIFE edit landed before the closing `})();`.

- [ ] **Step 6: Commit**

```bash
git add hugo/layouts/tutorials/u1-object-page.html
git commit -m "feat(joule): include step-FAB partial; expose opGetCurrentStep"
```

---

## Task 4: Extend joule.js with step-aware starters and FAB wiring

**Files:**
- Modify: `hugo/static/js/joule.js`

This is the largest change. Five additions:
1. A pure substitution helper for `{n}` / `{heading}` with empty-heading handling.
2. An extended `renderStarters()` that accepts an optional `stepContext` arg and uses the `tutorial-step` array when supplied.
3. A new public `window.joule.openWithStepContext(ctx)` API mirroring `open()` but routing through `_openImpl(stepContext)`.
4. A FAB click handler that derives `{slug, n, heading}` and calls `openWithStepContext()`.
5. Visibility gate: reveal/remove the FAB inside the existing `loadConfig().then(cfg => { ... })` block.

- [ ] **Step 1: Add the substitution helper**

Insert this function just above `renderStarters()` (currently at line 331 of `joule.js`):

```js
function applyStepTemplate(tpl, ctx) {
  // ctx: { n: number, heading: string }
  // Replaces {n} with the step number. Replaces {heading} with the heading.
  // If heading is empty/missing, drops the ": {heading}" suffix segment so we
  // never produce "Step 3: ." — falls back to "Step 3."
  const n = String(ctx.n || 1);
  const heading = (ctx.heading || '').trim();
  if (!heading) {
    // Strip ": {heading}" (with optional surrounding whitespace) before substitution.
    return tpl.replace(/:\s*\{heading\}/g, '').replace(/\{n\}/g, n);
  }
  return tpl.replace(/\{n\}/g, n).replace(/\{heading\}/g, heading);
}
```

- [ ] **Step 2: Extend `renderStarters()` to accept `stepContext`**

Replace the existing `renderStarters()` body (currently lines 331-346) with:

```js
function renderStarters(stepContext) {
  const starters = loadStarters();
  const ctx = readPageContext();
  let list;
  if (stepContext && Array.isArray(starters['tutorial-step'])) {
    list = starters['tutorial-step'].map((tpl) => applyStepTemplate(tpl, stepContext));
  } else {
    list = starters[ctx.kind] || starters.generic || [];
  }
  const wrap = panel.querySelector('.joule-panel__starters');
  if (!wrap) return;
  wrap.replaceChildren();
  for (const text of list.slice(0, 3)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'joule-panel__starter';
    btn.textContent = text;
    btn.addEventListener('click', () => { input.value = text; send(text); });
    wrap.appendChild(btn);
  }
}
```

- [ ] **Step 3: Add `openWithStepContext` to `window.joule` and route through `_openImpl`**

In the `window.joule = { ... }` object literal (currently lines 21-28), add a new method:

```js
window.joule = {
  _ready: false,
  _pendingOpen: null,
  open(opts) {
    if (!this._ready) { this._pendingOpen = opts || true; return; }
    _openImpl(opts);
  },
  openWithStepContext(stepContext) {
    if (!this._ready) { this._pendingOpen = { stepContext }; return; }
    _openImpl({ stepContext });
  },
};
```

Then update `_openImpl(opts)` (currently at line 491) to thread `stepContext` into the starters call. The renderStarters call inside (currently line 506) becomes:

```js
renderStarters(opts && opts.stepContext);
```

Also handle the pending-open replay at lines 594-598. The existing replay does `_openImpl(pending === true ? undefined : pending)`. Since we now stash `{ stepContext }` as the pending payload, the existing call already works — it just forwards the object. **No change needed at lines 594-598**, but verify after editing that pending payload pass-through still functions (covered by Step 7 manual check).

- [ ] **Step 4: Add the FAB click wiring inside the `loadConfig().then(...)` block**

Inside the existing `loadConfig().then(cfg => { ... })` block (currently lines 578-599), at the **end** of the block (just before `window.joule._ready = true;`), add:

```js
const fab = document.getElementById('joule-step-fab');
if (fab) {
  if (!cfg.enabled) {
    fab.remove();
  } else {
    fab.hidden = false;
    fab.addEventListener('click', () => {
      const slug = document.documentElement.dataset.pageSlug || '';
      const n = (typeof window.opGetCurrentStep === 'function') ? window.opGetCurrentStep() : 1;
      const stepEl = document.querySelector('.tutorial-step[data-step="' + n + '"]')
                  || document.querySelectorAll('.tutorial-step')[n - 1];
      const headingEl = stepEl ? stepEl.querySelector('.step-header-text') : null;
      const heading = headingEl ? headingEl.textContent.trim() : '';
      window.joule.openWithStepContext({ slug, n, heading });
    });
  }
}
```

Notes on resilience:
- If `window.opGetCurrentStep` is missing (e.g., legacy `single.html` ever sneaks in), fall back to step 1.
- If the matched `.tutorial-step` has no `.step-header-text`, heading is empty and `applyStepTemplate` drops the colon segment.
- `data-page-slug` on `<html>` is the same source `readPageContext()` already uses — see joule.js:265.

- [ ] **Step 5: Add a unit-style sanity check by writing a one-off node script**

This file is throwaway — it verifies `applyStepTemplate` logic without setting up a full browser test harness. Create `test/unit/joule-step-template.test.js`:

```js
import { describe, it, expect } from 'vitest';

// Inline copy of the helper. Tests the pure substitution behavior. If this
// drifts from joule.js, update both.
function applyStepTemplate(tpl, ctx) {
  const n = String(ctx.n || 1);
  const heading = (ctx.heading || '').trim();
  if (!heading) {
    return tpl.replace(/:\s*\{heading\}/g, '').replace(/\{n\}/g, n);
  }
  return tpl.replace(/\{n\}/g, n).replace(/\{heading\}/g, heading);
}

describe('applyStepTemplate', () => {
  it('substitutes both {n} and {heading} when heading is non-empty', () => {
    expect(applyStepTemplate("I'm stuck on Step {n}: {heading}.", { n: 3, heading: 'Configure HANA' }))
      .toBe("I'm stuck on Step 3: Configure HANA.");
  });

  it('drops the ": {heading}" segment when heading is empty', () => {
    expect(applyStepTemplate("I'm stuck on Step {n}: {heading}.", { n: 3, heading: '' }))
      .toBe("I'm stuck on Step 3.");
  });

  it('leaves heading-free templates unchanged when heading is empty', () => {
    expect(applyStepTemplate('Explain Step {n} in simpler terms.', { n: 2, heading: '' }))
      .toBe('Explain Step 2 in simpler terms.');
  });

  it('falls back to step 1 when n is missing or zero', () => {
    expect(applyStepTemplate('Step {n}.', { n: 0, heading: '' }))
      .toBe('Step 1.');
  });

  it('trims whitespace-only headings', () => {
    expect(applyStepTemplate("Step {n}: {heading}.", { n: 1, heading: '   ' }))
      .toBe('Step 1.');
  });
});
```

- [ ] **Step 6: Run the unit test (it should fail first since `applyStepTemplate` only lives inline in joule.js — but the inline copy in the test file is the spec)**

Run: `npm test -- joule-step-template`
Expected: 5/5 passing. (The test file embeds its own copy of the helper, so this validates the substitution rules themselves. If you have ESM/CJS issues, the test still runs as a vitest unit test under the existing `test/unit/` workspace.)

- [ ] **Step 7: Run the full unit suite to confirm no regression**

Run: `npm test`
Expected: all unit tests pass (matches the baseline established before Task 1). If new failures appear that don't reference `joule` or step-template, they are likely the pre-existing 29 failures from `[main_test_failures]` memory and predate this work — flag them in your status report but do not block.

- [ ] **Step 8: Commit**

```bash
git add hugo/static/js/joule.js test/unit/joule-step-template.test.js
git commit -m "feat(joule): step-aware starters and FAB click wiring"
```

---

## Task 5: Style the FAB

**Files:**
- Modify: `hugo/static/css/joule.css`

Add the FAB styles at the bottom of the file. Use the existing Joule purple palette so it visually matches the panel.

- [ ] **Step 1: Append FAB styles to `joule.css`**

Add this block at the end of `hugo/static/css/joule.css`:

```css
/* Step-help FAB: desktop-only, anchored bottom-right, matches U18 z-index. */
.joule-step-fab {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  z-index: 40;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 1rem;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: linear-gradient(165deg, var(--joule-purple-1) 0%, var(--joule-purple-2) 50%, var(--joule-purple-3) 100%);
  color: var(--joule-text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.05);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.joule-step-fab[hidden] {
  display: none;
}

.joule-step-fab:hover {
  transform: translateY(-1px);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.1);
}

.joule-step-fab:focus-visible {
  outline: 2px solid var(--joule-purple-2);
  outline-offset: 2px;
}

.joule-step-fab svg {
  width: 18px;
  height: 18px;
}

.joule-step-fab__label {
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .joule-step-fab {
    transition: none;
  }
  .joule-step-fab:hover {
    transform: none;
  }
}

/* Mobile: hide entirely. Shellbar Joule trigger is the mobile entry point.
   Matches the .op-twocol breakpoint and avoids stacking with U18's mobile FAB. */
@media (max-width: 960px) {
  .joule-step-fab {
    display: none !important;
  }
}
```

- [ ] **Step 2: Verify the CSS parses**

Run: `cd hugo && hugo --quiet`
Expected: build exits 0, no PostCSS errors.

- [ ] **Step 3: Commit**

```bash
git add hugo/static/css/joule.css
git commit -m "feat(joule): style step-help FAB (desktop-only, branded)"
```

---

## Task 6: Smoke test for FAB presence

**Files:**
- Create: `test/smoke/joule-step-fab.test.js`

One HTTP test that fetches a deployed Object Page tutorial and asserts the FAB markup is present.

- [ ] **Step 1: Write the smoke test**

Create `test/smoke/joule-step-fab.test.js`:

```js
import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:5000';
// Stable tutorial slug — long-lived ABAP onboarding tutorial.
// If this slug is retired, swap to any slug returned by GET /content/hashes.
const SLUG = 'abap-environment-trial-onboarding';

describe('joule step-help FAB smoke', () => {
  it('renders the FAB on a tutorial Object Page', async () => {
    const r = await fetch(`${BASE}/tutorials/${SLUG}/`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toMatch(/id=["']?joule-step-fab["']?/);
    expect(html).toMatch(/Help with this step/);
  });

  it('exposes window.opGetCurrentStep for FAB click handling', async () => {
    const r = await fetch(`${BASE}/tutorials/${SLUG}/`);
    const html = await r.text();
    expect(html).toMatch(/window\.opGetCurrentStep\s*=/);
  });

  it('embeds the tutorial-step starter array', async () => {
    const r = await fetch(`${BASE}/tutorials/${SLUG}/`);
    const html = await r.text();
    // The whole starters JSON is inlined; assert the new key is in the payload.
    expect(html).toMatch(/"tutorial-step"\s*:/);
  });
});
```

- [ ] **Step 2: Run the smoke test against a running local stack (optional pre-merge gate)**

Locally:
```bash
# In one terminal:
npm run dev:hybrid
# In another:
SMOKE_BASE_URL=http://localhost:5000 npm run test:smoke -- joule-step-fab
```
Expected: 3/3 passing. If the tutorial has not been published to HANA in your local hybrid env, run `npm run publish-content -- --force` first.

The test will also run automatically post-deploy in CI via `.github/workflows/deploy.yml`.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/joule-step-fab.test.js
git commit -m "test(smoke): assert step-help FAB renders on tutorial pages"
```

---

## Task 7: Manual browser verification

This task has no code changes — it follows the project's CLAUDE.md rule that UI changes must be tested in a browser before claiming success. Document the result in the implementation summary.

**Setup:** Run `npm run dev:hybrid` (CAP backend + approuter on :5000). Make sure tutorials are published to local HANA (`npm run publish-content -- --force`).

- [ ] **Step 1: Verify desktop FAB appears**

Open `http://localhost:5000/tutorials/abap-environment-trial-onboarding/` in a desktop-width browser (≥961px viewport). Expected: pill-shaped FAB with Joule mark and "Help with this step" label is visible at bottom-right.

- [ ] **Step 2: Verify FAB opens panel with step-1 starters at top of page**

Without scrolling, click the FAB. Expected: Joule panel opens (no auth challenge if you're already logged in via cds bind hybrid; otherwise log in first). Hero state shows three starters reading:
- "I'm stuck on Step 1: <heading of first step>."
- "Explain Step 1 in simpler terms."
- "What should I check before moving to the next step?"

- [ ] **Step 3: Verify starters update as you scroll**

Close the panel. Scroll to step 3 (or any step past the first). Click the FAB again. Expected: starters now reference Step 3 with that step's heading.

- [ ] **Step 4: Verify a starter click sends the message**

Click any starter chip. Expected: chip text appears as user message in chat transcript; Joule responds. Check the response contextually references the current step.

- [ ] **Step 5: Verify mobile hide**

Resize the browser to ≤960px width or use device emulation (e.g., Chrome DevTools → iPhone 12). Expected: FAB is hidden. The shellbar Joule icon remains visible on mobile.

- [ ] **Step 6: Verify history precedence**

Open a fresh page, click FAB → starters appear → send a message → close panel → click FAB again. Expected: existing transcript shows, NOT starters. (Documented behavior: history takes precedence; click "Clear chat" in the overflow menu and click FAB again to see step-specific starters.)

- [ ] **Step 7: Verify chat-disabled gate**

In a separate terminal, toggle `ChatSettings.chatEnabled` to `false` (admin UI: Operations → Joule Chat Settings → uncheck Enabled, or via SQL: `UPDATE TUTORIALS_CHATSETTINGS SET CHATENABLED = false`). Refresh the page. Expected: FAB is removed from DOM, shellbar Joule icon also hidden. Re-enable after testing.

- [ ] **Step 8: Verify anonymous-user redirect**

Log out (or open in incognito). Visit a tutorial page, click FAB. Expected: redirect to `/login?returnTo=/tutorials/<slug>/?joule=open`. After logging in, panel auto-opens with step-specific starters (or transcript if history exists).

- [ ] **Step 9: Verify empty-heading edge case (synthetic)**

In DevTools, run:
```js
document.querySelector('.tutorial-step[data-step="1"] .step-header-text').textContent = '';
document.getElementById('joule-step-fab').click();
```
Expected: starters render as "I'm stuck on Step 1." (no trailing colon-space-period). Refresh to restore.

- [ ] **Step 10: Verify keyboard accessibility**

Tab through the page until focus lands on the FAB. Expected: visible focus ring (via `:focus-visible` / `outline-offset: 2px`). Press Enter. Expected: panel opens.

- [ ] **Step 11: Verify reduced-motion preference**

In DevTools → Rendering panel → set `prefers-reduced-motion` to `reduce`. Hover the FAB. Expected: no transform/translate animation; only color/box-shadow shift if any.

- [ ] **Step 12: Document results in commit message of next change OR PR description**

If all 11 checks pass, no further commit needed for this task — note in the PR description "Manual browser verification: all 11 checks per plan Task 7 pass."

If any check fails, do NOT mark the task complete. File a follow-up task fixing the specific failing check, re-run.

---

## Task 8: PR creation

**Files:** none (workflow only)

Per the [pr_over_direct_merge] memory: default to `gh pr create` from the feature branch. Subagent review ≠ PR review.

- [ ] **Step 1: Verify branch is up to date with origin/main**

Run:
```bash
git fetch origin main
git log --oneline origin/main..HEAD
```
Expected: only this feature's commits are listed (Tasks 1, 2, 3, 4, 5, 6, plus any review-loop fixes).

- [ ] **Step 2: Push and open the PR**

Run:
```bash
git push -u origin feature/joule-step-help

gh pr create --title "feat(joule): contextual step-help FAB on Object Page tutorials" --body "$(cat <<'EOF'
## Summary
- Desktop-only floating action button on every Object Page tutorial that opens the Joule chat panel pre-populated with step-aware starter chips.
- Pure frontend: new partial, `tutorial-step` starter templates, ~80 lines added to joule.js, scoped CSS, one smoke test.
- No backend, no schema, no /chat/stream request-shape change. Per-step grounding is already wired via readPageContext().

## Test plan
- [x] Unit: applyStepTemplate substitution covered (5/5 passing) — test/unit/joule-step-template.test.js
- [x] Smoke: FAB markup, opGetCurrentStep, tutorial-step starters present on deployed tutorial — test/smoke/joule-step-fab.test.js
- [x] Manual browser verification: all 11 checks per plan Task 7 pass

Spec: docs/superpowers/specs/2026-05-22-joule-step-help-design.md
Plan: docs/superpowers/plans/2026-05-22-joule-step-help.md
EOF
)"
```

- [ ] **Step 3: Note the PR URL in your final status report**

Capture the URL printed by `gh pr create` and include it in the controller's hand-off message to Tom.

---

## Sequencing notes

Tasks must be executed **in order**: Task 2 (FAB partial) is a prerequisite for Task 3 (the include can't reference a nonexistent file). Task 4 (joule.js wiring) depends on Task 1 (starters JSON has the `tutorial-step` key) and Task 3 (`window.opGetCurrentStep` exists). Task 5 (CSS) and Task 6 (smoke) can technically be done in parallel after Task 4, but in practice doing them sequentially keeps commits clean. Task 7 (manual verification) requires all preceding tasks to land. Task 8 is the PR.

For controller bookkeeping: Tasks 1, 2, 5, 6 are simple mechanical edits → cheaper model. Tasks 3, 4 are integration tasks touching live JS and Hugo template plumbing → standard model. Task 7 is human-in-the-loop verification.

## Post-merge follow-ups (NOT part of this plan)

- Analytics for FAB click-through rate (rejected from spec, can be added later).
- Mobile parity beyond the existing shellbar trigger (rejected from spec to avoid U18 collision).
- LLM-generated per-step starters (rejected as Approach B in brainstorming).
- Background `getRelevantSteps` pre-fetch on FAB click (rejected as Approach C in brainstorming).
