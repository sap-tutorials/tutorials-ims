# Header Logo → Home Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SAP / "Tutorial Platform" logo region in the global header navigate to the site root `/` (tutorial navigator) and announce as a link to assistive tech, addressing [sap-tutorials/tutorials-ims#160](https://github.com/sap-tutorials/tutorials-ims/issues/160).

**Architecture:** Single-partial change to [hugo/layouts/partials/header.html](../../../hugo/layouts/partials/header.html). The header is a `ui5-shellbar` (UI5 Web Components v2) — the logo is a slotted `<img>` and the wordmark comes from `primary-title`. Rather than literal `<a href="/">` wrapping (impossible across the slot/title split), we use the documented UI5 ShellBar API: set `accessibilityAttributes.logo = { role: 'link', name: '…' }` as a DOM property and listen for the `logo-click` event (registering both `logo-click` and `ui5-logo-click` for version-skew safety). One additional smoke assertion confirms the wiring shipped.

**Tech Stack:** Hugo template (Go), inline JS (no bundler), UI5 Web Components v2 (`ui5-shellbar`), Vitest smoke tests.

**Spec:** [docs/superpowers/specs/2026-06-01-header-logo-link-design.md](../specs/2026-06-01-header-logo-link-design.md)

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| [hugo/layouts/partials/header.html](../../../hugo/layouts/partials/header.html) | Modify | Add `accessibilityAttributes.logo` DOM property and `logo-click` listeners inside the existing IIFE. |
| [test/smoke/static-content.test.js](../../../test/smoke/static-content.test.js) | Modify | Add one new `it()` that fetches `/` and asserts the header script contains the logo wiring. |

No new files. No new dependencies. No schema, CDS, or backend changes.

---

## Task 1: API verification and prep

**Files:**
- Modify: none yet (preflight)

- [ ] **Step 1: Re-confirm the UI5 ShellBar v2 API for the logo accessibility surface**

Use the UI5 Web Components MCP to verify, exactly:
- Property name on `accessibilityAttributes.logo` is `name` (not `accessibleName`).
- The `role: 'link'` value is supported.
- The component fires `ui5-logo-click` (or `logo-click`) when the logo region is activated.

Run:

```
mcp__ui5-webcomponents__get_component_api componentName=ui5-shellbar
```

Expected: response includes `accessibilityAttributes.logo` with `role` (string: `button | link`) and `name` (string), plus a `logo-click` event entry.

If any of those three points has changed in this UI5 version, STOP and surface to the human — the spec assumes today's API.

- [ ] **Step 2: Confirm the working branch**

Run:

```bash
git branch --show-current
```

Expected output: `fix/header-logo-link-160`. If it shows `main`, STOP and switch to the feature branch before any edit ([[verify-branch-before-commit]]).

- [ ] **Step 3: Inspect the current header partial to lock in the insertion points**

Read [hugo/layouts/partials/header.html](../../../hugo/layouts/partials/header.html). Confirm:
- The `ui5-shellbar` opening tag is on line 1, no `accessibility-attributes` attribute today.
- The IIFE starts around line 75 with `const shellbar = document.getElementById('app-shellbar');`.
- The `customElements.whenDefined('ui5-shellbar').then(checkAuth);` line near the end of the IIFE (~line 321) is the natural neighbour for our DOM-property assignment.

If line numbers have drifted significantly (>10 lines), update them in the steps below before editing.

---

## Task 2: Add a failing smoke test for the logo wiring

**Files:**
- Modify: [test/smoke/static-content.test.js](../../../test/smoke/static-content.test.js)

- [ ] **Step 1: Add the failing test**

Append a new `it()` inside the existing `describe('Static content', ...)` block in [test/smoke/static-content.test.js](../../../test/smoke/static-content.test.js):

