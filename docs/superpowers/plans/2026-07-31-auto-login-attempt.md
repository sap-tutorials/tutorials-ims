# Automatic Login Attempt on First Connect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On first connect within a browser session, automatically attempt login on every page except the site root (`/`), so SSO'd users land signed in without clicking the profile avatar.

**Architecture:** A pure behavioral change to the inline `<script>` IIFE in the shared Hugo header partial. The existing `checkAuth()` call already runs on page load and calls `/auth/user`; we add a `maybeAutoLogin()` that fires only on a *definitive* anonymous answer (not network errors), guarded by a per-session `sessionStorage` flag and a cross-tab `localStorage` logout opt-out, and exempt on `pathname === '/'`. All supporting machinery (`/login?returnTo=`, `/auth/user`, session cookie, `login-redirect.html`) already exists — no approuter, CAP, or route changes.

**Tech Stack:** Vanilla browser JS inside a Hugo Go-template partial; Playwright (`playwright-core`) driven by Vitest for the e2e coverage spec.

## Global Constraints

- **Single production file changes:** `hugo/layouts/partials/header.html` (inline `<script>` only). No approuter / CAP service / `xs-app.json` / route changes. No new JS modules. (spec "Scope", "Non-goals")
- **No `prompt=none` / iframe silent auth** — the vendored `@sap/approuter` 16.9.0 has no hook to inject it; a brief full-page redirect through `/login` is the accepted trade-off. (spec "Non-goals")
- **Homepage `/` is exempt** — check is `window.location.pathname === '/'` only; no child path is exempted. (spec "Mechanism" notes)
- **Redirect uses `window.location.replace`** (not `.href`) so the transient `/login` URL stays out of browser history. (spec notes)
- **`autologin.tried`** = `sessionStorage`, set immediately before the redirect (loop-breaker). **`autologin.optout`** = `localStorage`, set by the logout handler, cleared on the next successful authentication and on manual profile-click login. (spec "Guards")
- **Network/exception path must never auto-redirect** — only a definitive server answer (401/redirected/non-JSON/`authenticated:false`) triggers it. (spec "Mechanism" step 4)
- **All storage access wrapped in `try/catch`**, failing closed toward "stay anonymous". (spec "Error handling")
- **e2e specs self-skip** via `describe.skipIf(!hasBaseUrl())` and run against a deployed env only (post-DEV-deploy `e2e` CI job), never blocking `npm test`. (spec "Testing"; `test/e2e/README.md`)

---

## File Structure

- **Modify:** `hugo/layouts/partials/header.html` — add `maybeAutoLogin()`; wire it into `checkAuth()`'s `finally`; clear opt-out on auth success and on manual login click; set opt-out on logout.
- **Create:** `test/e2e/auto-login.test.js` — Playwright spec asserting the homepage exemption and the anonymous-deep-link redirect trigger (credential-free), plus an authenticated no-redirect case (credential-gated).

---

## Task 1: Auto-login behavior in the header partial

**Files:**
- Modify: `hugo/layouts/partials/header.html` (inline `<script>`: `applyAuthenticatedUser` ~323–353, profile-click handler ~160–172, logout handler ~227–235, `checkAuth` ~355–392)

**Interfaces:**
- Consumes: existing `isAuthenticated` closure var, `applyAuthenticatedUser(u)`, `readCachedUser()`, `/auth/user` endpoint, `/login?returnTo=` route.
- Produces: `maybeAutoLogin()` (closure-scoped, no args, no return); `sessionStorage['autologin.tried']`; `localStorage['autologin.optout']`. These keys are what Task 2 asserts against.

- [ ] **Step 1: Add the `maybeAutoLogin()` function**

Insert immediately **before** `async function checkAuth() {` (currently line 355):

