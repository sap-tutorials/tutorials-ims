# TrustArc CMP Integration — Design

**Date:** 2026-07-23
**Status:** Approved (brainstorming) — pending spec review
**Author:** Tom (with Claude)
**Related:** AEM gap-analysis #13 (Cookie Consent, closed 2026-05-21); `docs/developers/reference/cookie-and-storage-analysis.md`

## Problem & Goal

The legacy AEM site (developers.sap.com) runs the corporate TrustArc CMP in production. The
Hugo replacement currently ships a **self-contained in-house consent banner**
(`hugo/static/js/consent.js`, gap #13) that was explicitly built to be swapped for the
corporate CMP later.

This is a **parity** task: wire the same TrustArc property the legacy production site already
uses. TrustArc is already Legal-approved and live in legacy — this is not a net-new privacy
decision, so **there is no Legal gate** on the cutover. The goal is behavioral parity with the
legacy TrustArc integration.

## Ground Truth (captured from live legacy site, 2026-07-23)

Captured via a real Chromium (Playwright) against `https://developers.sap.com/` — WebFetch and
curl are both blocked at the Akamai edge (`edgesuite.net` 403, bot fingerprint). **These are
the authoritative values; TrustArc's generic docs and the SAP wrapper config both mislead.**

- **Property `domain` = `sapshared.com`** (the shared SAP TrustArc property). NOTE: the SAP
  wrapper config carries a cosmetic `domain: 'www.developers.sap.com'`, but the *actual* notice
  request TrustArc fires uses `domain=sapshared.com`. The wrapper value must not be used as the
  property ID.
- **Notice snippet (exact):**
  ```
  https://consent.trustarc.com/notice?domain=sapshared.com&c=teconsent&gtm=1&js=nj&noticeType=bb&pn=1-0&country=US&text=true&privacypolicylink=https%3A%2F%2Fwww.sap.com%2Fabout%2Flegal%2Fprivacy.html
  ```
- **Asset script:** `https://consent.trustarc.com/asset/notice.js/v/v1.7-484` (version pin — see
  Open Questions; may float).
- **Runtime domains actually contacted** (basis for CSP):
  - `https://consent.trustarc.com` — notice script, `asset/notice.js`, `analytics` beacons,
    `get?name=…` fonts/icons, `consent/log` pixel. **All eager assets come from here.**
  - `https://user-consent-center.trustarc.com` — `truste.eu.USER_CONSENT_CENTER_SERVER`; hit
    when a user saves preferences (lazy `connect-src` need).
  - `static.trustarc.com` is **never contacted** — do not add it.
- **Consent-read API:** `window.PrivacyManagerAPI.callApi('getConsentDecision', 'sapshared.com')`
  returns `{ consentDecision, source }`. Cookies present: `notice_gdpr_prefs=0,1,2::implied,eu`,
  `cmapi_cookie_privacy=permit 1,2,3`, `notice_behavior=implied,eu`.
- **Reopen API:** `window.truste.eu.reopenBanner()` is a function (drives the "Cookie
  Preferences" reopen).
- **DOM anchors TrustArc requires:** `<div id="teconsent">` (renders the preferences link) and
  `<div id="consent_blackbar">` (renders the blackbar banner).
- **Reload handler:** legacy attaches a `body` click listener that, on
  `event.target.id === 'truste-consent-button'`, stashes referrer into `sessionStorage` and
  reloads after 1s. Reproduced for parity.
- **SAP wrapper bootstrap:** inline script sets `window.SAP.global.trustArc = { domain, privacyPolicyLink }` and an `isProd` regex. Reproduced.

## Architecture

A single Hugo site param `params.cmp` selects the consent path **at build time**:

| Value | Behavior |
|-------|----------|
| `trustarc` | **DEFAULT.** Emits SAP wrapper bootstrap + `teconsent`/`consent_blackbar` divs + TrustArc notice/asset scripts + reload handler + `consent-trustarc.js` shim. |
| `inhouse` | Break-glass rollback. Emits today's `<script defer src="/js/consent.js">`, unchanged. |
| `off` | Emits nothing (QA/preview builds). |

**Why build-time, not runtime:** the public site is static Hugo behind AppRouter with no
per-request server render; CSP is decided at deploy regardless. A build param keeps the emitted
markup and the CSP in lockstep and gives a one-param + redeploy rollback.

**New/changed files:**
- `hugo/layouts/partials/consent.html` — **new.** Branches on `params.cmp`. Replaces the
  hardcoded `<script defer src="/js/consent.js">` at `hugo/layouts/_default/baseof.html:50`.
- `hugo/static/js/consent-trustarc.js` — **new.** The `window.consent.*` compatibility shim.
- `hugo/static/js/consent.js` — **unchanged**, retained for the `inhouse` fallback.
- `hugo/config` (params) — **new params:** `cmp` (default `trustarc`),
  `trustArcDomain` (default `sapshared.com`), `trustArcPrivacyLink`, `trustArcNoticeAssetVersion`.
  Property values single-sourced here.
- `approuter/xs-app.json` — CSP additions (below). **Single-sourced** — verified no `.deploy/`
  copy drift (unlike `xs-security.json`).
- `hugo/layouts/partials/footer.html` — **unchanged.** The shim keeps `window.consent.show()`
  working; the footer button needs no edit.

## CSP Changes (`approuter/xs-app.json`)

Add `https://consent.trustarc.com` to:
- `script-src` (notice + asset scripts; note `'unsafe-inline'` already present, so no nonce needed)
- `img-src` (analytics beacons, `consent/log` pixel, `get?name=…` icons)
- `font-src` (`get?name=…woff2`)
- `connect-src`

Add `https://user-consent-center.trustarc.com` to:
- `connect-src` (preference-save XHR)

Do **not** add `static.trustarc.com` (never contacted). Since `trustarc` is the default, the CSP
change ships together with this work — no separate flip. If rolling back to `inhouse`, the extra
CSP entries are harmless (nothing loads them) but should be reverted for hygiene.

## The `window.consent.*` Compatibility Shim (`consent-trustarc.js`)

Only one live consumer exists today: the footer "Cookie Preferences" button → `consent.show()`
(`footer.html:37`). No `has()`/`onChange()` callers exist in real code. The shim keeps the API
intact for future analytics gating without over-building.

- **`show()`** → `window.truste.eu.reopenBanner()`. If `truste` not yet defined (script still
  loading), queue and flush on ready.
- **`has(category)`** → map our `required|functional|advertising` to TrustArc groups `0,1,2`.
  Read via `PrivacyManagerAPI.callApi('getConsentDecision','sapshared.com')`; fall back to
  parsing `cmapi_cookie_privacy` / `notice_gdpr_prefs` cookies. `required` always `true`
  (matches current fallback semantics).
- **`onChange(fn)`** → subscribe via `window.truste.eu.addEventListener` (present in the live
  `euKeys`). Defensive if absent.

Defensive throughout: if `truste`/`PrivacyManagerAPI` are unavailable, degrade to the same
"required-only" default the current code uses — never throw.

## Testing

- **Build-render test:** assert `cmp: trustarc` output contains the notice `<script>` (with
  `domain=sapshared.com`), the `teconsent` + `consent_blackbar` divs, and `consent-trustarc.js`;
  and that `cmp: inhouse` emits `consent.js` and NOT the TrustArc tags (mutually exclusive).
- **Smoke test** (`test/smoke/consent-cmp.test.js`): assert the deployed CSP response header
  contains `consent.trustarc.com`, and the served homepage HTML contains the notice script tag.
  Guards the CSP/markup lockstep.
- **Manual parity check:** load a deployed instance, confirm blackbar renders, "Cookie
  Preferences" reopens the manager, no CSP violations in console.

## Documentation Updates

- Update gap-analysis #13 note to record the TrustArc swap (property `sapshared.com`, date).
- Update `docs/developers/reference/cookie-and-storage-analysis.md` to reflect TrustArc as the
  live CMP and the new third-party cookies it sets (`notice_*`, `cmapi_*`).
- Add a short runbook: how to flip `cmp` param for rollback, and the CSP entries involved.

## Rollback

Flip `params.cmp` → `inhouse`, redeploy. Optionally revert the CSP additions for hygiene. The
in-house banner (`consent.js`) and its API return unchanged.

## Open Questions / Risks

1. **Asset version pin `v1.7-484`:** the legacy site pins a specific `notice.js` version. Decide
   whether to pin (reproducible, may go stale) or track latest. Recommendation: pin, and note it
   in the runbook for periodic refresh. Confirm the URL is stable.
2. **`country=US` in the snippet:** the legacy notice hardcodes `country=US` — TrustArc appears
   to geo-resolve server-side regardless (the response set `behavior=implied,eu`). Reproduce the
   legacy value verbatim for parity; do not "improve" it.
3. **QA/preview builds:** confirm `cmp: off` (or `inhouse`) is wired for `site.Params.qa` /
   `previewMode` so author-preview channels don't show a live consent banner. baseof.html already
   branches heavily on those flags.
4. **`sapshared.com` property scope:** parity assumes reusing the shared SAP property is correct
   for this origin (it is what legacy serves). If TrustArc's backend keys behavior to the
   requesting origin, verify the blackbar resolves on the new AppRouter domain in DEV before PROD.

## YAGNI / Non-Goals

- No runtime auto-fallback between TrustArc and in-house (rejected in brainstorming — flag +
  redeploy is the rollback).
- No new consent categories — Required/Functional/Advertising already matches TrustArc `0,1,2`.
- No server-side consent storage — TrustArc owns consent state client-side.
