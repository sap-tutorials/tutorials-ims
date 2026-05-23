# U18 — Mobile Step Navigator Bottom Sheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a floating action button (FAB) on mobile viewports of the Object Page tutorial layout that opens a bottom sheet containing the step list and step controls (Previous, Mark Done, Next), with a brief `<ui5-busy-indicator>` cue during the post-tap smooth-scroll.

**Architecture:** Single-file modification of `hugo/layouts/tutorials/u1-object-page.html`. Adds FAB markup, a positioned `<ui5-dialog>` containing `<ui5-busy-indicator>` wrapping `<ui5-list>`, scoped CSS, and an inline wiring script that integrates with the existing wizard step-change globals and `window.completeStep` action. Hidden via CSS at >960px so desktop is untouched.

**Tech Stack:** UI5 Web Components v2.x (`<ui5-button>`, `<ui5-dialog>`, `<ui5-busy-indicator>`, `<ui5-list>`, `<ui5-li>`, `<ui5-icon>`). No new files, no new bundles, no backend changes.

**Spec:** [`docs/superpowers/specs/2026-05-22-u18-mobile-sheet-design.md`](../specs/2026-05-22-u18-mobile-sheet-design.md)

---

## Resolved Open Questions

- **Q1 — After Prev/Next, sheet stays open.** The user's intent when tapping Prev/Next is "navigate the steps quickly"; closing the sheet would force them to re-tap the FAB on every move. Tapping a step row does close the sheet (different intent: "jump to this step"). Tapping outside or pressing Escape closes (UI5 default).
- **Q2 — FAB shows icon + text "Steps".** Pure-icon is ambiguous; the FAB doesn't take much space at the lower-right and the label aids discoverability. Use `<ui5-button design="Emphasized" icon="menu2">Steps</ui5-button>`.
- **`prefers-reduced-motion`** — when the media query matches, skip the smooth-scroll animation and the 400ms busy delay; jump to the anchor and close immediately. Avoids motion-sickness triggers and keeps the sheet behavior coherent.
- **Z-index policy** — FAB at `z-index: 40`; the dialog's portal element renders at UI5's own z-index (much higher) so we don't need to compete. The existing feedback popup uses a higher z-index than the FAB, which is correct: a modal popup should sit over the FAB.

---

## Pre-flight (already done in prior session)

- Worktree set up at `.worktrees/u18-mobile-sheet` on branch `ui-pilot/u18-mobile-sheet` from `origin/main` at `91faa04`.
- `npm install` complete; baseline `npm test` matches main (29 pre-existing failures, no new ones).
- UI5 v2.x APIs verified at design time: `<ui5-dialog>` uses `open` property (not `.show()/.close()`); `<ui5-busy-indicator>` uses `active` boolean; `<ui5-list>` `item-click` event payload exposes `event.detail.item`.

## Layout facts the wiring depends on

Verified before plan-writing — these are the contracts the script reads from:

- **Slug exposure:** `<div id="progress-bar" data-step-count="…" data-slug="{{ .Params.slug }}">` at line 204 of the layout. The wiring script reads `document.querySelector('#progress-bar')?.getAttribute('data-slug')` — same as `tutorial.ts` does.
- **Step anchors:** `<div id="step-{{ $number }}" class="tutorial-step" data-step="{{ $number }}">` rendered by the `tutorial-step.html` shortcode. We can navigate by `getElementById('step-' + N)`.
- **Step metadata:** `.Params.steps` items expose a `.number` field (used by the existing wizard at lines 193–200). Iterate the steps with `{{ range .Params.steps }}` and use `.number` directly — do not compute `add $i 1`.
- **Current-step source:** the existing `<ui5-wizard id="op-step-wizard">` already tracks the visible step via the layout's IntersectionObserver scrollspy (lines ~280–340). Read `op-step-wizard.querySelector('ui5-wizard-step[selected]')` to find the current step. Fall back to step 1 when the wizard isn't rendered (tutorials with `stepCount < 3`).
- **Mark Done global:** `window.completeStep(slug, stepNumber)` is the existing global called by per-step inline buttons. It accepts a slug + 1-based step number.

---

## Task 1: Register UI5 Dialog + BusyIndicator + List imports

