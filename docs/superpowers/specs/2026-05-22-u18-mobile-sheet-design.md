# U18 — Mobile Step Navigator Bottom Sheet Design Spec

**Date:** 2026-05-22
**Branch:** `ui-pilot/u18-mobile-sheet`
**Pilot series:** U18 of the UI5-pilot pattern (presentational ui5-* component on existing surface)

## Goal

On mobile viewports of the Object Page tutorial layout (`hugo/layouts/tutorials/u1-object-page.html`), add a floating action button (FAB) that opens a bottom sheet containing both **the step list** (jump to a step, see completion state) and **the step controls** (Previous, Mark Done, Next). Use `<ui5-busy-indicator>` to provide a brief visual cue during the smooth-scroll transition that follows a step jump.

## Why

The Object Page tutorial layout already provides a `<ui5-wizard>` step indicator at the top and a sticky right-rail mission navigator. At the desktop breakpoint (>960px) the right rail tracks the user. At mobile (≤960px) the right rail unstacks and falls below the long step content — so a user reading step 5 of 7 has no quick way to see "where am I" or jump to another step without scrolling many viewport-heights up to the wizard. There's also no compact mobile control surface for "previous / next / mark done" — those are buried inline near each step.

A bottom sheet is the platform-idiomatic mobile pattern for "important controls within thumb reach." UI5 v2.x doesn't ship a dedicated bottom-sheet primitive, but `<ui5-dialog>` with viewport-bottom positioning + `stretch` attribute is the established workaround (validated in U15 lightbox).

## Scope

**In scope:**
- A floating "Steps" button visible only at `@media (max-width: 960px)`, lower-right, fixed position
- Tap → opens a bottom sheet implemented as a positioned `<ui5-dialog>`
- Sheet content (top to bottom):
  1. Header: "Step <current> of <total>" + close icon
  2. Step list (`<ui5-list>`): one row per tutorial step; current step has `selected`; completed steps show `icon="accept"`; tap → smooth-scroll to that step's anchor and close the sheet
  3. Footer controls: three `<ui5-button>` — Previous, Mark Done, Next
- `<ui5-busy-indicator>` overlays the list briefly (~400ms) during the post-tap smooth-scroll so the action gives visible feedback before the sheet animates closed
- Close on: tap a step row, tap outside (UI5 default), tap close icon, press Escape
- Hidden entirely (CSS `display: none`) above 960px — desktop is untouched

**Out of scope:**
- Persistent open state across page navigations (sheet always opens closed)
- Swipe-to-dismiss / drag-handle interactions (UI5 ships no swipe primitive; not worth a custom port)
- Showing this sheet on the legacy `single.html` layout (only `u1-object-page.html` is the active layout per Hugo cascade)
- Any change to the desktop wizard, mission side-nav, or right-rail behavior
- Backend changes — `completeStep` action already exists and is what "Mark Done" calls
- New CDS endpoints
- Schema migrations

## Architecture

### Surface

`hugo/layouts/tutorials/u1-object-page.html` (the only tutorial layout). The bottom sheet markup, the FAB, and the wiring script are all rendered statically into this layout. No Vue island; this is parallel to U16's static-render approach.

### DOM layout

```
[ existing op-page content … ]

<!-- New, mobile-only --> 
<ui5-button id="op-mobile-fab" ...>Steps</ui5-button>
<ui5-dialog id="op-mobile-sheet" ...>
  <header>Step X of Y · close</header>
  <ui5-busy-indicator id="op-mobile-busy" delay="0">
    <ui5-list id="op-mobile-step-list" mode="None">
      <ui5-li selected icon="accept">Step 1 — title</ui5-li>
      …
    </ui5-list>
  </ui5-busy-indicator>
  <footer>Previous · Mark Done · Next</footer>
</ui5-dialog>
```

### CSS

Scoped styles in a `<style>` block within `u1-object-page.html` so it cannot leak (matches U1/U2 pilot precedent).

Critical rules:
- `#op-mobile-fab { position: fixed; right: 1rem; bottom: 1rem; z-index: 40; display: none; }`
- `@media (max-width: 960px) { #op-mobile-fab { display: inline-flex; } }`
- `#op-mobile-sheet { /* positioned at viewport bottom */ }`
  - Use `::part(content)` and `::part(header)` to cap height at ~70vh
  - Set the dialog's wrapper to align to viewport bottom

The breakpoint matches the existing `@media (max-width: 960px)` rule for `.op-twocol` so behavior is consistent (FAB appears exactly when the right rail unstacks).

### UI5 v2.x API contract (verified)

- `<ui5-dialog>` v2.x uses the **`open` property** (not `.show()` / `.close()`). Set `open=""` to open, remove the attribute to close. (Saved memory `[[ui5-dialog-open-property]]`.)
- `<ui5-busy-indicator>` v2.x uses the **`active`** boolean property; wraps content in default slot.
- `<ui5-list>` v2.x uses `<ui5-li>` rows with `selected` and `icon` attributes.

