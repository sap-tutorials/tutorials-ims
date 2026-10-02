# IAS Social Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a themed two-button sign-in page that lets a developer log in via SAP ID Service *or* SAP Universal ID (IAS, with social providers) without ever seeing XSUAA's IdP chooser, while the existing default login keeps working unchanged.

**Architecture:** The subaccount already trusts two OIDC IdPs (`sap.default` = SAP ID Service, `sap.custom` = IAS tenant `atxgsg7zi` with social enabled) and XSUAA re-issues its own token for both, so the main srv/approuter bindings and the `(iss,sub)` identity-merge layer (#2552, in PROD) need **no change**. The only work: (1) enable the approuter `dynamicIdentityProvider` gate so the `sap_idp` query param is honored, and (2) add a Hugo-sourced `/signin` page whose two buttons link to `/login?sap_idp=sap.default` and `/login?sap_idp=sap.custom`, pinning the IdP so XSUAA jumps straight through.

**Tech Stack:** `@sap/approuter` v16.9.0 (xs-app.json routes, `sap_idp` / `dynamicIdentityProvider`), Hugo static layouts (Fundamental Styles / Horizon theme), SAP BTP XSUAA + IAS trust.

**Spec:** `docs/superpowers/specs/2026-10-02-ias-social-login-design.md`

## Global Constraints

- `sap_idp` is honored ONLY when `dynamicIdentityProvider` is true for the route (or globally); otherwise silently ignored (`@sap/approuter` `path-rewriter.js:136`). Decision: **per-route** on the `/login` route only.
- IdP origin keys are the LIVE values: `sap.default` (SAP ID Service), `sap.custom` (IAS `atxgsg7zi`). The origin key `sap.custom` is stable across any IAS tenant swap unless the trust is re-created.
- The sign-in page is authored as a **Hugo layout** under `hugo/layouts/`; `approuter/static/*.html` are BUILD ARTIFACTS (`mta.yaml:98` `cp -r hugo/public/. approuter/static/`) — never hand-edit them.
- Button copy: default = "Sign in with SAP"; IAS = "Sign in with SAP Universal ID". Do NOT name a social provider ("Sign in with Google") — social buttons live inside IAS.
- Theming is inherited free from `hugo/layouts/_default/baseof.html` + `partials/head.html` (CSS link chain, light/dark via localStorage `theme` key + pre-paint script). Use `fd-*` classes + `var(--sap*)` tokens for page-specific style.
- Switching IdPs requires logout first (`@sap/approuter` README:932) — the signed-in account menu must route IdP-switch through `/logout`.
- Admin/approuter static changes need a FULL deploy (no `--skip-build`, no `-m` scoping); Step 3.5 bundle check applies. Deploy from fresh `origin/DEV`; `cf target` before any push; PRs target DEV.
- No raw SQL, no `@sap/` non-public deps, no credential literals (not expected to arise here, but the repo rules stand).

---

## File Structure

- `hugo/layouts/signin.html` (**create**) — the themed two-button sign-in page body (`{{ define "main" }}` block), cloned from `hugo/layouts/403.html`. Produces `hugo/public/signin/index.html` → copied into `approuter/static/signin/index.html` at build.
- `hugo/content/signin.md` (**create**) — the content stub that makes Hugo render `signin.html` at `/signin/` (front matter sets `layout: signin`, excludes from nav/sitemap).
- `approuter/xs-app.json` (**modify**) — add a public `/signin` route serving the built page; add `"dynamicIdentityProvider": true` to the existing `/login` route (`:116-121`).
- `docs/developers/architecture/authentication.md` (**modify**) — document the two-button sign-in + `sap_idp` pinning (currently describes XSUAA-only).
- `test/e2e/signin.spec.ts` (**create**) — post-deploy Playwright smoke: `/signin` renders both buttons with the correct `sap_idp` hrefs; self-skips without `SMOKE_BASE_URL`.

No backend/CAP/db changes. No MTA resource changes.

---

### Task 1: Enable `dynamicIdentityProvider` on the `/login` route

**Files:**
- Modify: `approuter/xs-app.json:116-121`

**Interfaces:**
- Consumes: nothing.
- Produces: the `/login` route now honors `?sap_idp=<originKey>` → emits XSUAA `login_hint={"origin":"<originKey>"}`. Tasks 2–3 link to `/login?sap_idp=...`.

- [ ] **Step 1: Add the gate flag to the `/login` route**

In `approuter/xs-app.json`, change the `/login` route block (currently):
```json
{
  "source": "^/login(\\?.*)?$",
  "authenticationType": "xsuaa",
  "target": "/login-redirect.html",
  "localDir": "static"
}
```
to:
```json
{
  "source": "^/login(\\?.*)?$",
  "authenticationType": "xsuaa",
  "dynamicIdentityProvider": true,
  "target": "/login-redirect.html",
  "localDir": "static"
}
```

- [ ] **Step 2: Validate the JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('approuter/xs-app.json','utf8')); console.log('ok')"`
Expected: prints `ok` (no parse error).

