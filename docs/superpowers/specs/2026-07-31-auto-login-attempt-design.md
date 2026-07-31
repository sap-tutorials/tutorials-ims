---
title: Automatic login attempt on first connect
date: 2026-07-31
status: approved
---

# Automatic login attempt on first connect

## Problem

When a visitor first connects to the tutorial site they are always
unauthenticated. Interactive features (progress tracking, step completion,
`/me`) require a session, but a session is only established when the user
manually clicks the profile avatar, which triggers `/login?returnTo=...`.

If the user already has an SSO session at `accounts.sap.com`, that login
resolves transparently — so for the large population of already-signed-in SAP
users, the manual click is pure friction. We want the site to *attempt* login
automatically on first connect, and only leave the user anonymous when the
attempt does not resolve.

## Goal

On first connect within a browser session, automatically attempt login.
Authenticated-via-SSO users land signed in with no interaction. Users without
an SSO session end up anonymous (after a brief IDP round-trip) and are not
pestered again for the rest of the session.

## Non-goals

- **No invisible/iframe silent auth.** The vendored `@sap/approuter` (v16.9.0)
  builds the OAuth authorize URL in `lib/passport/oauth2.js` with a hardcoded
  query (`response_type`, `client_id`, `redirect_uri`, optional
  `scope`/`login_hint`/`state`). There is **no configuration hook to inject
  `prompt=none`**. True OIDC silent authentication would require patching the
  vendored approuter — rejected as a maintenance liability. A brief full-page
  redirect through `/login` is the accepted trade-off (confirmed with the user).
- No approuter, CAP service, `xs-app.json`, or route changes.
- No change to the manual profile-click login path's end behavior (it keeps
  working; it just also records the "tried" flag).

## Scope

Single file: `hugo/layouts/partials/header.html` — the inline `<script>` IIFE
(the `checkAuth()` function and the profile-click / logout handlers). All the
supporting machinery already exists:

- `/login?returnTo=<path>` route (approuter, `authenticationType: "xsuaa"`)
- `/auth/user` endpoint returning `{ authenticated, id, email, givenName, ... }`
- Session cookie + `/logout` route
- `login-redirect.html` which reads `returnTo` and `location.replace`s to it

## Mechanism — check-then-redirect (Option B)

Reuse the existing `checkAuth()` call already made on `ui5-shellbar` definition.

1. Page loads. `checkAuth()` calls `GET /auth/user` (as today).
2. **Authenticated** (`res.ok`, JSON, `authenticated:true`) → populate profile
   as today. Additionally: clear the logout opt-out flag (a successful login
   supersedes any prior intentional logout). No redirect.
3. **Definitively anonymous** — the branches that today fall back to cache:
   `res.redirected`, `!res.ok` (401), non-JSON response, or
   `authenticated:false`. In these branches, call `maybeAutoLogin()`.
4. **Network/exception path** (the `catch`) → do **not** auto-redirect. Cache
   fallback only, exactly as today. (Prevents redirect storms on flaky
   networks or transient srv outages.)

`maybeAutoLogin()`:

```
function maybeAutoLogin() {
  // localStorage opt-out: user intentionally logged out — respect it across tabs
  try { if (localStorage.getItem('autologin.optout') === '1') return; } catch {}
  // once per browser session
  try { if (sessionStorage.getItem('autologin.tried') === '1') return; } catch {}
  try { sessionStorage.setItem('autologin.tried', '1'); } catch {}
  const returnTo = window.location.pathname + window.location.search;
  window.location.replace('/login?returnTo=' + encodeURIComponent(returnTo));
}
```

Notes:

- `sessionStorage.setItem('autologin.tried','1')` is set **before** the
  redirect. This is the loop-breaker: if the IDP has no session and bounces the
  user straight back anonymous, the flag is already present, so `checkAuth()`
  on the returned page does not re-attempt.
- `location.replace` (not `location.href`) so the transient `/login` URL does
  not land in browser history — Back from the returned page goes to wherever
  the user came from, not into a redirect.
