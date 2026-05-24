# Cookie and Browser Storage Analysis — Public-Facing Surface

**Status:** Audit — 2026-05-20
**Scope:** Public-facing surface only — Hugo site (`/`, `/tutorials/*`, `/missions/*`, `/groups/*`), App Space (`hugo-apps/src/app-space`), Tutorial Navigator (`hugo-apps/src/navigator`), Mini-Navigator, Nav Dropdown, Joule chat widget, Display app (`app/display-app/`), Scanner UI (UI5 + Vue variants), and the AppRouter routes that serve them. **The Admin UI shell (`/admin-ui/*`) is explicitly excluded** from this audit.
**Out of scope:** Admin shell theme persistence, admin Fiori Elements apps, internal CAP service-to-service traffic.

This document is the cookie/storage inventory required by [TODO.md §21 — Cookie usage report & consent banner](../TODO.md#L549). It distinguishes **HTTP cookies** (sent automatically with every request to the matching origin/path) from **`localStorage` / `sessionStorage`** (Web Storage API, never transmitted, cleared by different rules). Both are in scope of GDPR Art. 5(3) / ePrivacy Directive (the "cookie law" applies to **any storage of or access to information on the user's terminal equipment**, regardless of mechanism), but the consent rules and lifetime characteristics differ.

---

## 1. Storage Mechanism Primer

| Mechanism | Sent on every HTTP request? | Cleared when? | Max size | Accessible from JS? | Consent regime |
|-----------|-----------------------------|---------------|----------|---------------------|----------------|
| **HTTP cookie** (no flags) | Yes (matching origin/path) | At `Expires` / `Max-Age`, or on browser close if neither set ("session cookie") | ~4 KB per cookie | Yes, unless `HttpOnly` set | GDPR Art. 5(3): consent required unless **strictly necessary** |
| **`HttpOnly` cookie** | Yes | Same as above | ~4 KB | **No** (XSS-proof) | Same as above |
| **`Secure` cookie** | Yes (HTTPS only) | Same as above | ~4 KB | Same as above | Same as above |
| **`localStorage`** | **No** (never sent) | Only by explicit JS or user action ("clear site data"). Survives browser close. | ~5–10 MB per origin | Yes | GDPR Art. 5(3): consent required unless strictly necessary — **same legal threshold as cookies** |
| **`sessionStorage`** | **No** | When the **tab** is closed (not the whole browser). Per-tab, not shared between tabs. | ~5–10 MB per origin | Yes | Same as `localStorage` |
| **IndexedDB / Cache Storage** | No | Manual or quota eviction | Large (GB) | Yes | Same |

**Key implication:** "We don't use cookies, only localStorage" is **not** a legal defense in the EU. The ePrivacy Directive, as transposed by the EU member states, applies to every form of client-side state, including `localStorage`, `sessionStorage`, IndexedDB, and Cache Storage. Use category and necessity to decide consent — not the underlying API.

---

## 2. Inventory — HTTP Cookies

The application code in this repository **does not call `res.cookie()`, `Set-Cookie`, or `document.cookie`** anywhere on the public-facing surface. All HTTP cookies observed in the request flow are set by the **infrastructure layer** (AppRouter, XSUAA, Cloud Foundry gorouter, the user's IdP, optional third parties when embedded).

### 2.1 First-party cookies set by `@sap/approuter`

Set when any route with `"authenticationType": "xsuaa"` is requested (e.g., `/auth/user`, `/api/*`, `/admin-ui/*` — though `admin-ui` is out of scope, the cookie is the same one used for the public app's authenticated calls). Configured in [`approuter/xs-app.json`](../approuter/xs-app.json) and the `@sap/approuter` defaults.

| Cookie | Type | Flags | Lifetime | Purpose | Consent category |
|--------|------|-------|----------|---------|------------------|
| `JSESSIONID` (or `connect.sid` depending on approuter version) | First-party | `HttpOnly`, `Secure` (in production over HTTPS), `SameSite=Lax` (default) | Session (cleared on browser close) — or until logout | AppRouter session id linking the browser to the cached XSUAA OAuth tokens | **Strictly necessary** — required for authenticated routes (`/auth/user`, `/api/*`, `/api/qrcode`, App Space progress, scanner). Exempt from prior consent under GDPR. |
| `XSRF-TOKEN` (only on CSRF-protected destinations) | First-party | Readable to JS (so SAP UI5 can echo it back as `x-csrf-token`) | Session | CSRF double-submit token | **Strictly necessary** |

**Implementation note:** AppRouter session and CSRF cookies are wired through the `@sap/approuter` package — verify the exact cookie names per version by inspecting a live response in DevTools. They are not configured in this repo's code.

### 2.2 First-party cookies set by Cloud Foundry gorouter

| Cookie | Type | Flags | Lifetime | Purpose | Consent category |
|--------|------|-------|----------|---------|------------------|
| `__VCAP_ID__` | First-party | `Secure`, `HttpOnly`, `SameSite=Lax` (gorouter defaults) | Session | Sticky-session routing — pins a browser to a specific app instance for in-memory state continuity | **Strictly necessary** (operational) — set by the platform, not the application |

### 2.3 Third-party cookies set by the IdP during login

When the user clicks login, the AppRouter redirects to XSUAA, which redirects to the configured trust:
- **SAP ID Service** (default trust: `accounts.sap.com`) — sets its own session cookies on the `accounts.sap.com` domain
- **Optional IAS** (per [`docs/ias-migration-setup.md`](ias-migration-setup.md)) — sets cookies on the IAS tenant domain

These cookies are **not set by `developers.sap.com`** and are not in our control. They appear as third-party in the IdP popup but become first-party once the user is on the IdP origin. From a compliance standpoint they are part of the **authentication flow** and are strictly necessary; their cookie policy is governed by the IdP, not this app.

### 2.4 Third-party cookies from embedded content (deferred / on-click only)

The Hugo layouts include links to third-party services but **do not load them eagerly** — no SDKs, pixels, or iframes are embedded on page load:

| Service | Trigger | File |
|---------|---------|------|
| Facebook share | User clicks "Share on Facebook" — navigates to `facebook.com/sharer/sharer.php`. Sets Facebook cookies on the **destination tab**, not on `developers.sap.com`. | [`hugo/layouts/partials/feedback-share.html:55`](../hugo/layouts/partials/feedback-share.html#L55) |
| LinkedIn share | Same pattern — direct link, no SDK. | [`hugo/layouts/partials/feedback-share.html:58`](../hugo/layouts/partials/feedback-share.html#L58) |
| Qualtrics survey | User clicks "Take our survey" — navigates to `sapinsights.eu.qualtrics.com`. Qualtrics sets its own analytics cookies on its domain. | [`hugo/layouts/partials/feedback-share.html:43`](../hugo/layouts/partials/feedback-share.html#L43) |
| YouTube embeds | **Not currently embedded by layouts.** CSP allows `frame-src https://www.youtube.com` ([`approuter/xs-app.json:6`](../approuter/xs-app.json#L6)) so a tutorial author *could* embed a YouTube video via raw HTML in markdown (Goldmark `unsafe = true` is enabled — see §4 risk note). YouTube would then set `VISITOR_INFO1_LIVE`, `YSC`, `__Secure-3PSID`, etc. on the user's browser. | Author-embedded |

**Compliance posture for §2.4:** Because the third-party requests only fire on explicit user action (click), there is no third-party storage *before* consent. EU regulators generally accept this "click-to-load" pattern as compliant without prior consent — but only for the static link case. Any move to embedded share widgets, tracking pixels, or auto-loaded YouTube iframes will trigger the consent requirement.

### 2.5 Cookies the application does **not** set

The following common categories are **absent** from this codebase:

- ❌ No analytics cookies (no Google Analytics, no Adobe Analytics tag in the public layouts — Adobe Analytics is server-side only via [`srv/lib/adobe-analytics.js`](../srv/lib/adobe-analytics.js))
- ❌ No marketing/advertising cookies
- ❌ No A/B testing cookies (no Optimizely, no LaunchDarkly client SDK)
- ❌ No CDN tracking cookies (Cloudflare `__cf_bm` could appear if CF Cloud Foundry routes through Cloudflare, but the eu10-005 SAP BTP region terminates TLS at gorouter)
- ❌ No application-level `res.cookie()` calls — confirmed via `Grep -r "res\.cookie|setHeader.*[Cc]ookie|Set-Cookie" srv/ approuter/`

---

## 3. Inventory — Browser Storage (`localStorage` and `sessionStorage`)

### 3.1 `localStorage` — persistent, survives browser close

| Key | Set by | Value | Purpose | Consent category |
|-----|--------|-------|---------|------------------|
| `theme` | [`hugo/layouts/partials/head.html:26,36`](../hugo/layouts/partials/head.html#L26) | `"light"` \| `"dark"` | Persists the user's theme preference across visits. Read on every page load to set `<html data-theme>` before paint (avoids flash of unstyled content). Falls back to `prefers-color-scheme` when not set. | **Functional** — user-explicit preference. Defensible as strictly necessary under GDPR ("services explicitly requested by the subscriber") because the user actively toggles it. |
| `theme` (Scanner Vue) | [`hugo/layouts/scanner-vue/list.html:22`](../hugo/layouts/scanner-vue/list.html#L22) | `"light"` \| `"dark"` | Same as above, scoped to the scanner-vue route. Same key as the main site, so the preference is shared across the whole origin. | **Functional** |

**Note:** No keys named `theme` are set anywhere else on the public surface. The Admin shell uses a different key (`sap-tutorials-admin-theme`, [`app/admin-shell/webapp/Component.js`](../app/admin-shell/webapp/Component.js)) — that's out of scope.

### 3.2 `sessionStorage` — per-tab, cleared on tab close

All `sessionStorage` use on the public surface is in the **Joule chat widget** ([`hugo/static/js/joule.js`](../hugo/static/js/joule.js)).

| Key | Set by | Value | Purpose | Consent category |
|-----|--------|-------|---------|------------------|
| `joule.config.v1` | [`joule.js:217,232`](../hugo/static/js/joule.js#L232) | JSON `{ ts, value: { enabled, model, … } }` | 60-second TTL cache of `/api/ChatConfig` response — avoids re-fetching the chat enablement config on every page navigation within the tab. | **Functional / strictly necessary** — required for the Joule chat feature the user has activated by opening the panel. |
| `joule.history` | [`joule.js:238,241,539`](../hugo/static/js/joule.js#L241) | JSON array of `{ role, content }` messages | Preserves the chat conversation across same-tab navigation so the user doesn't lose context when they click a tutorial link from inside the chat. Cleared via the chat overflow menu's "Clear" button. | **Functional** — directly enables the requested feature. |
| `joule.user.v1` | [`joule.js:350,367`](../hugo/static/js/joule.js#L367) | JSON `{ ts, value: { firstName, familyName, email, id } }` with 60-second TTL | Caches the authenticated user's profile (from `/auth/user`) so the chat panel can render personalized greetings without re-hitting the auth endpoint on every panel open. | ⚠️ **Functional, but contains personal data (PII).** See §4.1 below. |

### 3.3 Storage the application does **not** use

- ❌ No `localStorage` use in [`hugo/static/js/app-space.js`](../hugo/static/js/app-space.js), [`navigator.js`](../hugo/static/js/navigator.js), [`nav-dropdown.js`](../hugo/static/js/nav-dropdown.js), [`event-display.js`](../hugo/static/js/event-display.js), [`scanner-vue.js`](../hugo/static/js/scanner-vue.js)
- ❌ No `localStorage`/`sessionStorage` in any [`hugo-apps/src/`](../hugo-apps/src/) Vue components
- ❌ No storage in [`app/display-app/src/`](../app/display-app/src/)
- ❌ No storage in [`app/scanner/webapp/`](../app/scanner/webapp/) (UI5 scanner)
- ❌ No IndexedDB use (verified by `Grep -r "indexedDB|openDatabase"` — no matches on public surface)
- ❌ No Cache Storage / Service Worker registration on the public surface

---

## 4. Risks and Compliance Gaps

### 4.1 PII in `sessionStorage` — `joule.user.v1`

The Joule cache writes `{ firstName, familyName, email, id }` to `sessionStorage` ([`joule.js:367`](../hugo/static/js/joule.js#L367)). Email is **personal data** under GDPR Art. 4(1).

**Why this is acceptable today:**
- `sessionStorage` is per-tab and cleared when the tab closes
- The data already left the server in the `/auth/user` response — nothing new is exposed
- Joule is an authenticated feature; the user is logged in
- 60-second TTL bounds re-use

**Why a privacy review may flag it:**
- A shared / kiosk computer with multiple tabs could leak the email to anyone who opens DevTools in the same tab before the user closes it
- "Clear browsing data" UX expectations: users assume "log out" wipes their email from the browser, but it remains in `sessionStorage` until tab close (the chat's "Clear" overflow only removes `joule.history`, not `joule.user.v1`)

**Recommendation:** On logout, also clear `joule.config.v1` and `joule.user.v1`. Consider whether storing email is needed at all — `firstName` alone is enough for the greeting.

### 4.2 Author-injected third-party content (Hugo `unsafe = true`)

[`hugo/hugo.toml`](../hugo/hugo.toml) sets Goldmark `unsafe = true`, allowing raw HTML in tutorial markdown. The CSP at [`approuter/xs-app.json:6`](../approuter/xs-app.json#L6) allows `frame-src https://www.youtube.com` and broad `img-src` (including `data:`).

**Risk:** A tutorial author can embed:
- A YouTube `<iframe src="youtube.com/embed/...">` — sets YouTube cookies on first paint
- A `<script>` tag (CSP currently allows `'unsafe-inline'` — see [TODO.md §14.2](TODO.md#L289))
- An `<img src="https://tracker.example/pixel.gif">` — sets third-party cookies

**Compliance impact:** Any of these would create cookie-setting before consent. This is the **largest unbounded risk** on the public surface — it depends entirely on what authors write in markdown.

**Mitigation options:**
1. Add an HTML sanitizer to the Hugo write path that strips `<iframe>`, `<script>`, `<object>`, and external `<img src>` (already on TODO §14.2 for XSS, double-duty for cookie compliance)
2. Use [youtube-nocookie.com](https://www.youtube-nocookie.com) embeds (no cookie until play) and update CSP `frame-src` accordingly
3. Document an authoring style guide that prohibits direct iframe embeds

### 4.3 No consent banner exists today

The site sets the `theme` cookie/storage on first visit without prompting, and authenticated routes set session cookies on login. EU regulators generally accept these as **strictly necessary** (theme is user-functional; auth session is essential). However:

- There is **no public cookie policy page** linked from the footer ([`hugo/layouts/partials/footer.html`](../hugo/layouts/partials/footer.html))
- There is **no privacy policy** page (the GDPR transparency obligation, Art. 13, requires informing users about all storage even when consent isn't required)
- There is **no consent UI** — meaning the moment a non-essential cookie is added (analytics, marketing), the site becomes non-compliant

**Recommendation:** Even before adding analytics, publish:
1. A **cookie policy** page enumerating the inventory in §2 and §3 of this document, with purposes, lifetimes, and the legal basis for each
2. A **privacy policy** page covering personal data flows (auth, progress tracking, audit logs from [`@cap-js/audit-logging`](../db/audit-logging.cds))
3. Footer links to both, on every page

This unblocks the future decision about analytics/marketing without rushing the consent banner build.

### 4.4 Future-proofing for analytics

When analytics is added (Adobe Analytics tag, Matomo, or similar):
- Server-side analytics routes data through [`srv/lib/adobe-analytics.js`](../srv/lib/adobe-analytics.js) — no client-side cookies. **Preferred** from a consent standpoint.
- Client-side analytics tags (`gtag.js`, Adobe Launch) **always** set non-essential cookies and cannot be loaded before granular consent.

---

## 5. Compliance Posture Summary

| Question | Answer |
|----------|--------|
| Does the public surface set any non-essential cookies today? | **No** (verified: no `res.cookie` in code, no analytics tags in layouts, share buttons are click-to-navigate) |
| Does it use any non-essential `localStorage` / `sessionStorage`? | **Probably no** — `theme` is functional, Joule storage is part of an explicitly-invoked feature. A privacy lawyer should confirm classification. |
| Does it have a cookie policy? | **No** — gap |
| Does it have a privacy policy? | **No** — gap |
| Does it have a consent banner? | **No** — not currently required (no non-essential storage), but required before analytics/marketing |
| Are there latent risks from author-injected content? | **Yes** — Hugo `unsafe = true` allows raw iframes/scripts in tutorials |
| Does logout clear all client state? | **Partially** — XSUAA logout clears auth cookies but `joule.user.v1` (PII) remains in `sessionStorage` until tab close |

**Bottom line:** The public surface is **probably compliant today** under a "strictly necessary" reading, but lacks the transparency artifacts (cookie policy, privacy policy) that GDPR Art. 13 requires *regardless* of whether consent is needed. Addressing the gaps in §4.3 should be the first deliverable, ahead of any consent banner implementation.

---

## 6. Recommended Next Actions

Ordered by impact and dependency, suitable for the work tracked in [TODO.md §21 — Cookie usage report & consent banner](TODO.md#L549).

1. **Validate this inventory with privacy/legal** — confirm the §2/§3 entries and their proposed consent classifications.
2. **Publish a cookie policy page** at `/cookies` linked from the footer, listing the entries from §2 and §3.
3. **Publish a privacy policy page** at `/privacy` covering the personal data lifecycle (account, progress tracking, audit logs).
4. **Fix the Joule logout gap (§4.1)** — clear `joule.user.v1` and `joule.config.v1` on logout / on `/auth/user` returning unauthenticated.
5. **Sanitize tutorial HTML (§4.2)** — close the unbounded author-content risk before it becomes a compliance issue. This is also already on the security TODO.
6. **Pick a consent banner library compatible with the existing CSP** — when analytics or marketing are introduced. Self-hosted, nonce-friendly options preferred (Klaro!, CookieConsent v3, or a lightweight in-house build). Ensure "reject all" is at least as easy as "accept all" (TTDSG / EDPB guidance).
7. **Document a tutorial authoring style guide** prohibiting direct third-party embeds, recommending `youtube-nocookie.com` and avoiding pixel trackers.

---

## 7. Verification Method

This inventory was produced by:

- `Grep` over [`approuter/`](../approuter/), [`srv/`](../srv/), [`hugo/`](../hugo/), [`hugo-apps/src/`](../hugo-apps/src/), [`app/display-app/src/`](../app/display-app/src/), and [`app/scanner/`](../app/scanner/) for the patterns: `localStorage`, `sessionStorage`, `document.cookie`, `Set-Cookie`, `res.cookie`, `setHeader.*[Cc]ookie`, `cookie-parser`, `express-session`, `iframe`, `embed`, `gtag`, `analytics`, `youtube`
- Reading [`approuter/xs-app.json`](../approuter/xs-app.json) and [`approuter/server.js`](../approuter/server.js) for AppRouter route configuration and CSP
- Reading [`hugo/layouts/partials/head.html`](../hugo/layouts/partials/head.html), [`feedback-share.html`](../hugo/layouts/partials/feedback-share.html), and [`hugo/layouts/scanner-vue/list.html`](../hugo/layouts/scanner-vue/list.html) for inline storage and third-party links
- Reading [`hugo/static/js/joule.js`](../hugo/static/js/joule.js) for chat-widget storage

**Excluded by design:** Admin UI shell and admin Fiori Elements components — these are authenticated tooling for staff, not public-facing, and have a separate consent posture (workplace privacy law rather than ePrivacy Directive).

A live verification (DevTools → Application → Cookies + Storage) on a deployed instance should be performed to confirm the AppRouter cookie names and flag values from §2.1 — those depend on the `@sap/approuter` runtime version and cannot be derived from source code alone.