- [ ] **Step 3: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat(auth): honor sap_idp on /login route via dynamicIdentityProvider (#2506)"
```

---

### Task 2: Create the Hugo sign-in layout (two themed buttons)

**Files:**
- Create: `hugo/layouts/signin.html`
- Reference: `hugo/layouts/403.html` (clone source)

**Interfaces:**
- Consumes: Task 1's `sap_idp`-aware `/login` route.
- Produces: a `main` block rendering two anchors — primary `href="/login?sap_idp=sap.default"`, secondary `href="/login?sap_idp=sap.custom"`. Task 3 wires the content stub that selects this layout; Task 5 asserts these hrefs.

- [ ] **Step 1: Write the layout**

Create `hugo/layouts/signin.html`:
```html
{{ define "main" }}
<section class="signin-hero" aria-labelledby="signin-title">
  <div class="signin-inner">
    <ui5-illustrated-message name="tnt/Login" design="Spot" class="signin-illus">
      <h1 slot="title" id="signin-title" class="signin-title">Sign in to SAP Developers</h1>
      <p slot="subtitle" class="signin-lede">
        Choose how you'd like to sign in. Your progress and completions are the
        same account whichever you pick.
      </p>
    </ui5-illustrated-message>
    <div class="signin-actions">
      <a class="fd-button fd-button--emphasized signin-btn" href="/login?sap_idp=sap.default">
        Sign in with SAP
      </a>
      <a class="fd-button fd-button--transparent signin-btn" href="/login?sap_idp=sap.custom">
        Sign in with SAP Universal ID
      </a>
    </div>
  </div>
</section>

<style>
  .signin-hero {
    padding: 4rem 1.5rem;
    background: var(--sapBackgroundColor, #f5f6f7);
    min-height: 60vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .signin-inner {
    max-width: 640px;
    text-align: center;
    background: var(--sapTile_Background, #ffffff);
    padding: 3rem 2rem;
    border-radius: 0.75rem;
    box-shadow: 0 0.125rem 0.5rem rgba(0, 0, 0, 0.08);
  }
  .signin-illus { display: block; margin: 0 auto 1.25rem; max-width: 100%; }
  .signin-title { font-size: 1.625rem; margin: 0 0 0.5rem; color: var(--sapTextColor, #32363a); }
  .signin-lede {
    font-size: 1rem;
    color: var(--sapContent_LabelColor, var(--sapTextColor, #32363a));
    margin: 0 0 1.5rem;
  }
  .signin-actions {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    align-items: center;
  }
  .signin-btn { min-width: 16rem; justify-content: center; }
</style>
{{- /* ui5Split: illustration assets for <ui5-illustrated-message>, mirrors 403.html (#1777 Task 7) */}}
{{ if and (not site.Params.previewMode) site.Params.ui5Split }}<script type="module" src="{{ partial "island-src.html" "ui5-illustrations" }}"></script>{{ end }}
{{ end }}
```

Note: `tnt/Login` is the login illustration name; if the project's ui5-illustrations bundle doesn't register it, fall back to `tnt/Unlock` or `tnt/Success`. Verify the bundle in Step 2.

- [ ] **Step 2: Verify the illustration name is available**

Run: `grep -rn "tnt/Login\|tnt/Unlock\|tnt/Success\|tnt/Lock" hugo/ --include=*.html --include=*.js | head`
Expected: at least one existing reference to a `tnt/*` illustration (confirms the bundle pattern). If `tnt/Login` isn't referenced anywhere and the ui5-illustrations loader uses an explicit allowlist, switch the `name=` to one that is already used (e.g. `tnt/Lock` as in 403.html). Edit the layout accordingly.

- [ ] **Step 3: Commit**

```bash
git add hugo/layouts/signin.html
git commit -m "feat(auth): themed two-button sign-in Hugo layout (#2506)"
```

---

### Task 3: Add the content stub so Hugo renders `/signin/`

**Files:**
- Create: `hugo/content/signin.md`
- Reference: an existing standalone content page's front matter (e.g. look for a `hugo/content/*.md` that sets a custom `layout` and excludes nav)

**Interfaces:**
- Consumes: Task 2's `signin.html` layout.
- Produces: a page served at `/signin/` using the `signin` layout, excluded from nav/sitemap/search. Task 4 routes the approuter to it; Task 5 fetches it.

- [ ] **Step 1: Find the project's convention for a layout-pinned, nav-excluded page**

Run: `grep -rln "^layout:" hugo/content | head; echo '---'; grep -rln "sitemap:\|_build:\|robots" hugo/content | head`
Expected: shows how existing pages pin a layout and opt out of listing. Mirror whichever convention exists (front-matter `layout:`, `_build:` exclusions, `sitemap: { disable: true }`, or a `headless`/`robots` param). If no example exists, use the Hugo-standard `_build` block below.

- [ ] **Step 2: Write the content stub**

Create `hugo/content/signin.md` (adjust keys to match the convention found in Step 1):
```markdown
---
title: "Sign in"
layout: signin
_build:
  list: never
sitemap:
  disable: true
robots: "noindex, nofollow"
---
```

- [ ] **Step 3: Build Hugo and confirm the page renders**

Run (from repo root; fetch cache must exist — if not, `npm run fetch-tutorials` first):
`npm run build:hugo && test -f hugo/public/signin/index.html && echo RENDERED`
Expected: prints `RENDERED`. (Wrap in `scripts/quiet-run.sh` if the Hugo output is noisy.)

- [ ] **Step 4: Confirm both pinned hrefs are present in the built HTML**

Run: `grep -o 'sap_idp=sap\.[a-z]*' hugo/public/signin/index.html | sort -u`
Expected: two lines — `sap_idp=sap.custom` and `sap_idp=sap.default`.

- [ ] **Step 5: Commit**

```bash
git add hugo/content/signin.md
git commit -m "feat(auth): render /signin page from signin layout (#2506)"
```

---

### Task 4: Serve `/signin` from the approuter (public route)

**Files:**
- Modify: `approuter/xs-app.json` (routes array — add BEFORE the catch-all / static fallthrough so it is matched)

**Interfaces:**
- Consumes: Task 3's built `approuter/static/signin/index.html` (present after the `mta.yaml:98` copy).
- Produces: `GET /signin` serves the themed page unauthenticated (so a logged-out user can reach it without triggering a chooser). The two buttons then drive the authenticated `/login?sap_idp=...` flow.

- [ ] **Step 1: Add the public `/signin` route**

In `approuter/xs-app.json`, add this route to the `routes` array (place it near the other static/public page routes, before any broad catch-all):
```json
{
  "source": "^/signin/?(\\?.*)?$",
  "authenticationType": "none",
  "target": "/signin/index.html",
  "localDir": "static"
}
```

- [ ] **Step 2: Validate JSON + route ordering**

Run: `node -e "const c=JSON.parse(require('fs').readFileSync('approuter/xs-app.json','utf8')); const i=c.routes.findIndex(r=>r.source.includes('signin')); console.log('signin route index',i,'of',c.routes.length); process.exit(i<0?1:0)"`
Expected: prints a non-negative index. Confirm by eye it precedes any `"^/(.*)$"`-style catch-all.

- [ ] **Step 3: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat(auth): serve public /signin page from approuter (#2506)"
```

---

### Task 5: Post-deploy e2e smoke for the sign-in page

**Files:**
- Create: `test/e2e/signin.spec.ts`
- Reference: `test/e2e/README.md` and an existing `test/e2e/*.spec.ts` for the self-skip + base-URL pattern

**Interfaces:**
- Consumes: the deployed `/signin` page (needs `SMOKE_BASE_URL`).
- Produces: a self-skipping Playwright spec asserting both buttons + hrefs render.

- [ ] **Step 1: Read the existing e2e self-skip pattern**

Run: `grep -rn "SMOKE_BASE_URL\|test.skip\|baseURL" test/e2e | head`
Expected: shows how specs read `SMOKE_BASE_URL` and self-skip when absent. Mirror it exactly in Step 2.

- [ ] **Step 2: Write the spec (mirroring the pattern from Step 1)**

Create `test/e2e/signin.spec.ts` (adapt imports/skip to match Step 1's convention):
```ts
import { test, expect } from '@playwright/test';

const BASE = process.env.SMOKE_BASE_URL;

test.describe('sign-in page (#2506)', () => {
  test.skip(!BASE, 'SMOKE_BASE_URL not set — post-deploy only');

  test('renders both IdP-pinned sign-in buttons', async ({ page }) => {
    await page.goto(`${BASE}/signin`);
    const sapBtn = page.getByRole('link', { name: 'Sign in with SAP', exact: true });
    const uidBtn = page.getByRole('link', { name: 'Sign in with SAP Universal ID' });
    await expect(sapBtn).toBeVisible();
    await expect(uidBtn).toBeVisible();
    await expect(sapBtn).toHaveAttribute('href', '/login?sap_idp=sap.default');
    await expect(uidBtn).toHaveAttribute('href', '/login?sap_idp=sap.custom');
  });
});
```

- [ ] **Step 3: Verify it self-skips locally (no SMOKE_BASE_URL)**

Run: `npx playwright test test/e2e/signin.spec.ts` (or the repo's `npm run test:e2e` script)
Expected: the test is SKIPPED (not failed) because `SMOKE_BASE_URL` is unset.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/signin.spec.ts
git commit -m "test(auth): post-deploy e2e smoke for /signin page (#2506)"
```

---

### Task 6: Document the sign-in flow

**Files:**
- Modify: `docs/developers/architecture/authentication.md`

**Interfaces:**
- Consumes: the final behavior from Tasks 1–4.
- Produces: documentation only.

- [ ] **Step 1: Add a "Two-button sign-in + IdP pinning" section**

Append to `docs/developers/architecture/authentication.md` a section covering:
- `/signin` is a public themed page; buttons link to `/login?sap_idp=sap.default` (SAP ID Service) and `/login?sap_idp=sap.custom` (IAS `atxgsg7zi`, social providers).
- `sap_idp` → approuter `login_hint={"origin":...}` → XSUAA jumps straight to that IdP; `dynamicIdentityProvider:true` on `/login` is the gate.
- Both IdPs federate through XSUAA, which re-issues its own token; the `(iss,sub)` resolver (#2552) merges to one `user_uuid` by email.
- Caveat: switching IdPs requires `/logout` first.
- Known boundary: a social login whose SAP-ID row has NULL email gets a separate row until explicit account-merge (#2552 limit).

- [ ] **Step 2: Commit**

```bash
git add docs/developers/architecture/authentication.md
git commit -m "docs(auth): document two-button sign-in and sap_idp pinning (#2506)"
```

---

### Task 7: DEV deploy + live verification

**Files:** none (deploy + manual/automated verification).

**Interfaces:**
- Consumes: all prior tasks on the branch, merged to DEV.
- Produces: a verified working `/signin` on DEV.

- [ ] **Step 1: Confirm clean tree + correct branch, open PR to DEV**

```bash
git status --porcelain   # expect empty
gh pr create --base DEV --fill
```

- [ ] **Step 2: After merge, deploy DEV from fresh origin/DEV (full build)**

Follow CLAUDE.md canonical deploy (set `CAP_BASE_URL` to the deployed DEV srv, `npm run build:all` before `mbt build`, FULL deploy — no `--skip-build`, no `-m`). Wrap noisy commands in `scripts/quiet-run.sh`. Confirm `cf target` is DEV first.

- [ ] **Step 3: Verify the chooser is suppressed for each button**

In a logged-out browser:
- Visit `/signin` → confirm themed page, both buttons, light/dark follows the site toggle.
- Click **Sign in with SAP** → lands DIRECTLY on SAP ID Service (no "default vs custom" screen).
- Log out. Click **Sign in with SAP Universal ID** → lands DIRECTLY on the IAS page showing social providers (no chooser).
- Confirm the authorize URL carries `login_hint={"origin":"sap.default"}` resp. `"sap.custom"` (DevTools network, the redirect to XSUAA). If the chooser still appears, `dynamicIdentityProvider` is not being honored — recheck Task 1.

- [ ] **Step 4: Verify identity continuity**

Log in via SAP ID (note your progress), log out, log in via SAP Universal ID with the same email → confirm the SAME account/progress (same `user_uuid`). If a separate account appears, confirm whether the SAP-ID row had a populated email (known #2552 boundary) before treating it as a defect.

- [ ] **Step 5: Verify default-path regression**

Confirm normal navigation and already-authenticated sessions are unaffected (existing deep links still work; no one is bounced to `/signin` unexpectedly).

---

## Self-Review

**Spec coverage:**
- Enable `dynamicIdentityProvider` → Task 1. ✓
- Two-button themed page (Hugo-sourced, cloned from 403, light/dark, logo) → Tasks 2–3. ✓
- `sap_idp` pinning per button → Tasks 2 (hrefs) + 1 (gate). ✓
- Public `/signin` served by approuter → Task 4. ✓
- Identity continuity (no change, verify only) → Task 7 Step 4. ✓
- IdP-switch-via-logout caveat → documented Task 6; buttons rely on `/login` which handles fresh login. (Signed-in account-menu "switch IdP via logout" wiring is a UI nicety — see Deferred.)
- Styling recipe → Tasks 2–3. ✓
- Testing (both buttons, regression, role auth) → Tasks 5 + 7. ✓

**Placeholder scan:** No TBD/TODO; every code step has concrete content; illustration-name and front-matter-convention uncertainties are handled with explicit verify-and-adjust steps rather than left vague.

**Type consistency:** Origin keys `sap.default`/`sap.custom`, hrefs `/login?sap_idp=...`, and button labels are identical across Tasks 1, 2, 5, 6. ✓

## Deferred (not this plan)

- **Force ALL unauthenticated entry to `/signin`** (global redirect so the raw XSUAA chooser is unreachable by any path). The current plan makes `/signin` the sign-in CTA; a global redirect rewrite touches the default path broadly and is a separate hardening step once the page is proven on DEV.
- **Signed-in "switch IdP" account-menu item** routing through `/logout?returnTo=/signin` — UI nicety, additive later.
- **IAS login-page branding / custom domain** — separate follow-up per #2506.
- **Cross-provider explicit account-merge UX** (same human, SAP then social, when email was absent) — #2552 deferred item.