**Files:**
- Modify: `hugo/assets/js/ui5-bootstrap.ts`

- [ ] **Step 1: Inspect current imports**

```bash
grep -n "import" hugo/assets/js/ui5-bootstrap.ts
```

Expected: existing imports for the components already used elsewhere (Button, Wizard, etc.).

- [ ] **Step 2: Add the missing imports**

If not already present, add:

```ts
import "@ui5/webcomponents/dist/Dialog.js";
import "@ui5/webcomponents/dist/BusyIndicator.js";
import "@ui5/webcomponents/dist/List.js";
import "@ui5/webcomponents/dist/ListItemStandard.js";
import "@ui5/webcomponents-icons/dist/menu2.js";
```

(`<ui5-li>` is implemented by `ListItemStandard`. The `menu2` icon is for the FAB.)

- [ ] **Step 3: Build to confirm**

```bash
npm run build:apps
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add hugo/assets/js/ui5-bootstrap.ts
git commit -m "$(cat <<'EOF'
feat(u18): register ui5-dialog/busy-indicator/list imports

Wires the components needed by the upcoming mobile bottom-sheet on
the Object Page tutorial layout.
EOF
)"
```

---

## Task 2: Add FAB + bottom-sheet markup to the layout

**Files:**
- Modify: `hugo/layouts/tutorials/u1-object-page.html`

- [ ] **Step 1: Add FAB markup**

Just before the closing tag of the layout's main content area (and before the existing `<script type="module">` block), add:

```html
<ui5-button
  id="op-mobile-fab"
  design="Emphasized"
  icon="menu2"
  accessible-name="Open step list"
>Steps</ui5-button>
```

- [ ] **Step 2: Add bottom-sheet dialog markup**

Right after the FAB. Iterate `.Params.steps` and use `.number` (matches the existing wizard at lines 193–200):

```html
{{ if .Params.steps }}
<ui5-dialog id="op-mobile-sheet" accessible-name="Tutorial step navigator">
  <div slot="header" class="op-sheet__header">
    <span id="op-sheet-title">Step <span id="op-sheet-current">1</span> of <span id="op-sheet-total">{{ len .Params.steps }}</span></span>
    <ui5-button
      id="op-sheet-close"
      design="Transparent"
      icon="decline"
      accessible-name="Close step list"
    ></ui5-button>
  </div>
  <ui5-busy-indicator id="op-mobile-busy" delay="0">
    <ui5-list id="op-mobile-step-list" mode="None">
      {{ range .Params.steps }}
        <ui5-li data-step-number="{{ .number }}" data-step-target="step-{{ .number }}">
          {{ .number }}. {{ .title }}
        </ui5-li>
      {{ end }}
    </ui5-list>
  </ui5-busy-indicator>
  <div slot="footer" class="op-sheet__footer">
    <ui5-button id="op-sheet-prev" design="Transparent">Previous</ui5-button>
    <ui5-button id="op-sheet-mark" design="Emphasized">Mark Done</ui5-button>
    <ui5-button id="op-sheet-next" design="Default">Next</ui5-button>
  </div>
</ui5-dialog>
{{ end }}
```

The `{{ if .Params.steps }}` guard ensures the dialog isn't rendered on tutorials that have no parsed steps (parser-v1 legacy edge cases). The FAB itself remains for visual consistency but its click handler will no-op if the dialog is absent.

- [ ] **Step 3: Verify Hugo builds without template errors**

```bash
npm run fetch-tutorials
hugo --quiet
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/tutorials/u1-object-page.html
git commit -m "$(cat <<'EOF'
feat(u18): add mobile FAB and bottom-sheet markup

Static markup for the floating "Steps" button and the ui5-dialog
that hosts the step list + Previous/Mark Done/Next controls. Hidden
via CSS at >960px (next commit).
EOF
)"
```

---

## Task 3: Add scoped CSS

**Files:**
- Modify: `hugo/layouts/tutorials/u1-object-page.html` — existing `<style>` block

- [ ] **Step 1: Add FAB visibility + position rules**

In the `<style>` block at the top of the layout (where `.op-twocol`, etc. live):

