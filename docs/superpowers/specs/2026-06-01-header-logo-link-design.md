# Header logo → home (navigator) link

**Issue:** [sap-tutorials/tutorials-ims#160](https://github.com/sap-tutorials/tutorials-ims/issues/160)
**Date:** 2026-06-01
**Author:** Thomas Jung (via brainstorming session)

## Problem

The "SAP" logo plus the "Tutorial Platform" wordmark in the top-left of the global header are not currently clickable. Convention across SAP properties is that the logo navigates to the site root. Daniel Wroblewski raised this as a usability gap on 2026-06-01.

## Acceptance criteria (from issue)

- Clicking the logo (or its associated wordmark) navigates to the site root `/` — which on this site is the tutorial navigator.
- The logo region exposes a meaningful `aria-label` ("SAP Tutorial Platform — home") and is announced by screen readers as a link.

## In scope

- Single Hugo partial: [hugo/layouts/partials/header.html](../../../hugo/layouts/partials/header.html). Used by every Hugo page in both prod and QA channels.

### QA-channel reuse confirmation

The QA channel ships static-frontend assets via `static-qa/` ([memory: qa-gate-frontend-script-tags](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_qa_gate_frontend_script_tags.md)). However, `hugo/layouts/partials/header.html` is a Hugo *template* — both the prod and QA Hugo builds render it from the same source file, parameterized by `site.Params.qa`. The change in this spec lives entirely inside the QA-flagged-or-shared regions of the partial (the IIFE itself is shared). Implementation MUST verify before completion that the change does not require any sibling JS to be copied into `static-qa/` (none should — the change is entirely inside `header.html`'s inline script).

## Out of scope (YAGNI)

- No new keyboard shortcut. UI5 ShellBar already activates the logo on Enter/Space when its role is `link`.
- No additional "home" affordances elsewhere (object page crumb, footer, mobile sheet).
- No analytics instrumentation (matches the rest of the shellbar items).
- No QA-channel divergence — logo behaves identically in prod and QA.
- No styling changes. The hover/focus ring already shipped by `ui5-shellbar` for an interactive logo is sufficient.

## Design

### Why not a literal `<a href="/">` wrapper

The issue's acceptance text suggests `<a href="/">`, but the header is a `ui5-shellbar` (UI5 web component v2). The logo is a slotted `<img slot="logo">` inside a shadow-DOM-driven layout, and the wordmark is rendered by the component from the `primary-title` attribute — there is no place in the markup to wrap them in a single anchor. Wrapping the `<img>` alone would also miss the wordmark click region and is fragile against UI5 upgrades.

UI5 ShellBar exposes the documented API for exactly this case:

- A bubbling `logo-click` event fired when the user activates the logo region (mouse, touch, Enter, Space).
- An `accessibilityAttributes.logo` object with `role: "link"` and `name: "..."` so the region announces as a link with a custom accessible name.

We use that API. The visible behavior matches `<a href="/">`; the implementation matches the component's contract.

### Markup change

[hugo/layouts/partials/header.html:1](../../../hugo/layouts/partials/header.html#L1)

The `ui5-shellbar` element gains no new attributes in the template — `accessibility-attributes` is set as a DOM property in JS so we don't have to inline a JSON literal in HTML (cleaner, no escaping, easier to maintain).

The `<img slot="logo">` keeps its existing `alt="SAP"` (the brand mark itself, not the link affordance).

### JS change

In the existing IIFE inside `header.html` (around line 75-326), add two things:

1. **Set `accessibilityAttributes` once on shellbar startup**, alongside the existing `customElements.whenDefined('ui5-shellbar').then(checkAuth)` registration:

   ```js
   shellbar.accessibilityAttributes = {
     logo: { role: 'link', name: 'SAP Tutorial Platform — home' }
   };
   ```

   Setting it once at script execution time is sufficient — the property is read by UI5 on each render. We do not need to re-apply it later.

   **Implementation note:** the property name inside `accessibilityAttributes.logo` is `name` (not `accessibleName`) — confirmed against the UI5 ShellBar v2 API in this session. Implementer should re-confirm via the UI5 MCP at edit time, since UI5 occasionally renames sub-properties between minor versions.

2. **Listen for the logo-click event** on the shellbar. Register both the prefixed and unprefixed event names — UI5 v2 emits `ui5-logo-click` officially, but the unprefixed `logo-click` is also documented in older release notes and a one-line dual registration costs nothing while protecting against any version skew between the bootstrap and the runtime:

   ```js
   const goHome = () => { window.location.href = '/'; };
   shellbar.addEventListener('ui5-logo-click', goHome);
   shellbar.addEventListener('logo-click', goHome);
   ```

   We use `window.location.href = '/'` rather than History API navigation. The site is Hugo-rendered, multi-page, with View Transitions handling the morph; full navigation is the established pattern (see existing nav-popover handler at line 144-152).

### Behavior on the navigator page itself

If the user is already at `/` and clicks the logo, the browser performs a full navigation back to `/`. This matches every SAP property and avoids a special "you're already home" branch. Tom confirmed this behavior in the brainstorm.

### Theme / View Transitions interactions

- Theme toggle (`__morphTheme`) wraps DOM changes; navigation away from the page is unaffected.
- The site already opts into cross-document View Transitions for card→detail morphs ([memory: view-transitions-shipped](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_view_transitions_shipped.md)). Navigating from a tutorial detail or a navigator card to the navigator root via the logo will use whatever transition browsers default to (typically the navigator's own VT) — no extra wiring needed.

## Testing

### Unit / hybrid

No backend changes — no unit or hybrid tests added.

### Smoke

Existing smoke test [test/smoke/static-content.test.js](../../../test/smoke/static-content.test.js) loads `/` and pages that embed `header.html`. We extend it with two assertions over the rendered HTML for `/` (the navigator):

- Response matches the regex `/logo:\s*\{\s*role:\s*['"]link['"]/` — confirms the JS hook is shipped *and* it is wiring the **logo** slot specifically (not some other slot's accessibility attributes). Whitespace-tolerant so it survives any future JS minifier pass over the inline script.
- Response contains the literal string `SAP Tutorial Platform — home` — confirming the aria name is in the bundle.

Both checks are string-presence over the served HTML. They survive Hugo's HTML minifier ([memory: hugo-minifier-strips-quotes](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_hugo_minifier_strips_quotes.md)) because we look for substrings inside the inline `<script>` block, which is preserved verbatim.

### Manual verification

1. `npm run dev` → load `/` → click logo → page reloads to `/`. ✅
2. Load any tutorial detail page → click logo → navigates to `/`. ✅
3. Load `/me` → click logo → navigates to `/`. ✅
4. Tab to the logo region → screen reader announces "SAP Tutorial Platform — home, link". ✅ (verify with VoiceOver / NVDA if available; otherwise inspect AOM tree in DevTools).
5. Press Enter on focused logo → navigates to `/`. ✅
6. QA channel: `npm run dev:qa` (or deploy QA preview) → same behavior on `/tutorials-qa/`. ✅

## Risks

- **Low.** Single partial, single IIFE scope, two small additions. No data-flow or schema changes. No new dependencies.
- The `ui5-` event prefix could differ across UI5 versions; mitigated by registering both `logo-click` and `ui5-logo-click` (see JS change above).

## Files touched

- [hugo/layouts/partials/header.html](../../../hugo/layouts/partials/header.html) — only file with code changes.
- [test/smoke/static-content.test.js](../../../test/smoke/static-content.test.js) — extend existing test (additive only).

## Related memory

- [[ui5-dialog-open-property]] — reminder that UI5 v2 changed APIs; verified `logo-click` + `accessibilityAttributes` against the UI5 MCP this session.
- [[verify-branch-before-commit]] — branch `fix/header-logo-link-160` created up-front.
- [[pr-over-direct-merge]] — merge via PR, not direct push.