```js
  it('GET / wires the header logo as a link to home', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/`);
    if (res.status === 302) return; // login redirect — acceptable, like the sibling test
    expect(res.status).toBe(200);
    const html = await res.text();
    // Whitespace-tolerant: survives any future JS minifier pass over inline <script>.
    expect(html).toMatch(/logo:\s*\{\s*role:\s*['"]link['"]/);
    expect(html).toContain('SAP Tutorial Platform — home');
  });
```

The em-dash in the aria-name is the same character (U+2014) used elsewhere on the site. Type it literally — both Hugo and the smoke runner are UTF-8 end to end.

- [ ] **Step 2: Run the test to confirm it fails**

Run (against any environment that serves `/`; the deployed DEV approuter is fine):

```bash
SMOKE_BASE_URL=https://tutorial-system-dev-approuter.cfapps.eu10-005.hana.ondemand.com \
SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
npm run test:smoke -- test/smoke/static-content.test.js
```

Expected: the new test FAILS with a `toMatch`/`toContain` assertion error — the wiring is not in the deployed HTML yet. The two pre-existing tests still PASS.

If `npm run test:smoke` hangs in this worktree ([[feedback-worktree-tests-hang]]), cap with a hard timeout — `timeout 60 npm run test:smoke -- test/smoke/static-content.test.js`. If it still hangs, surface to Tom rather than guessing.

- [ ] **Step 3: Commit the failing test**

```bash
git add test/smoke/static-content.test.js
git commit -m "test(smoke): expect header logo to be wired as link to home (#160)"
```

---

## Task 3: Wire the logo to navigate home, with a11y

**Files:**
- Modify: [hugo/layouts/partials/header.html](../../../hugo/layouts/partials/header.html)

- [ ] **Step 1: Add the `accessibilityAttributes` assignment**

Inside the IIFE in [hugo/layouts/partials/header.html](../../../hugo/layouts/partials/header.html), immediately after the `let isAuthenticated = false;` line (currently ~line 89) and before the `function closeAllExcept(skip)` declaration, insert:

```js
  // Issue #160: announce the logo region as a link to home and route clicks
  // there. UI5 ShellBar v2 documents both `accessibilityAttributes.logo` and
  // the `logo-click` event for exactly this case — markup wrapping is not an
  // option because the logo is a slotted child and the wordmark comes from
  // primary-title. Register both event-name spellings (prefixed/unprefixed)
  // for version-skew safety across UI5 minor releases.
  shellbar.accessibilityAttributes = {
    logo: { role: 'link', name: 'SAP Tutorial Platform — home' }
  };
  const goHome = () => { window.location.href = '/'; };
  shellbar.addEventListener('ui5-logo-click', goHome);
  shellbar.addEventListener('logo-click', goHome);
```

Rationale for placement (just after `isAuthenticated`):
- Same lexical scope as the rest of the shellbar wiring — no new closures.
- Runs before `customElements.whenDefined('ui5-shellbar').then(checkAuth)` — the property assignment is a no-op if the custom element is not yet upgraded; UI5 reads it on the next render after upgrade.

- [ ] **Step 2: Confirm the partial still parses (Hugo dev server)**

Run:

```bash
npm run dev
```

Expected: Hugo starts on http://localhost:1313 with no template-parse errors. Navigate to `/`. Open DevTools console — no JS errors from `header.html`. Click the logo or the "Tutorial Platform" wordmark — the page reloads at `/`.

Tab to the logo region and inspect the AOM tree (DevTools → Accessibility tab) — the logo is announced as a `link` named `SAP Tutorial Platform — home`.

If `npm run dev` errors on missing tutorial cache, run `npm run fetch-tutorials` first.

- [ ] **Step 3: Manual verification across page kinds**

While `npm run dev` is up, visit each of:
- `/` — navigator (clicking logo reloads `/`)
- A tutorial detail page (e.g. `/tutorials/<any-slug>/`)
- `/me/` (sign in if needed; otherwise `/login` redirect is fine)
- `/app-space/`

In every case: clicking the SAP logo or the "Tutorial Platform" wordmark navigates to `/`. Pressing Enter while the logo region has keyboard focus does the same.

- [ ] **Step 4: QA-channel reuse verification**

Confirm the change does not require a sibling JS file in `static-qa/` (per the spec's QA-channel reuse subsection). Quick check:

```bash
fd '\.js$' static-qa/ 2>/dev/null | head
```

Our edit is entirely inside `hugo/layouts/partials/header.html`'s inline `<script>` — no separate JS module. Therefore no `static-qa/` duplication is needed. Note this in the PR description so reviewers don't have to re-derive it.

- [ ] **Step 5: Commit the implementation**

```bash
git add hugo/layouts/partials/header.html
git commit -m "fix(header): wire SAP logo as link to home with a11y (#160)

The logo region in ui5-shellbar now announces as a link named
'SAP Tutorial Platform — home' and navigates to / on activation
(mouse, touch, Enter, Space). Uses the documented UI5 v2 API
(accessibilityAttributes.logo + logo-click) rather than literal
<a href=\"/\"> wrapping, because the logo is a slotted child and
the wordmark comes from primary-title — there is no place in the
markup to wrap them in a single anchor. Both 'logo-click' and
'ui5-logo-click' are registered for version-skew safety.

Closes #160"
```

---

## Task 4: Re-run the smoke test against a build that includes the change

**Files:**
- None (verification only)

- [ ] **Step 1: Decide where to run the test**

Option A — local Hugo build:

```bash
npm run build:all
# Serve hugo/public/ via any static server, e.g.:
npx http-server hugo/public -p 1313 &
SMOKE_BASE_URL=http://localhost:1313 \
SMOKE_SRV_URL=http://localhost:4004 \
npm run test:smoke -- test/smoke/static-content.test.js
```

Option B (faster post-deploy) — wait until DEV deploy lands, then run against DEV. CI runs smoke automatically after deploy ([[project_local_deploy_process]]).

Pick whichever is closer to hand. Option A is enough to prove the wiring shipped; Option B confirms it survives the full pipeline.

- [ ] **Step 2: Run smoke**

Run the same command from Task 2 Step 2 (or the local-server variant from Option A).

Expected: ALL three tests in `static-content.test.js` PASS.

If the new test still fails, inspect `curl -s http://localhost:1313/` and confirm the `<script>` block contains both `logo: { role: 'link'` and `SAP Tutorial Platform — home`. Most likely cause if it's missing: Hugo did not rebuild — clear `hugo/public/` and re-run `npm run build:all`.

- [ ] **Step 3: No commit**

This step is verification-only; nothing to add.

---

## Task 5: Push branch and open PR

**Files:**
- None (git/PR plumbing)

- [ ] **Step 1: Final branch sanity check**

```bash
git branch --show-current
git log --oneline main..HEAD
```

Expected:
- Branch: `fix/header-logo-link-160`
- Three commits on top of main: spec + spec-revisions + feature commit (the test commit and the implementation commit).

If you see only one commit because `git commit --amend` was used somewhere, that's fine — the spec commits are already on the branch from earlier.

- [ ] **Step 2: Push**

```bash
git push -u origin fix/header-logo-link-160
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create \
  --base main \
  --title "fix(header): wire SAP logo as link to home (#160)" \
  --body "$(cat <<'BODY'
Closes #160.

## Summary

The "SAP" logo + "Tutorial Platform" wordmark in the global header are now activated as a single link to the site root `/` (tutorial navigator), with a11y `role=link` and accessible name `SAP Tutorial Platform — home`.

## Why event + accessibilityAttributes, not `<a href="/">`

The header is a `ui5-shellbar`. The logo is a slotted `<img>` and the wordmark is rendered by the component from `primary-title` — there is no place in the markup to wrap them in a single anchor. UI5 ShellBar v2 documents `accessibilityAttributes.logo = { role, name }` and the `logo-click` event for exactly this case. We register both `logo-click` and `ui5-logo-click` for version-skew safety.

## Verification

- Manual on `/`, tutorial detail, `/me/`, `/app-space/`: clicking SAP logo or "Tutorial Platform" wordmark navigates to `/`. Enter on focused logo does the same.
- DevTools AOM tree: logo region announces as a link named "SAP Tutorial Platform — home".
- New smoke test asserts the wiring is in the served HTML for `/`.
- QA channel: no `static-qa/` JS duplication needed — the change lives entirely inside `header.html`'s inline `<script>`.

## Spec

[docs/superpowers/specs/2026-06-01-header-logo-link-design.md](docs/superpowers/specs/2026-06-01-header-logo-link-design.md)
BODY
)"
```

- [ ] **Step 4: Confirm scope with Tom**

Reply in the PR thread with: *"Backend-only? +content? +QA? Confirming deploy scope before kicking off"* ([[feedback-confirm-deploy-scope]]). Wait for Tom's reply before any deploy steps. Implementation is done at this point — deploy is a separate decision.

---

## Out of plan (for the reviewer's sanity)

- No keyboard-shortcut additions (UI5 already gives the logo Enter/Space activation when its role is `link`).
- No CSS changes — UI5 ships hover/focus styling for an interactive logo.
- No analytics, no schema changes, no new docs site entry.
- No View Transitions wiring beyond what's already shipped — full-page navigation is the established pattern.