```css
#op-mobile-fab {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  z-index: 40;
  display: none;
}

@media (max-width: 960px) {
  #op-mobile-fab { display: inline-flex; }
}

#op-mobile-sheet::part(content) {
  padding: 0;
  max-height: 70vh;
  overflow-y: auto;
}

#op-mobile-sheet::part(header),
#op-mobile-sheet::part(footer) {
  padding: 0.5rem 1rem;
}

.op-sheet__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  font-weight: 600;
}

.op-sheet__footer {
  display: flex;
  gap: 0.5rem;
  justify-content: space-between;
  width: 100%;
}

@media (prefers-reduced-motion: reduce) {
  /* Used by the wiring script to choose between smooth and instant scroll */
  :root { --u18-reduce-motion: 1; }
}
```

The dialog's viewport-bottom positioning relies on UI5's default centered positioning being overridden by adjusting the dialog's host transform. Achieved with this addition:

```css
#op-mobile-sheet {
  --_ui5_popup_default_padding: 0;
}
#op-mobile-sheet::part(root) {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  width: 100%;
  max-width: 100%;
  max-height: 80vh;
  border-radius: 0.75rem 0.75rem 0 0;
  margin: 0;
  transform: none;
  top: auto;
}
```

(If `::part(root)` does not expose enough surface area, fall back per the spec's stated risk: replace `<ui5-dialog>` with `<div role="dialog" aria-modal="true">` and hand-roll focus management while keeping `<ui5-list>`/`<ui5-button>` inside.)

- [ ] **Step 2: Verify at >960px and ≤960px in dev**

```bash
npm run dev
```

Open a tutorial page; resize the viewport.

Expected:
- >960px: FAB hidden, no DOM intrusion
- ≤960px: FAB visible at lower-right; tap causes dialog to slide up from the viewport bottom

If the dialog refuses to anchor at the bottom (shadow-DOM internals fight `::part(root)`), execute the fallback: replace `<ui5-dialog>` markup with a bare `<div id="op-mobile-sheet" role="dialog" aria-modal="true" hidden>` and adjust the wiring script accordingly. Document the fallback in the commit message.

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/tutorials/u1-object-page.html
git commit -m "$(cat <<'EOF'
feat(u18): scoped CSS for mobile FAB and bottom-sheet positioning

FAB hidden above 960px (matches existing .op-twocol breakpoint);
ui5-dialog overridden via ::part(root) to anchor at the viewport
bottom. Honors prefers-reduced-motion via a CSS variable consumed
by the wiring script.
EOF
)"
```

---

## Task 4: Add inline wiring script

**Files:**
- Modify: `hugo/layouts/tutorials/u1-object-page.html` — existing `<script type="module">` block at the bottom

- [ ] **Step 1: Append the wiring block**

Inside the existing module script (so it shares scope with the wizard wiring), add:

```js
const fab = document.getElementById("op-mobile-fab");
const sheet = document.getElementById("op-mobile-sheet");
const list = document.getElementById("op-mobile-step-list");
const busy = document.getElementById("op-mobile-busy");
const closeBtn = document.getElementById("op-sheet-close");
const prevBtn = document.getElementById("op-sheet-prev");
const nextBtn = document.getElementById("op-sheet-next");
const markBtn = document.getElementById("op-sheet-mark");
const currentLabel = document.getElementById("op-sheet-current");
const wizard = document.getElementById("op-step-wizard");

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const SCROLL_DELAY = reduceMotion ? 0 : 400;

const tutorialSlug =
  document.querySelector("#progress-bar")?.getAttribute("data-slug") ||
  document.querySelector("#tutorial-rating-mount")?.getAttribute("data-slug") ||
  "";

function getStepCount() {
  return list?.querySelectorAll("ui5-li").length || 0;
}

function getCurrentStepFromWizard() {
  // Source of truth: the existing wizard's selected step (already maintained
  // by the scrollspy IntersectionObserver in this same module script).
  if (!wizard) return 1;
  const steps = Array.from(wizard.querySelectorAll("ui5-wizard-step"));
  const idx = steps.findIndex((s) => s.hasAttribute("selected"));
  return idx >= 0 ? idx + 1 : 1;
}