```javascript
  // Issue: automatic login attempt on first connect. On a definitive anonymous
  // answer from /auth/user (see checkAuth), attempt login once per browser
  // session — EXCEPT on the site root, which stays anonymous for drive-by
  // readers. If an SSO session exists at the IDP, /login resolves transparently
  // and returns the user authenticated; if not, the IDP bounces straight back
  // and the 'tried' flag (set before the redirect) prevents a loop.
  function maybeAutoLogin() {
    // Homepage (/) is exempt — never auto-redirect there.
    if (window.location.pathname === '/') return;
    // Cross-tab logout opt-out: the user intentionally logged out; respect it.
    try { if (localStorage.getItem('autologin.optout') === '1') return; } catch {}
    // Once per browser session.
    try { if (sessionStorage.getItem('autologin.tried') === '1') return; } catch {}
    try { sessionStorage.setItem('autologin.tried', '1'); } catch {}
    const returnTo = window.location.pathname + window.location.search;
    window.location.replace('/login?returnTo=' + encodeURIComponent(returnTo));
  }
```

- [ ] **Step 2: Clear the opt-out on successful authentication**

In `applyAuthenticatedUser(u)`, immediately after the `if (!u) return;` guard (currently line 324), add:

```javascript
    // A successful login supersedes any prior intentional logout — re-enable
    // auto-login for future sessions. Safe post-logout because the logout
    // handler wipes the 'joule.user.v1' cache, so this runs only on genuine auth.
    try { localStorage.removeItem('autologin.optout'); } catch {}
```

- [ ] **Step 3: Set the opt-out on logout**

In the `logoutBtn.addEventListener('click', ...)` handler (currently line 227), add as the **first** statement inside the handler, before the existing `try {` that clears `joule.*` keys:

```javascript
    // Suppress auto-login across tabs until the next deliberate login.
    try { localStorage.setItem('autologin.optout', '1'); } catch {}
```

- [ ] **Step 4: Clear the opt-out on manual profile-click login**

In the `profile-click` handler, inside the `if (!isAuthenticated) {` block (currently lines 161–163), add **before** the `window.location.href = ...` line so explicit login intent overrides a prior logout and marks the session as tried:

```javascript
      try { localStorage.removeItem('autologin.optout'); } catch {}
      try { sessionStorage.setItem('autologin.tried', '1'); } catch {}
```

The block becomes:

```javascript
    if (!isAuthenticated) {
      try { localStorage.removeItem('autologin.optout'); } catch {}
      try { sessionStorage.setItem('autologin.tried', '1'); } catch {}
      window.location.href = '/login?returnTo=' + encodeURIComponent(window.location.pathname + window.location.search);
      return;
    }
```

- [ ] **Step 5: Wire `maybeAutoLogin()` into `checkAuth` — definitive-anonymous only**

Two edits inside `checkAuth()`:

(a) Add a flag at the **top** of the function body, immediately after `async function checkAuth() {`:

```javascript
    let definitiveAnonymous = false;
```

(b) Set it in each of the three server-answer anonymous branches (do **not** touch the `catch` block). In each branch that currently reads `const cached = readCachedUser(); if (cached) applyAuthenticatedUser(cached); return;`, add `definitiveAnonymous = true;` as the first line of the branch. There are three such branches: `if (res.redirected || !res.ok)`, `if (!ct.includes('application/json'))`, and `if (!user || !user.authenticated)`. Example for the first:

```javascript
      if (res.redirected || !res.ok) {
        definitiveAnonymous = true;
        const cached = readCachedUser();
        if (cached) applyAuthenticatedUser(cached);
        return;
      }
```

(c) In the `finally` block, extend the existing anonymous guard so it also attempts auto-login — but only when the anonymous state came from a definitive server answer (never from a network error, and never when a cached user was applied, since that sets `dataset.authenticated === 'true'`):

```javascript
    } finally {
      // Issue #548: ensure exactly one auth-resolved event fires per page load.
      if (document.documentElement.dataset.authenticated !== 'true') {
        document.documentElement.dataset.authenticated = 'false';
        document.dispatchEvent(new CustomEvent('auth-resolved', { detail: { authenticated: false } }));
        // Auto-login attempt: only on a definitive anonymous answer, never on a
        // network/exception fallthrough (definitiveAnonymous stays false there).
        if (definitiveAnonymous) maybeAutoLogin();
      }
    }
```

- [ ] **Step 6: Static sanity — Hugo template still parses and the wiring is present**

Run from the worktree root:

```bash
grep -n "maybeAutoLogin\|autologin.tried\|autologin.optout\|definitiveAnonymous" hugo/layouts/partials/header.html
npx hugo --quiet --destination /tmp/hugo-autologin-check --contentDir hugo/content --source hugo 2>&1 | tail -20 || true
```

Expected: the grep shows the new function, both storage keys (set + cleared sites), the flag, and its guarded call. Hugo build emits no template-parse error for `header.html`. (A missing `fetch-tutorials` cache may cause unrelated content warnings — only a Go-template parse error on `header.html` is a failure here.)

- [ ] **Step 7: Manual browser verification against deployed DEV**

Per the project rule "test the actual thing before done", this is mandatory before the task is considered complete. Load the deployed DEV approuter in a real browser (the change must be deployed first — header.html is baked at Hugo build time). Verify each case:

- Homepage `/` while signed **out** → **no** redirect to `/login`; anonymous homepage stays. `sessionStorage.getItem('autologin.tried')` is `null`.
- A deep link (e.g. `/tutorials/<slug>`) with an **active** SSO session → auto signs in with no click; profile avatar shows initials.
- A deep link with **no** SSO session → brief IDP bounce, returns anonymous, and refreshing does **not** loop (`autologin.tried === '1'`).
- Click Logout → land on `/` signed out; open a **new tab** to a deep link → stays anonymous (`localStorage.getItem('autologin.optout') === '1'`).
- After logout, click the profile to log in → succeeds and `autologin.optout` is cleared.

- [ ] **Step 8: Commit**

```bash
git add hugo/layouts/partials/header.html
git commit -m "feat(auth): auto-attempt login on first connect (homepage exempt)"
```

---

## Task 2: e2e coverage spec

**Files:**
- Create: `test/e2e/auto-login.test.js`
- Reference (read-only): `test/e2e/tutorial-serve.test.js`, `test/e2e/_browser.js`, `test/e2e/e2e.config.js`

**Interfaces:**
- Consumes: `hasBaseUrl`, `hasCredentials` from `./e2e.config.js`; `launchBrowser`, `newPage` from `./_browser.js`; the `autologin.tried` / `autologin.optout` keys and `maybeAutoLogin()` behavior from Task 1.
- Produces: nothing consumed downstream (leaf spec).

- [ ] **Step 1: Write the spec**

Create `test/e2e/auto-login.test.js`:

```javascript
// e2e: automatic login attempt on first connect (homepage exempt).
// Path: browser → approuter static page → inline header.html checkAuth →
// maybeAutoLogin → /login redirect (or none, on the homepage).
//
// Credential-free cases (anonymous) are the core assertions and run with just
// PLAYWRIGHT_BASE_URL. The /login navigation is intercepted+aborted so the test
// never touches the external SAP IDP. Reuses the stable HANA-served slug from
// tutorial-serve.test.js.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasBaseUrl, hasCredentials } from './e2e.config.js';
import { launchBrowser, newPage } from './_browser.js';

const SLUG = 'abap-cloud-ui-from-interface';

describe.skipIf(!hasBaseUrl())('e2e: auto-login on first connect', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('homepage (/) does NOT auto-redirect an anonymous visitor', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    let loginHit = false;
    await page.route('**/login?**', route => { loginHit = true; return route.abort(); });
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      // Give the async checkAuth()/maybeAutoLogin() a beat to run.
      await page.waitForTimeout(2000);
      expect(loginHit, 'homepage must not trigger auto-login').toBe(false);
      const tried = await page.evaluate(() => {
        try { return sessionStorage.getItem('autologin.tried'); } catch { return 'ERR'; }
      });
      expect(tried, 'autologin.tried must be unset on the homepage').toBeNull();
    } finally {
      await context.close();
    }
  });

  it('a deep link auto-redirects an anonymous visitor to /login and sets the tried flag', async () => {
    const { context, page } = await newPage(browser, { authenticated: false });
    let loginHit = false;
    // Intercept the /login navigation so we never reach the external IDP.
    await page.route('**/login?**', route => { loginHit = true; return route.abort(); });
    try {
      await page.goto(`/tutorials/${SLUG}`, { waitUntil: 'domcontentloaded' });
      // maybeAutoLogin fires from checkAuth's finally after /auth/user resolves 401.
      await page.waitForTimeout(3000);
      expect(loginHit, 'anonymous deep link must trigger a /login redirect').toBe(true);
      const tried = await page.evaluate(() => {
        try { return sessionStorage.getItem('autologin.tried'); } catch { return 'ERR'; }
      });
      expect(tried, 'autologin.tried must be set before redirecting').toBe('1');
    } finally {
      await context.close();
    }
  });

  it.skipIf(!hasCredentials())(
    'an authenticated deep link does NOT navigate to /login', async () => {
      const { context, page } = await newPage(browser, { authenticated: true });
      let loginHit = false;
      await page.route('**/login?**', route => { loginHit = true; return route.abort(); });
      try {
        const response = await page.goto(`/tutorials/${SLUG}`, { waitUntil: 'domcontentloaded' });
        expect(response?.status(), 'deep link should load').toBe(200);
        await page.waitForTimeout(2000);
        expect(loginHit, 'authenticated user must not be redirected to /login').toBe(false);
      } finally {
        await context.close();
      }
    }
  );
});
```