- `returnTo` reuses the same relative-path form the profile-click handler
  already uses; `login-redirect.html` already validates it against open-redirect
  (must start with a single `/`).

## Guards (correctness core)

### `autologin.tried` (sessionStorage) — "once per session"

Set immediately before any auto-redirect. Honors the once-per-session decision
and breaks the no-SSO bounce-back loop. Per-tab by nature of sessionStorage,
which is fine: a fresh tab is a legitimately new "first connect."

### `autologin.optout` (localStorage) — logout guard, cross-tab

The logout handler sets `localStorage['autologin.optout'] = '1'` before
navigating to `/logout`. This survives across tabs, so opening a new tab after
an intentional logout will **not** silently re-log the user in (the IDP SSO
session may still be valid, so without this guard auto-login would immediately
undo the logout).

The opt-out is **cleared on the next successful authentication** (the
authenticated branch of `checkAuth`) and also cleared when the user manually
clicks the profile to log in — so a deliberate later login re-enables
auto-login for future sessions.

### Manual profile-click path

The existing profile-click handler (currently `window.location.href =
'/login?returnTo=...'` when `!isAuthenticated`) will:
- clear `autologin.optout` (explicit login intent overrides prior logout),
- set `autologin.tried` (so the automatic path won't also fire this session).

## Interaction matrix

| Scenario | autologin.tried | autologin.optout | Behavior |
|---|---|---|---|
| First visit, SSO session exists | unset | unset | auto-redirect → returns authenticated; optout cleared |
| First visit, no SSO session | unset | unset | auto-redirect → IDP → bounces back anonymous; tried=1; no re-loop |
| Refresh after anonymous bounce | set | unset | no re-attempt (tried=1) |
| After intentional logout, same tab | set | set | no re-attempt |
| After intentional logout, new tab | unset (new tab) | set | no re-attempt (optout blocks) |
| Manual login click | set by click | cleared by click | normal login |
| /auth/user network error | not set | — | no auto-redirect; cache fallback only |

## Error handling

- Any `try/catch` around storage access degrades gracefully: if storage is
  unavailable (private mode quirks), auto-login simply does not fire (fail
  closed toward "stay anonymous"), never throws, never loops.
- The `catch` branch of `checkAuth` never auto-redirects.

## Testing

The auth logic lives inline in a Hugo partial; there is no existing unit
harness for it. Verification plan:

1. **Manual browser verification** (per project rule "test the actual thing"):
   exercise all four core cases in a real browser against the deployed DEV
   approuter —
   - SSO present → auto signs in, no click;
   - no SSO → brief IDP bounce, returns anonymous, **no loop**;
   - intentional logout → stays logged out (same tab and new tab);
   - refresh while anonymous → no re-attempt.
2. **Committed e2e spec** per the repo's e2e-coverage pattern
   (`docs/developers/reference/e2e-coverage-pattern.md`): a Playwright check
   under `test/e2e/` asserting that (a) an authenticated session populates the
   profile without a `/login` navigation, and (b) the `autologin.tried` flag is
   set after an anonymous first load. This is advisory-gated (post-DEV-deploy
   `e2e` CI job), not a per-PR blocker.

## Risks / call-outs

- **Anonymous drive-by readers** (e.g. arriving from a search engine with no
  SAP SSO session) will hit the IDP once per session and bounce back. This is
  the accepted "brief redirect OK" trade-off. If this later proves too
  intrusive for the public tutorial audience, the fallback is to revisit
  `prompt=none` via an approuter extension — out of scope here.
- **Hugo partial is shared across all page types** including QA channel
  (`site.Params.qa`). The auto-login logic is auth-type agnostic and safe on QA
  pages (which are already xsuaa-scoped), but the e2e/manual check should
  include at least one QA-channel page load to confirm no double-redirect with
  the scope gate.
- **Fragment cache**: served tutorial pages come from HANA; the header partial
  is baked at Hugo build time, so shipping this requires a content rebuild /
  full deploy for the change to reach visitors (standard for header.html
  edits).