function getCurrentStepFromViewport() {
  // Fallback when the wizard isn't rendered (stepCount < 3): use the topmost
  // visible .tutorial-step intersecting the viewport center.
  const sections = Array.from(document.querySelectorAll(".tutorial-step"));
  if (!sections.length) return 1;
  const center = window.innerHeight / 2;
  let bestIdx = 0;
  let bestDist = Infinity;
  sections.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    const dist = Math.abs(rect.top - center);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  });
  return bestIdx + 1;
}

function getCurrentStep() {
  return wizard ? getCurrentStepFromWizard() : getCurrentStepFromViewport();
}

function setBoundaryDisabled(current, total) {
  if (prevBtn) prevBtn.disabled = current <= 1;
  if (nextBtn) nextBtn.disabled = current >= total;
}

function syncListFromDom() {
  if (!list) return;
  const total = getStepCount();
  const current = getCurrentStep();
  const completed = new Set(
    Array.from(document.querySelectorAll(".tutorial-step.completed")).map((el) =>
      Number(el.dataset.step || el.id.replace(/^step-/, "")),
    ),
  );
  list.querySelectorAll("ui5-li").forEach((li) => {
    const n = Number(li.dataset.stepNumber);
    li.toggleAttribute("selected", n === current);
    if (completed.has(n)) li.setAttribute("icon", "accept");
    else li.removeAttribute("icon");
  });
  if (currentLabel) currentLabel.textContent = String(current);
  setBoundaryDisabled(current, total);
}

function scrollToStep(n) {
  const el = document.getElementById(`step-${n}`);
  if (!el) return false;
  el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  return true;
}

function openSheet() {
  if (!sheet) return;
  syncListFromDom();
  sheet.setAttribute("open", "");
}

function closeSheet() {
  sheet?.removeAttribute("open");
}

fab?.addEventListener("click", openSheet);
closeBtn?.addEventListener("click", closeSheet);

list?.addEventListener("item-click", (e) => {
  const item = e.detail?.item;
  const n = Number(item?.dataset?.stepNumber);
  if (!n || !scrollToStep(n)) return;
  if (busy) busy.active = true;
  setTimeout(() => {
    if (busy) busy.active = false;
    closeSheet();
  }, SCROLL_DELAY);
});

prevBtn?.addEventListener("click", () => {
  const current = getCurrentStep();
  if (current <= 1) return;
  if (scrollToStep(current - 1)) {
    // Wait one frame so the wizard's scrollspy has a chance to update before we re-read it
    requestAnimationFrame(() => requestAnimationFrame(syncListFromDom));
  }
});

nextBtn?.addEventListener("click", () => {
  const current = getCurrentStep();
  const total = getStepCount();
  if (current >= total) return;
  if (scrollToStep(current + 1)) {
    requestAnimationFrame(() => requestAnimationFrame(syncListFromDom));
  }
});

markBtn?.addEventListener("click", () => {
  const current = getCurrentStep();
  if (typeof window.completeStep === "function" && tutorialSlug) {
    window.completeStep(tutorialSlug, current);
    syncListFromDom();
  }
});

// Re-sync while the sheet is open and step completion / wizard selection changes.
const stepObserver = new MutationObserver(() => {
  if (sheet?.hasAttribute("open")) syncListFromDom();
});
const stepsRoot = document.querySelector(".tutorial-steps");
if (stepsRoot) stepObserver.observe(stepsRoot, { attributes: true, subtree: true, attributeFilter: ["class"] });
if (wizard) stepObserver.observe(wizard, { attributes: true, subtree: true, attributeFilter: ["selected"] });
```

The slug-lookup chain (`#progress-bar` → `#tutorial-rating-mount`) mirrors how `tutorial.ts` already locates the slug in this layout — no new attributes added.

- [ ] **Step 2: Verify in dev**

```bash
npm run dev
```

Open a tutorial at ≤960px width.
- Tap FAB → sheet opens, list shows current step highlighted
- Tap a step row → busy spinner shows briefly, page scrolls, sheet closes
- Tap Previous/Next → page scrolls; sheet stays open; current-step label updates
- Tap Mark Done → step gets the completed class, list updates icon
- Tap outside or press Escape → sheet closes

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/tutorials/u1-object-page.html
git commit -m "$(cat <<'EOF'
feat(u18): wire mobile bottom-sheet to existing wizard globals

