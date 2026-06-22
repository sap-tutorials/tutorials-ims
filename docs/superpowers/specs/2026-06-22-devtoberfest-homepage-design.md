# Devtoberfest Homepage — Design Spec

**Date:** 2026-06-22
**Issue:** [#397 — Create a Devtoberfest Homepage](https://github.com/sap-tutorials/tutorials-ims/issues/397)
**Author:** Claude (with Tom Jung)
**Status:** Approved by Tom; spec-reviewer pending

---

## 1. Goal

Replace `developers.sap.com/devtoberfest.html` (legacy AEM page) with a homepage inside the tutorial system that:

- Welcomes visitors with Devtoberfest branding (Kasimir the Cat, SAP TechEd, Devtoberfest wordmarks)
- Lets ANY visitor (logged-out included) see the page
- Offers a single prominent **Join the Fest** action
- Auth-gates the join action (login via the site's existing header — no custom auth UX)
- Records each user as "joined this year's Devtoberfest" exactly once, with audit trail
- Presents legal Contents Rules as a scroll-to-enable T&C dialog before recording the join
- Surfaces navigation tiles for four future sub-pages (Rules, Activities/Weeks, FAQ, Gameboard) — empty links render as disabled "Coming soon" affordances until each sub-page ships

Reference for information scope: <https://community.sap.com/t5/devtoberfest/gh-p/Devtoberfest> (blogs/discussions excluded).

## 2. Non-goals

- Activity tracking, points-per-week scoring engine, gameboard logic (future PRs)
- Real Kasimir / TechEd / Devtoberfest artwork (placeholder SVGs ship; art swap is a file-only change later)
- Email/notification on join (audit-log SecurityEvent is the only artifact)
- Per-year migration tooling (admin manually creates the new Event row and points DevtoberfestConfig at it each year)

## 3. Visual direction (approved)

**Retro arcade × Fiori Horizon × Joule colors.**

- **Foundation:** Horizon CSS tokens (`var(--sapList_Background)`, `var(--sapTextColor)`, `var(--sapLinkColor)`); '72' font stack; UI5 web components for buttons, dialog, message-strip
- **Joule accent:** linear-gradient(90deg, #0070f2 → #7858ff) as the header background (same gradient Joule chat uses); dark-mode variant uses #1b90ff → #9d83ff
- **Arcade overlay:**
  - Monospace ('72-mono') only on tags, side-rail labels, the subheader strip ("▶ READY_PLAYER_1"), date countdown
  - ▶ glyphs on tags and rail items
  - CRT scanline texture (very low opacity) over the gradient header
  - Drop-shadow glow on Kasimir + dark-mode CTA buttons (Joule purple/blue tint)
  - Hard-shadow buttons in light mode (sticker-pack feel); glow CTAs in dark mode
  - Section names use lowercase nouns ("the rules", "the weeks") — no enterprise vocabulary
- **Light/dark mode parity:** every color flows through Horizon tokens; theme switch is one body-attribute flip. WCAG-AA contrast preserved in both modes (tag pill backgrounds invert per mode).

## 4. Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│  Browser                                                             │
│  ┌──────────────────┐    ┌────────────────────┐                      │
│  │ /devtoberfest/   │───▶│ devtoberfest Vue   │                      │
│  │ (Hugo static)    │    │ island             │                      │
│  └──────────────────┘    └─────────┬──────────┘                      │
│   shellbar (existing) provides auth UI in top-right ─────────┐       │
│                                    │ GET /api/devtoberfest/status    │
│                                    │ GET /api/devtoberfest/terms     │
│                                    │ POST /api/devtoberfest/join     │
│                                    │ GET /api/devtoberfest/me        │
└────────────────────────────────────┼──────────────────────────┬──────┘
                                     ▼                          │
                              ┌────────────┐                    │
                              │ Approuter  │ /api/devtoberfest/ │
                              │            │  status,terms: pub │
                              │            │  join,me: XSUAA    │
                              └─────┬──────┘                    │
                                    ▼                            │
                              ┌────────────┐                    │
                              │ tutorials- │                    │
                              │ srv        │                    │
                              └─────┬──────┘                    │
                                    ▼                            │
                              ┌────────────┐                    │
                              │   HANA     │                    │
                              │   - Events ◀────────────────────┘
                              │   - DevtoberfestConfig (NEW)
                              │   - EventRegistrations (NEW)
                              └────────────┘
```

**Critical architectural call:** Tom asked NOT to create a new login experience. The Devtoberfest page lives inside the standard tutorial-system shellbar — the user avatar / login dropdown in the top-right is the only auth UI. When an anonymous user clicks "Join the Fest," the button shows an inline hint pointing at the shellbar; no bounce page, no custom redirect.

## 5. Data model

### 5.1 New entity: `DevtoberfestConfig`

Singleton (one row, fixed UUID). Pattern mirrors `ChatSettings` and `KnowledgeGraphSettings`.

Both `ChatSettings` and `KnowledgeGraphSettings` declare the entity with `key ID : UUID` and rely on a service-side `before('READ', '<Entity>', ...)` handler to defensively insert the singleton row if it's missing. They also add `@odata.singleton` to the **AdminService projection** (not the underlying entity) so the OData GET URL is `/admin/DevtoberfestConfig` rather than `/admin/DevtoberfestConfig(ID=...)`. This spec follows the same shape: bare entity in `db/devtoberfest.cds`, `@odata.singleton` on the AdminService projection in §9.5, defensive-init handler in admin-service.js per §5.1 below.

```cds
entity DevtoberfestConfig {
  key ID            : UUID;                        // hardcoded singleton id
  currentEvent      : Association to Events;
  termsText         : LargeString;                  // markdown body of the legal T&C
  termsVersion      : Integer default 1;            // bump forces re-acceptance flow
  contentRulesUrl   : String(500);                  // external full-rules link (optional)
  faqUrl            : String(500);                  // future sub-page (optional)
  gameboardUrl      : String(500);                  // future sub-page (optional)
  activitiesUrl     : String(500);                  // future "points per week" page (optional)
}
```

Defensive `before('READ')` handler in srv/admin-service.js auto-inserts the singleton if missing (matches `ChatSettings` pattern).

### 5.2 New entity: `EventRegistrations`

One row per (user, event) registration. The `@assert.unique.userEvent` makes the join idempotent.

```cds
@assert.unique.userEvent: [user, event]
entity EventRegistrations : cuid, managed, LegacyKeyed {
  user             : Association to Users @mandatory;
  event            : Association to Events @mandatory;
  joinedAt         : Timestamp;
  termsVersion     : Integer;
  termsAcceptedAt  : Timestamp;
}
```

The `legacyId` from `LegacyKeyed` is allocated by `getNextLegacyId('EventRegistrations', db)` (existing pattern in admin-service.js) on each insert. There's no IMS migration source for this entity — it's CAP-native. `legacyId` is here for forward-compat with the analytics + audit-log shape the rest of the schema follows; it does NOT carry meaning from any legacy system.

### 5.3 Existing entity: `Events`

Reused unchanged. Admin creates a new "Devtoberfest 2026" Event row with startDate/endDate, then sets `DevtoberfestConfig.currentEvent` to point at it.

### 5.4 HDI migration

CDS build emits clean `hdbmigrationtable` files for both new entities with `version=1` (additive, no ALTER). Pre-stage `db/last-dev/csn.json` regen at commit time (per memory `feedback_cds_build_staging_check_csn_diff`).

## 6. Service surface

| Path | Method | Auth | Returns / Body |
|---|---|---|---|
| `/api/devtoberfest/status` | GET | Public (no XSUAA) | `{ event, joined, termsVersion, termsRequired, contentRulesUrl, faqUrl, gameboardUrl, activitiesUrl }` |
| `/api/devtoberfest/terms` | GET | Public | `{ text, version }` — termsText rendered HTML + current version |
| `/api/devtoberfest/join` | POST | XSUAA (auth required) | Body: `{ termsVersion }`. Returns 201/409/412/401/503. Creates EventRegistration. |
| `/api/devtoberfest/me` | GET | XSUAA | `{ joined, joinedAt, termsVersion }` — used by island to refresh state post-join |
| `/admin/DevtoberfestConfig` | GET/PATCH | XSUAA Admin (CAP scope) | Singleton config for the admin tile |
| `/admin/EventRegistrations` | GET | XSUAA Admin | Read-only audit table for the admin tile |

### 6.1 `/api/devtoberfest/status` response shapes

| Scenario | Response |
|---|---|
| No event configured | `503` `{ error: 'EVENT_NOT_CONFIGURED' }` (island renders "Devtoberfest hasn't started yet") |
| Anonymous user | `200` `{ event, joined: false, termsVersion, termsRequired: true, ...subUrls }` |
| Authenticated, not registered | `200` same shape, `joined: false` |
| Authenticated, registered | `200` `{ event, joined: true, termsVersion, termsRequired: false, ...subUrls }` |

### 6.2 `/api/devtoberfest/join` error codes

| Code | Meaning |
|---|---|
| `201` | Registration row created |
| `400` | Body missing/invalid termsVersion |
| `401` | Anonymous (user must use shellbar to log in) |
| `403` | User not present in Users table (defensive — shouldn't happen post-login) |
| `409` | Already joined (idempotent — frontend treats as success) |
| `412` | Submitted termsVersion ≠ current termsVersion (terms were bumped between status-read and join-POST; client must re-read) |
| `503` | DevtoberfestConfig.currentEvent NULL (no event configured) |

The 412 path only fires for **unregistered users mid-flow** (admin bumped termsVersion after the dialog loaded but before the user clicked Accept). Users **already registered** under a previous termsVersion are NOT auto-prompted to re-accept on later visits — see §13's "Mid-year terms update" note. A future "force re-acceptance for stale termsVersion" flow would be a separate PR.

The handler uses PR #557's `resolveUser(req, cds)` helper for robust auth resolution (handles the multer / async-context scope drops seen in deployed XSUAA paths).

Audit-log emission on successful join: `audit.log('SecurityEvent', { data: { action: 'DevtoberfestJoin', sapId, eventId, termsVersion } })`. Same shape as `_executeAnonymization` from PR #554.

## 7. Public homepage

### 7.1 File layout

```text
hugo/
  content/devtoberfest/_index.md           ← front-matter only
  layouts/devtoberfest/list.html           ← mount point + noscript fallback
  static/images/devtoberfest/              ← placeholder SVGs (real art later)
    kasimir.svg                            ← cat emoji 🐱 in styled SVG circle
    teched-logo.svg                        ← plain "SAP TechEd" wordmark
    devtoberfest-logo.svg                  ← plain "Devtoberfest" wordmark
hugo-apps/
  src/devtoberfest/
    DevtoberfestHome.vue                   ← main component
    TermsDialog.vue                        ← T&C dialog (separate for clarity)
    types.ts                               ← shared types
    main.ts                                ← mount glue
```

### 7.2 Page anatomy

```text
┌──────────────────────────────────────────────────────────────────────┐
│  [existing site shellbar — Login/user menu in top-right]            │
├──────────────────────────────────────────────────────────────────────┤
│  Joule gradient header (Kasimir + DEVTOBERFEST + Join CTA)           │
│  ▶ READY_PLAYER_1                         OCT 1 — OCT 28             │
├──────────────────────────────────────────────────────────────────────┤
│  Body (1fr + 120px rail)                                             │
│  ┌─────────────────────────────┐  ┌──────────────────────────────┐  │
│  │ Welcome, friend             │  │ └ THE RULES                  │  │
│  │ Four weeks of tutorials...  │  │ └ THE WEEKS                  │  │
│  │ ▶ ABAP ▶ CAP ▶ BTP ...      │  │ └ FAQ                        │  │
│  │ [post-join MessageStrip]    │  │ └ GAMEBOARD                  │  │
│  └─────────────────────────────┘  └──────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### 7.3 State machine

| State | When | Header CTA | Body banner |
|---|---|---|---|
| `loading` | initial mount | placeholder skeleton | empty |
| `event-missing` | `/status` returns 503 | disabled "Coming soon" | "Devtoberfest hasn't started yet" |
| `anonymous` | logged-out | "Join the Fest" with inline hint "Log in via the user menu →" | none |
| `unregistered` | logged-in, no EventRegistration row | "Join the Fest" (active, opens T&C dialog) | none |
| `registered` | logged-in, joined | "You're in! 🎉" disabled | green ui5-message-strip: "Welcome aboard. See the gameboard." |

### 7.4 Sub-page rail

Rail items source URLs from `DevtoberfestConfig.{contentRulesUrl, faqUrl, gameboardUrl, activitiesUrl}`. Empty config field → rail item renders as `<button disabled>` with a "Coming soon" tooltip. Admin fills the URL when the corresponding sub-page ships — no homepage redeploy needed.

This is intentional: Tom plans to brainstorm sub-page content with the team after this PR ships. The homepage demos as a working draft, then each sub-page becomes its own small PR.

### 7.5 Approuter route

```json
{
  "source": "^/devtoberfest(/.*)?$",
  "destination": "srv-api",
  "target": "/devtoberfest$1",
  "authenticationType": "none"
}
```

`authenticationType: none` so anonymous users can see the page. Same pattern as `/tutorials/*` and `/api/advocates*`.

## 8. T&C dialog

### 8.1 Component (`TermsDialog.vue`)

Sub-component mounted inside `DevtoberfestHome.vue`. Opens when `dialogOpen.value === true`.

Visual structure (matches the approved option B):
- Joule gradient header carries from the homepage: Kasimir + "DEVTOBERFEST · CONTENTS RULES" + version
- Scrollable body renders the markdown text from `/api/devtoberfest/terms`
- Footer: scroll-progress bar + percentage + "Accept & Join" button (disabled until ≥95% scroll)

### 8.2 Scroll-to-enable mechanic

```ts
const scrollPercent = ref(0)
const canAccept = computed(() => scrollPercent.value >= 95)

function onScroll(e: Event) {
  const el = e.target as HTMLElement
  const { scrollTop, scrollHeight, clientHeight } = el
  const max = scrollHeight - clientHeight
  scrollPercent.value = max <= 0 ? 100 : Math.min(100, Math.round((scrollTop / max) * 100))
}
```

- **Threshold is 95%, not 100%** — defends against sub-pixel scroll quirks (Safari/Firefox occasionally land short of 100 even when scrolled to bottom).
- **Edge case: content fits without scrolling.** If `scrollHeight <= clientHeight`, percent is set to 100 immediately, button enables on render. The worst UX is a button that can never enable; we err toward enabling.

### 8.3 POST flow

User clicks "Accept & Join" (only enabled at ≥95% scroll) → `POST /api/devtoberfest/join { termsVersion }`. Handling per response code:

| Response | UX |
|---|---|
| 201 | Close dialog, refresh state, show post-join MessageStrip |
| 409 | "You're already registered" toast, close, refresh to `registered` |
| 412 | "Terms updated — please re-read" toast, reload terms, reset scroll to top |
| 401 | "Please log in" toast (user needs to use shellbar), close dialog |
| 5xx | "Something went wrong, try again" toast, keep dialog open |

## 9. Admin tile

### 9.1 Side-nav

New entry **"Devtoberfest"** under the **System** group in [app/admin-shell/webapp/view/Shell.view.xml](app/admin-shell/webapp/view/Shell.view.xml), positioned adjacent to other System config tiles (alphabetical after "Account Merges", before "Change Log").

### 9.2 Tile structure

Two views via a sub-tab strip at the top:

```text
┌─────────────────────────────────────────────────────────────────────┐
│  [ Configuration ]   [ Registrations (1,247) ]                     │
├─────────────────────────────────────────────────────────────────────┤
│  ... selected view body ...                                         │
└─────────────────────────────────────────────────────────────────────┘
```

Single Vue/UI5 component at `app/admin/devtoberfest/`. Uses `sap.m.IconTabBar` + `sap.fe.templates.ListReport` for the Registrations view. Same lazy-load pattern as existing tiles.

### 9.3 Configuration view

- **Current Event:** combobox value-help → `AdminService.Events`. Read-only display of startDate/endDate from selected Event.
- **T&C section:** `termsVersion` (editable Integer) + `termsText` (`<ui5-textarea rows="20">` in monospace font for markdown editing). Yellow MessageStrip warning when termsVersion is edited: "Bumping the version will force every registered user to re-accept the new terms on their next login."
- **Sub-page links:** four optional URL fields (Content Rules, FAQ, Gameboard, Activities). Empty = rail item disabled on homepage.
- Save / Discard buttons. Standard ui5-toast on success.

### 9.4 Registrations view

`sap.fe.templates.ListReport` on `AdminService.EventRegistrations`. Read-only — Capabilities locked (same pattern as PR #552 Account Merges and PR #554 Privacy Audit).

LineItem: `joinedAt`, `user.email`, `user.sapId`, `event.name`, `termsVersion`. SelectionFields: event filter, joinedAt date range, termsVersion. Default sort: `joinedAt DESC`.

No bulk-delete action — audit data, never bulk-deleted without legal-hold review. Removal of an individual registration goes through SQL via a one-shot script if ever needed (same policy as Privacy Audit in PR #554).

### 9.5 Service-side wiring

Added to [srv/admin-service.cds](srv/admin-service.cds):

```cds
@odata.singleton
@requires: 'Admin'
entity DevtoberfestConfig as projection on ims.DevtoberfestConfig;

@readonly
entity EventRegistrations as projection on ims.EventRegistrations;
```

`EventRegistrations` is `@readonly` at the AdminService projection — writes only happen through `/api/devtoberfest/join` which inserts directly against the underlying entity (bypassing the read-only projection).

### 9.6 Annotations

Added to [app/admin-annotations.cds](app/admin-annotations.cds) — value-help for the `event` field, labels for both entities. Same pattern as recent admin tiles.

## 10. Testing strategy

### 10.1 Unit tests (in-memory SQLite)

| File | Coverage |
|---|---|
| `test/unit/devtoberfest-config-schema.test.js` | Singleton invariant: only one row inserts; second insert fails. Default `termsVersion=1`. |
| `test/unit/devtoberfest-status-handler.test.js` | `/status` shape for: event-missing, anonymous, authenticated unregistered, authenticated registered. |
| `test/unit/devtoberfest-join-handler.test.js` | All response codes: 401 anonymous, 412 termsVersion mismatch, 503 currentEvent NULL, 409 duplicate, 201 happy path. |
| `test/unit/devtoberfest-registration-unique.test.js` | `@assert.unique.userEvent` rejects duplicate (user, event). |
| `test/unit/devtoberfest-terms-handler.test.js` | `/terms` returns rendered HTML + version. Empty `termsText` returns `{ text: '', version: N }` (not 404). |

### 10.2 Hybrid test (real HANA)

`test/hybrid/devtoberfest-registration-hana.test.js` — end-to-end: create Event, set Config, POST join, verify Registration row, idempotent re-join returns 409. Tagged `__TEST__` prefix on test data per `test/hybrid/_guard.js` rules.

### 10.3 Smoke test (deployed DEV)

`test/smoke/devtoberfest.smoke.test.js` — `GET /devtoberfest/` returns 200 + expected HTML; `GET /api/devtoberfest/status` returns valid JSON; `GET /api/devtoberfest/terms` returns valid shape; `POST /api/devtoberfest/join` without auth returns 401.

### 10.4 Vue island

Per PR #559 precedent: server-side unit tests cover regression-bearing logic; Vue rendering verified manually on live deploy. The KG sidebar test investment in PR #559 hit a Vue 3 + happy-dom reactivity gap that wasn't worth chasing. Same trade-off here — render assertions are simple template edits; live verify is right ROI.

## 11. Files touched

### 11.1 New files

```text
db/devtoberfest.cds                                       ← new entity definitions
hugo/content/devtoberfest/_index.md                       ← Hugo page front-matter
hugo/layouts/devtoberfest/list.html                       ← mount + noscript
hugo/static/images/devtoberfest/{kasimir,teched-logo,devtoberfest-logo}.svg
hugo-apps/src/devtoberfest/{DevtoberfestHome.vue,TermsDialog.vue,types.ts,main.ts}
app/admin/devtoberfest/{package.json,ui5.yaml,webapp/{Component.js,manifest.json,view/Devtoberfest.view.xml,controller/Devtoberfest.controller.js}}
srv/lib/devtoberfest-handlers.js                          ← status, terms, join, me handlers
test/unit/devtoberfest-config-schema.test.js
test/unit/devtoberfest-status-handler.test.js
test/unit/devtoberfest-join-handler.test.js
test/unit/devtoberfest-registration-unique.test.js
test/unit/devtoberfest-terms-handler.test.js
test/hybrid/devtoberfest-registration-hana.test.js
test/smoke/devtoberfest.smoke.test.js
```

### 11.2 Modified files

```text
db/schema.cds                                             ← `using` for db/devtoberfest.cds (or move definitions in)
srv/admin-service.cds                                     ← DevtoberfestConfig + EventRegistrations projections
srv/admin-service.js                                      ← singleton defensive-init handler
srv/server.js                                             ← public + auth routes for /api/devtoberfest/*
app/admin-shell/webapp/{manifest.json,controller/Shell.controller.js,view/Shell.view.xml}
app/admin-shell/scripts/copy-components.js                ← add 'devtoberfest' to list
app/admin-annotations.cds                                 ← UI labels + value-help
approuter/xs-app.json                                     ← /devtoberfest/* public route
hugo-apps/vite.config.ts                                  ← new entry point for devtoberfest island
db/last-dev/csn.json                                      ← CDS build regen (committed in PR; not generated by CI)
db/src/com.sap.developers.ims.DevtoberfestConfig.hdbmigrationtable    ← v=1, committed in PR
db/src/com.sap.developers.ims.EventRegistrations.hdbmigrationtable    ← v=1, committed in PR
```

> The `db/last-dev/csn.json` + `hdbmigrationtable` artifacts are regenerated locally via `npx cds build --production` and **committed as part of this PR**, not generated by CI. The CI `check-cds-build-staging` job verifies they match what a fresh `cds build --production` would produce — drift fails the build. Per memory `feedback_cds_build_staging_check_csn_diff`.

## 12. Out of scope (deferred to future PRs)

- Real Kasimir / TechEd / Devtoberfest artwork (file-swap when art lands)
- Content rules sub-page (URL field empty until ready)
- FAQ sub-page
- Gameboard sub-page
- Activities / points-per-week sub-page
- Weekly activity tracking + points/scoring engine
- Per-year automation (admin manually creates Event + flips currentEvent each year)
- Notification on join (audit-log SecurityEvent is the only artifact today)

## 13. Operational notes

- **First-time setup after deploy:** admin opens `/admin-ui/#devtoberfest-display` → creates a "Devtoberfest 2026" Event row in the Events tile → returns to Devtoberfest tile → sets `currentEvent` → pastes the legal Contents Rules into `termsText` → sets `termsVersion = 1` → saves. Homepage is now live.
- **Mid-year terms update:** admin edits `termsText` + bumps `termsVersion` → existing registered users with `termsVersion < currentVersion` are NOT auto-prompted; they see no change until they revisit `/devtoberfest/`. (Not in current scope; could be added later as a one-time re-acceptance flow.)
- **Year rollover:** admin creates "Devtoberfest 2027" Event row, repoints `currentEvent`. All previous year's `EventRegistrations` rows remain — they're audit data tied to the previous Event row. Year-on-year registrations are independent rows.

## 14. Decision log (from brainstorming)

1. **Registration model:** Dedicated `EventRegistrations` entity (vs. extending TaskRecords or Users.devtoberfestYears array). Audit trail + clean semantics.
2. **Current-event selection:** Singleton `DevtoberfestConfig` with `currentEvent` FK + room to grow (sub-page URLs today, weekly activities/points later). Admin-managed.
3. **T&C storage:** Inline `termsText` + `termsVersion` on DevtoberfestConfig (vs. Hugo content file or external URL). Self-contained, version-audited.
4. **Layout direction:** Option B (banner + content + side rail) with retro-arcade × Joule × Horizon fusion. Not corporate.
5. **T&C dialog:** Branded header with scroll-progress bar (option B in the dialog mockups). Gate feels like game mechanic, not barrier.
6. **Auth flow:** Public island + auth-gated POST. NO custom auth UX — the site's existing shellbar (top-right user menu) provides Login/avatar. Inline hint when anonymous user clicks Join.
7. **Admin UI:** Single Devtoberfest tile with two sub-tab views (Configuration + Registrations).