### Wiring (vanilla JS, inline in the layout)

A small inline `<script type="module">` block parallel to the existing U1/U2 wizard wiring. Pseudocode:

```js
const fab = document.getElementById('op-mobile-fab');
const sheet = document.getElementById('op-mobile-sheet');
const list = document.getElementById('op-mobile-step-list');
const busy = document.getElementById('op-mobile-busy');

fab.addEventListener('click', () => {
  syncListFromDom();    // mirror .tutorial-step.completed onto the rows
  sheet.setAttribute('open', '');
});

list.addEventListener('item-click', (e) => {
  const targetId = e.detail.item?.dataset?.stepTarget;
  if (!targetId) return;
  busy.active = true;
  document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => {
    busy.active = false;
    sheet.removeAttribute('open');
  }, 400);
});

// Prev/Next/Mark-Done buttons hook into the existing tutorial.ts globals
// (same that the per-step inline buttons use). No new backend calls.
```

The current step pointer is computed on sheet-open by reading the same scrollspy state the U2 wizard observes (`.tutorial-step.completed` count + viewport intersection).

### Data flow

- **Step list rendered server-side** at Hugo build time using the existing `.Params.steps` array (same source the wizard uses).
- **Completion state** read from `.tutorial-step.completed` DOM mutations (same source the wizard uses).
- **Mark Done** invokes `window.completeStep(slug, stepNumber)` (existing global on `tutorial.ts`).

No new endpoints. No new client state.

### Accessibility

- `<ui5-button>` FAB has `accessible-name="Open step list"`
- `<ui5-dialog>` has `accessible-name="Tutorial step navigator"`
- Escape closes the sheet (UI5 default for `<ui5-dialog>`)
- Focus trap is UI5 default for `<ui5-dialog>`
- Tab order on open: header close → step list → footer controls

## Testing

**Manual browser verification (required before PR):**
- [ ] At >960px: FAB and sheet are absent from layout (no DOM impact, or `display: none` only — confirm via inspector)
- [ ] At ≤960px: FAB visible, lower-right, doesn't overlap any sticky content
- [ ] Tap FAB → sheet slides up from bottom; first focusable element receives focus
- [ ] Step list shows correct step count, current step highlighted, completed steps show check icon
- [ ] Tap a step row → busy indicator briefly visible, page scrolls to that step, sheet closes
- [ ] Tap Previous / Next → page scrolls accordingly, sheet closes (or stays open — see open question)
- [ ] Tap Mark Done → step marked complete, completion icon updates if you reopen, sheet closes
- [ ] Tap outside sheet → closes
- [ ] Press Escape → closes
- [ ] Light + Dark themes both render
- [ ] iOS Safari, Android Chrome, desktop Chrome at 600px width — visual check on each
- [ ] No regression on desktop wizard, no regression on existing right-rail mission side-nav (U16)
- [ ] `npm test` shows no NEW failures vs main baseline

**Automated tests:** None. Static-render + UI5 components + existing globals; same test posture as U16.

## Risks

- **`<ui5-dialog>` as a bottom sheet** is the most fragile assumption. UI5 dialogs are designed as centered modals. CSS overrides to anchor at viewport bottom across iOS Safari, Android Chrome, and desktop Chrome must be verified. **Fallback:** if positioning conflicts with shadow-DOM internals, switch to a bare `<div role="dialog">` with hand-rolled focus management (still using `<ui5-list>` and `<ui5-button>` inside).
- **Z-index stacking:** the FAB must sit above any sticky page elements but below modals (e.g., feedback popup). Audit at implementation time.
- **`item-click` event shape:** UI5 v2.x list events expose `event.detail.item` — verify in MCP at plan-time before code.
- **Mark Done ordering:** the existing global expects to be called from the per-step button context. Confirm it works when called from a sheet button outside the step's DOM subtree.

## Open questions to resolve in the implementation plan

- **Q1: After Prev/Next, does the sheet stay open or close?** Default proposal: stay open so the user can navigate multiple steps quickly. Alternative: close, matching the row-click behavior. Will choose at plan-time after a quick UX sanity check.
- **Q2: FAB icon vs label?** Default: text "Steps" + icon, since pure icon is ambiguous. Will lock at plan-time.

## File touch list (preview — final list locked in plan)

- **Modify:** `hugo/layouts/tutorials/u1-object-page.html` — add FAB markup, sheet markup, scoped CSS, inline wiring script

No new files. No CSS pipeline changes (scoped `<style>` only). No JS bundle changes (inline module script). No backend changes.

## Out-of-scope follow-ups (do NOT do in U18)

- Bottom sheet for the mission/group side-nav (U16) on mobile — separate problem
- Persisting "last opened" sheet state
- A swipe-up gesture to open
- A draggable resize handle to convert the sheet to a "peek" mode