Inline module script:
- FAB toggles dialog open
- Step rows: busy-indicator + smooth-scroll + close
- Previous/Next: scroll, keep sheet open, refresh current-step label
- Mark Done: invokes window.completeStep(slug, current)
- Escape and outside-tap close (ui5-dialog defaults)
- Honors prefers-reduced-motion (instant scroll, zero busy delay)
EOF
)"
```

---

## Task 5: Manual browser verification checklist

**Files:** none — verification only

- [ ] **Step 1: Run unit tests baseline**

```bash
npm test
```

Expected: same pass/fail count as main.

- [ ] **Step 2: Desktop (>960px) regression check**

Open a tutorial in a desktop-width window. Expected: FAB absent, sheet absent (or `display: none`), wizard + right-rail mission nav unchanged.

- [ ] **Step 3: Mobile (≤960px) FAB visibility**

Resize to 600px. Expected: FAB visible at lower-right, doesn't overlap the existing sticky `.op-header` or any other sticky element.

- [ ] **Step 4: Open + close paths**

- Tap FAB → sheet slides up; first focusable element receives focus
- Tap close icon → sheet closes
- Tap outside sheet → sheet closes
- Press Escape → sheet closes

- [ ] **Step 5: Step list correctness**

- Step count matches the number of tutorial steps
- Current step highlighted (`selected`)
- Completed steps show check icon (`icon="accept"`)
- Tap a step row → busy indicator visible briefly, page scrolls to that step's anchor, sheet closes

- [ ] **Step 6: Footer controls**

- Previous: scrolls to prior step; sheet stays open; current-step label updates; **disabled when on step 1**
- Next: scrolls to next step; sheet stays open; **disabled when on the last step**
- Mark Done: step's `.tutorial-step.completed` class is added (verify via inspector); reopen sheet → completion icon visible on that row

- [ ] **Step 7: Reduced motion**

In OS settings (or dev tools "Emulate CSS media feature prefers-reduced-motion"), enable reduced motion. Tap a step row. Expected: instant scroll, no 400ms busy delay.

- [ ] **Step 8: Light + Dark theme**

Toggle theme. Expected: both render; sheet background, footer buttons, and step list all readable.

- [ ] **Step 9: Cross-browser spot-check**

iOS Safari, Android Chrome, desktop Chrome at 600px width: FAB position is correct, dialog anchors at viewport bottom, no z-index collisions with the feedback popup or any other floating element.

- [ ] **Step 10: Wizard regression**

Above 960px: confirm `<ui5-wizard>` step indicator still tracks scroll, and the right-rail mission side-nav (U16) still works.

---

## Task 6: Open PR

**Files:** none — git/gh

- [ ] **Step 1: Push branch**

```bash
git push -u origin ui-pilot/u18-mobile-sheet
```

- [ ] **Step 2: Create PR**

```bash
gh pr create --title "U18: Mobile step navigator bottom sheet" --body "$(cat <<'EOF'
## Summary
- Adds a floating "Steps" button on `u1-object-page.html` at `≤960px` viewport
- Tap → opens a `<ui5-dialog>`-based bottom sheet containing the step list and Previous/Mark Done/Next controls
- `<ui5-busy-indicator>` provides a brief visual cue during the post-tap smooth-scroll
- Hidden entirely above 960px — desktop is untouched

## Test plan
- [x] Unit tests baseline matches main
- [ ] Manual: >960px regression (FAB and sheet absent; wizard + side-nav unchanged)
- [ ] Manual: ≤960px FAB visibility, no overlap with sticky header
- [ ] Manual: open/close (FAB, close icon, outside-tap, Escape)
- [ ] Manual: step list correctness (count, current selected, completed icons)
- [ ] Manual: footer controls (Prev/Next keeps sheet open; Mark Done uses window.completeStep)
- [ ] Manual: prefers-reduced-motion honored
- [ ] Manual: light + dark themes
- [ ] Manual: iOS Safari, Android Chrome, desktop Chrome at 600px

Spec: `docs/superpowers/specs/2026-05-22-u18-mobile-sheet-design.md`
EOF
)"
```

- [ ] **Step 3: Capture PR URL for handoff**

Print the PR URL. Done.