- [ ] **Step 2: Run the spec locally with no base URL — confirm it self-skips**

Run from the worktree root:

```bash
npx vitest run --project e2e test/e2e/auto-login.test.js
```

Expected: the suite is skipped (no `PLAYWRIGHT_BASE_URL`), exit 0, no failures — confirming `npm test` is never affected.

- [ ] **Step 3: Run against deployed DEV (post-deploy) — confirm it passes**

After Task 1 is deployed to DEV (header.html baked), run:

```bash
export PLAYWRIGHT_BASE_URL="https://tutorial-system-dev-tutorials.cfapps.eu10-005.hana.ondemand.com"
export SMOKE_TECH_USER="<tech-user>"        # optional — enables the authenticated case
export SMOKE_TECH_PASSWORD="<tech-password>"
npx playwright install --with-deps chromium   # one-time
npx vitest run --project e2e test/e2e/auto-login.test.js
```

Expected: the two anonymous cases PASS; the authenticated case PASSES when credentials are present, else self-skips. If the slug 404s, swap for another slug from `test/a11y/urls.js` (same note as `tutorial-serve.test.js`).

- [ ] **Step 4: Commit**

```bash
git add test/e2e/auto-login.test.js
git commit -m "test(e2e): auto-login homepage-exempt + deep-link redirect coverage"
```

---

## Self-Review

**Spec coverage:**
- Mechanism (check-then-redirect, Option B) → Task 1 Steps 1, 5. ✓
- Homepage `/` exemption → Task 1 Step 1 (`pathname === '/'`); Task 2 case 1. ✓
- `autologin.tried` set-before-redirect, once/session → Task 1 Step 1. ✓
- `autologin.optout` set on logout / cleared on auth + manual login → Task 1 Steps 2, 3, 4. ✓
- Network/exception path never redirects → Task 1 Step 5 (`definitiveAnonymous` flag, not set in `catch`). ✓
- `try/catch` fail-closed on all storage → Task 1 Steps 1–4. ✓
- Manual verification of all cases → Task 1 Step 7. ✓
- Committed e2e spec (homepage no-redirect + tried unset; anonymous deep-link sets tried; authenticated no-redirect) → Task 2. ✓
- QA-channel safety call-out → covered by Task 1 Step 7 (real-browser check on deployed env; logic is auth-type agnostic). The homepage-exempt logic runs identically on QA pages; no extra task needed.
- Fragment-cache / full-deploy note → reflected in Task 1 Step 7 and Task 2 Step 3 (deploy-before-verify). ✓

**Placeholder scan:** No TBD/TODO; every code step has literal code; credentials shown as `<tech-user>` placeholders in shell env exports only (expected — real secrets never committed). ✓

**Type consistency:** `maybeAutoLogin` (no args) called once in `finally`; `definitiveAnonymous` declared at function top and set in the three named branches; storage keys `autologin.tried` / `autologin.optout` spelled identically across Task 1 and Task 2. ✓
