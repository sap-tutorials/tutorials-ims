# Khoros community-profile linkage on `/me`

**Issue:** [sap-tutorials/tutorials-ims#566](https://github.com/sap-tutorials/tutorials-ims/issues/566) · **Date:** 2026-06-26 · **Status:** brainstormed → design approved → spec review

## Problem

Today the `Users` entity (`db/schema.cds:115`) captures SAP IDP identity (`sapId`, `uuid`, `email`, `firstName`, `lastName`) but has no link to a user's [SAP Community](https://community.sap.com) profile. There is no way for a tutorial user to surface their community presence on `/me`, no way for future event/Devtoberfest features to credit community activity, and no way for the nav-dropdown to show a real avatar instead of initials. Issue #566 asks us to fix the foundation.

## Scope

**In scope (v1):**

1. Schema delta on `Users` to store the community link.
2. `/me` page: claim/unlink UI in a new "SAP Community profile" sub-section inside the Learning Preferences panel, plus a three-collapsible-panel layout refresh.
3. Three new `DeveloperService` endpoints (`setKhorosLink`, `clearKhorosLink`, `getKhorosProfile`) and an augmented `/auth/user` response.
4. Top-right nav-dropdown: swap initials for the community avatar when linked; add a "View community profile ↗" deep-link in the popover.
5. Admin Accounts UI: read-only Khoros columns + a "Clear Khoros link" bound action.
6. Documentation (architecture page, gotcha entries, end-user page).

**Explicitly out of scope (each → own follow-up issue):**

- Devtoberfest-style consumers (community posts auto-crediting mission completion).
- Surfacing other users' Khoros profiles on leaderboards / scanner / event-display / advocates / public profiles.
- Polling/refresh of badge counts or blog counts.
- Author-side: linking author records to Khoros profiles.
- Server-side persistence of `/me` panel collapse state (local-storage only for v1).
- A `KhorosLinkedUsers` analytics view.
- Khoros user search-as-you-type / fuzzy lookup.
- Admin **set-on-behalf-of** another user's Khoros link (Q9b decision — admin can clear only).

## Why "Khoros" in the schema, not "Community"

Khoros is the underlying community platform vendor today. Tom's prompt called this out: name the DB columns `khoros*`, never user-visible. User-facing labels say "SAP Community profile". If the platform changes (e.g. to Discourse), we add `discourseId`/`discourseLogin` columns alongside the existing `khoros*` columns and run them in parallel for the cutover — same playbook as `legacyId` (Java IMS) coexisting with `ID` (CAP).

## Decisions log (questions answered during brainstorming)

| # | Question | Decision |
|---|---|---|
| 1 | What does the link unlock in v1? | Display only. Foundation for future Devtoberfest features. |
| 2 | Verification strength on claim | Existence check only (no anti-impersonation, no SSO link). |
| 3 | Input shape | One smart field that accepts numeric ID or login slug. |
| 4 | Where does the claim UI live? | Inside the Learning Preferences panel, own Link/Unlink buttons. |
| 4b | Panel layout | Three collapsible panels: Learning Preferences (with Khoros) → Recent Activity → All Completions. |
| 5 | Visibility beyond `/me` | Linked-user fields on `/auth/user`; nav-dropdown avatar swap; "View community profile ↗" link in dropdown. No public exposure of other users' links. |
| 6 | Schema shape | Four flat columns on `Users`: `khorosId`, `khorosLogin`, `khorosAvatarUrl`, `khorosLinkedAt`. |
| 7 | Refresh strategy | Server-side LRU cache, 6h TTL; avatar persisted; rank fetched on demand, never stored. |
| 8 | "How do I find my community ID?" | Inline expander (summary + screenshot) with outbound link to `developers.sap.com/tutorials/community-profile.html`. |
| 9a | Admin: view + clear another user's link? | Yes — read-only columns + "Clear Khoros link" action. |
| 9b | Admin: set another user's link on their behalf? | No — deferred to v2. |

## Reference implementation

Tom pointed at [`D:/projects/sap-community-activity-badges`](https://github.com/SAP-samples/sap-community-activity-badges) — an existing SAP-samples repo that already solves Khoros user lookup. Two pieces we port verbatim into a new `srv/lib/khoros-client.js`:

1. **The numeric-vs-slug fingerprint** in [`srv/util/khoros.js::callUserAPI`](https://github.com/SAP-samples/sap-community-activity-badges/blob/main/srv/util/khoros.js): try `author.id` first when input matches `/^\d+$/`; else try `author.login` with `dot→underscore` normalisation; else try the dotted form unchanged.
2. **The `messages.author.*` field expansion**: as of mid-2026, anonymous direct user reads against `community.sap.com/khhcw49343/api/2.0/users/:id` return `404` (Khoros revoked `allow_restapi_call_read` for the anonymous user). The reference repo's workaround — `SELECT author.id, author.login, ... FROM messages WHERE author.id = '<id>' LIMIT 1` against `/api/2.0/search` — is the only public-tier surface and **the only path we can use without a Khoros service principal**.

The host segment `khhcw49343` is a Khoros tenant prefix and has historically been rotated; `khoros-client.js` MUST hold it as a single named constant (e.g. `KHOROS_TENANT_PREFIX`) so a future rotation is a one-line change.

**Critical implication:** users with zero community posts are unfindable. We surface this in the `not-found` error copy.

The port from the reference repo also flips the HTTP client: `then-request` → Node.js native `fetch`, per the project's `[CLAUDE.md > Prefer Node.js native fetch]` rule.

## Architecture

### Component boundary diagram

```text
┌─────────────────────── Browser (/me) ───────────────────────┐
│                                                              │
│  Hugo layout (3 ui5-panels, collapse state in localStorage)  │
│    ├─ Panel 1: Learning Preferences                          │
│    │    ├─ LearningPreferences.vue   (existing — unchanged)  │
│    │    └─ CommunityProfile.vue      (NEW)                   │
│    │           ↓ fetch /api/getKhorosProfile()                │
│    │           ↓ POST /api/setKhorosLink                      │
│    │           ↓ POST /api/clearKhorosLink                    │
│    ├─ Panel 2: Recent Activity                               │
│    │    └─ RecentActivity.vue        (NEW — split from old)  │
│    └─ Panel 3: All Completions                               │
│         └─ AllCompletions.vue        (RENAMED from old)      │
│                                                              │
│  Nav-dropdown (existing island)                              │
│    └─ reads khorosAvatarUrl + khorosLogin from /auth/user    │
└──────────────────────────────────────────────────────────────┘
                       ↓
┌─────────────────── CAP backend (srv/) ──────────────────────┐
│                                                              │
│  DeveloperService                                            │
│    ├─ setKhorosLink(input)   ─→ khoros-client → DB UPDATE    │
│    ├─ clearKhorosLink()      ─→ DB UPDATE (4 cols → NULL)    │
│    └─ getKhorosProfile()     ─→ khoros-cache → khoros-client │
│                                                              │
│  AdminService                                                │
│    └─ clearKhorosLink(userId) bound action                   │
│                                                              │
│  /auth/user (existing express handler)                       │
│    └─ adds 3 khoros* fields to response                      │
│                                                              │
│  srv/lib/khoros-client.js  (NEW, pure)                       │
│    └─ resolveUser(input) → { id, login, name, rank, avatar } │
│                                                              │
│  srv/lib/khoros-cache.js   (NEW, pure)                       │
│    └─ Map-backed LRU, 6h TTL, ~500 entry cap                 │
└──────────────────────────────────────────────────────────────┘
                       ↓
                community.sap.com/khhcw49343/api/2.0/search
                  (anonymous, messages.author.* expansion only)
```

### Files created

| Path | Lines (est.) | Purpose |
|---|---|---|
| `srv/lib/khoros-client.js` | ~150 | Native-fetch port of reference repo's `callUserAPI`. Stateless. |
| `srv/lib/khoros-cache.js` | ~60 | Bounded LRU keyed by `khorosId`. |
| `hugo-apps/src/me/CommunityProfile.vue` | ~120 | Vue island, two visual states. |
| `hugo-apps/src/me/RecentActivity.vue` | ~80 | Extracted from `MyCompletions.vue` — timeline-only. |
| `hugo-apps/src/me/AllCompletions.vue` | ~270 | Renamed from `MyCompletions.vue` — table + toolbar only. |
| `test/unit/khoros-client.test.js` | ~150 | Mocked-fetch coverage of the fingerprint + fallbacks + canary. |
| `test/unit/khoros-cache.test.js` | ~60 | TTL, eviction, evict-on-unlink. |
| `test/unit/community-profile.test.ts` | ~180 | Vue island states. |
| `test/hybrid/khoros-link.test.js` | ~120 | Real HANA: link + unique constraint + clear + change-tracking. |
| `docs/developers/architecture/khoros-link.md` | ~150 | Architecture reference page. |
| `docs/end-users/me-page.md` | ~80 | User-facing page. |

### Files modified

| Path | Why |
|---|---|
| `db/schema.cds` | Four new columns on `Users` + `@assert.unique.khorosId`. |
| `db/audit-logging.cds` | Four field-level `@PersonalData.IsPotentiallyPersonal` annotations. |
| `srv/developer-service.cds` | Add 2 actions + 1 function (`setKhorosLink`, `clearKhorosLink`, `getKhorosProfile`). |
| `srv/developer-service.js` | Handlers for the three new endpoints. |
| `srv/admin-service.cds` | Add `clearKhorosLink(userId)` bound action. |
| `srv/admin-service.js` | Handler for admin clear. |
| `srv/server.js` | Add 3 `khoros*` fields to `/auth/user` response payload. |
| `app/admin-annotations.cds` | Read-only Khoros columns + action button on Users object page. |
| `hugo-apps/src/me/main.ts` | Mount 4 islands instead of 2; delete `MyCompletions` mount. |
| `hugo-apps/src/me/MyCompletions.vue` | **DELETED** — split into RecentActivity + AllCompletions. |
| `hugo/layouts/me/list.html` | 3 `ui5-panel` wrappers + 4 mount points + inline collapse-state script. |
| `hugo-apps/src/nav-dropdown/*` | Read `khorosAvatarUrl` + `khorosLogin` from `/auth/user`; render avatar `<img>` with onerror fallback to initials; add "View community profile ↗" menu item. |
| `hugo/assets/js/ui5-bootstrap.ts` | Register `Avatar` (currently unregistered; required by `CommunityProfile.vue`). |
| `docs/developers/reference/cap-cds-gotchas.md` | Append note on `@assert.unique` + nullable columns AND on `khorosId` unique vs `khorosLogin` non-unique. |
| `docs/.vitepress/config.ts` | Sidebar entry for new architecture + end-user pages. |

## Data model

### Schema delta — `db/schema.cds`

```cds
@assert.unique.sapId : [sapId]
@assert.unique.khorosId : [khorosId]   // NEW
entity Users : cuid, managed, LegacyKeyed {
  // ... existing fields unchanged ...
  khorosId         : String(32);    // numeric Khoros user id, e.g. "12345" — stable join key
  khorosLogin      : String(64);    // slug, e.g. "thomas_jung" — display / deep-link
  khorosAvatarUrl  : String(1000);  // hot-linked from khoros-mining S3 CDN
  khorosLinkedAt   : Timestamp;
}
```

### GDPR — `db/audit-logging.cds`

```cds
annotate ims.Users with {
  khorosId        @PersonalData.IsPotentiallyPersonal;
  khorosLogin     @PersonalData.IsPotentiallyPersonal;
  khorosAvatarUrl @PersonalData.IsPotentiallyPersonal;
  // khorosLinkedAt — not personal, no annotation
};
```

The existing `cascade: 'identity-replace'` on `Users` already walks `@PersonalData.IsPotentiallyPersonal` annotations and scrambles them on anonymisation. **Zero new code needed for GDPR.** The hybrid test asserts the cascade fires.

### Migration notes

- **All four columns nullable** — every existing user starts at `NULL`. No backfill, no migration script.
- **`@assert.unique.khorosId`** uses CAP's standard nullable-aware uniqueness: NULLs are distinct, so unlinked users don't collide. CAP returns 409 on second-claim; the handler converts to a friendly status enum.
- **No `@assert.unique` on `khorosLogin`** — slugs are not stable (Khoros has bulk-renamed them: `thomas.jung` → `thomas_jung`). Joining on a slug would silently break across a rename. `khorosId` is the stable key; `khorosLogin` is a label refreshed lazily.
- **No `KhorosLinkAudit` table** — the existing `@cap-js/audit-logging` plugin already captures every UPDATE to annotated `Users` fields. Free audit trail.
- **`cds build --production`** required before HDI deploy; see `[feedback_cds_build_production_not_cds_compile_for_last_dev]`.

## Server endpoints

### `POST /api/setKhorosLink(input: String)`

```cds
// srv/developer-service.cds
action setKhorosLink(input: String) returns {
  status     : String;   // 'ok' | 'not-found' | 'already-claimed' | 'invalid-input'
                         //        | 'upstream-unavailable' | 'persist-failed'
  khorosId   : String;
  khorosLogin: String;
  name       : String;
};
```

**Handler flow** (`srv/developer-service.js`):

1. Resolve user via `resolveUser(req, cds)` ([srv/lib/resolve-user.js](srv/lib/resolve-user.js)); 401 if none.
2. Trim input. Reject empty/oversized → `{ status: 'invalid-input' }`.
3. Call `khorosClient.resolveUser(input)`.
4. On 5xx upstream → `{ status: 'upstream-unavailable' }`. Log WARN.
5. On null upstream (zero items) → `{ status: 'not-found' }`.
6. Try `UPDATE Users SET khorosId=…, khorosLogin=…, khorosAvatarUrl=…, khorosLinkedAt=NOW() WHERE ID = $self`.
7. On unique-constraint violation → `{ status: 'already-claimed' }`.
8. On other DB error → `{ status: 'persist-failed' }`. Log ERROR.
9. Seed `khoros-cache` with the fresh profile object — same shape `getKhorosProfile` reads back (`{ name, rank, avatarUrl }`) so there's no field-name drift between writer and reader.
10. Return `{ status: 'ok', khorosId, khorosLogin, name }`.

### `POST /api/clearKhorosLink()`

```cds
action clearKhorosLink() returns { status: String };
```

`UPDATE Users SET khorosId=NULL, khorosLogin=NULL, khorosAvatarUrl=NULL, khorosLinkedAt=NULL WHERE ID = $self`. Idempotent (already-unlinked returns ok). Audit log captures the UPDATE.

### `GET /api/getKhorosProfile()`

```cds
function getKhorosProfile() returns {
  linked     : Boolean;
  khorosId   : String;
  khorosLogin: String;
  name       : String;
  rank       : String;
  avatarUrl  : String;
  profileUrl : String;
}
```

**Handler flow:**

1. Resolve user; 401 if none.
2. SELECT `Users.khorosId, khorosLogin, khorosAvatarUrl` for current user.
3. If `khorosId === null` → `{ linked: false }`. Done.
4. `khoros-cache.get(khorosId)` — on hit, return persisted fields + cached `rank`/`name` + computed `profileUrl`.
5. On miss, call `khorosClient.resolveUser(khorosId)`.
6. On null upstream (account deleted) → last-known-good: `{ linked: true, khorosLogin (from DB), avatarUrl (from DB), name: khorosLogin, rank: '' }`. Log WARN. **Do NOT surface to user.**
7. On 5xx upstream → same last-known-good fallback. Log WARN.
8. On success, refresh cache. If upstream `avatarUrl !== persisted`, write it back to `Users.khorosAvatarUrl` (keeps nav-dropdown current).
9. Return.

`profileUrl` is server-built: `https://community.sap.com/t5/user/viewprofilepage/user-id/${khorosId}`.

### `AdminService.clearKhorosLink(userId: UUID)`

Bound action on the `AdminService.Users` projection. `@requires: 'Tutorial.Admin'`. Same UPDATE as the per-user clearKhorosLink. `modifiedBy: <admin-email>` is captured by `@cap-js/audit-logging`.

### `/auth/user` augmentation

Three new fields added to the existing response payload in `srv/server.js` (~5 LOC). Read from the same `Users` row already fetched for `firstName`/`lastName` — no extra DB hit.

```json
{
  "...existing fields...": "...",
  "khorosId": "12345",
  "khorosLogin": "thomas_jung",
  "khorosAvatarUrl": "https://khoros-mining.s3.amazonaws.com/..."
}
```

All three are `null` for unlinked users — Vue islands and nav-dropdown render the unlinked state.

## Frontend

### Page layout (`hugo/layouts/me/list.html`)

```html
<h1>My Profile</h1>

<ui5-panel header-text="Learning Preferences" data-panel="preferences">
  <div id="me-learning-preferences"></div>
  <div class="me-section-divider"></div>
  <div id="me-community-profile"></div>
</ui5-panel>

<ui5-panel header-text="Recent Activity" data-panel="recent">
  <div id="me-recent-activity"></div>
</ui5-panel>

<ui5-panel header-text="All Completions" data-panel="all">
  <div id="me-all-completions"></div>
</ui5-panel>

<script type="module" src="/js/me.js?v={{ now.Unix }}"></script>
<script>
  // 6-line collapse-state persistence — runs after ui5-bootstrap.ts has registered Panel
  // ui5-panel's `collapsed` boolean attr is set imperatively per
  // [feedback_ui5_dialog_open_imperative_only] (template binding to boolean attrs is unreliable).
  customElements.whenDefined('ui5-panel').then(() => {
    document.querySelectorAll('ui5-panel[data-panel]').forEach((p) => {
      const key = `me.panel.${p.dataset.panel}`
      if (localStorage.getItem(key) === 'collapsed') p.collapsed = true
      // ui5-panel emits `toggle` when the user clicks the chevron; the event has
      // no detail payload — read `p.collapsed` after the event fires.
      // Verify against the @ui5/webcomponents version pinned in package.json
      // during planning (event name has not changed in v1.x/v2.x but worth a check).
      p.addEventListener('toggle', () => {
        localStorage.setItem(key, p.collapsed ? 'collapsed' : 'expanded')
      })
    })
  })
</script>
```

**Collapse state:** `localStorage` keys `me.panel.preferences`, `me.panel.recent`, `me.panel.all`. Default expanded for users with no key. Per-device, not synced.

### `hugo-apps/src/me/main.ts`

```ts
import { createApp } from 'vue'
import RecentActivity from './RecentActivity.vue'
import AllCompletions from './AllCompletions.vue'
import LearningPreferences from './LearningPreferences.vue'
import CommunityProfile from './CommunityProfile.vue'

// IMPORTANT: do NOT import "@ui5/webcomponents/*" here.
// All UI5 components used by these islands are registered in
// hugo/assets/js/ui5-bootstrap.ts. See [feedback_ui5_duplicate_bundle_kills_settheme].

if (document.getElementById('me-recent-activity'))
  createApp(RecentActivity).mount('#me-recent-activity')
if (document.getElementById('me-all-completions'))
  createApp(AllCompletions).mount('#me-all-completions')
if (document.getElementById('me-learning-preferences'))
  createApp(LearningPreferences).mount('#me-learning-preferences')
if (document.getElementById('me-community-profile'))
  createApp(CommunityProfile).mount('#me-community-profile')
```

### `CommunityProfile.vue` — two states in one component

```vue
<template>
  <section class="community-profile">
    <ui5-title level="H4">SAP Community profile <span class="badge-new">NEW</span></ui5-title>
    <ui5-text>Link your community.sap.com profile to show it on your /me page and beyond.</ui5-text>

    <div v-if="state === 'unlinked'" class="claim-row">
      <ui5-input v-model="input" placeholder="thomas_jung or 123456"
                 @keydown.enter="onLink" :disabled="busy" />
      <ui5-button design="Emphasized" @click="onLink" :disabled="busy || !input.trim()">
        {{ busy ? 'Verifying…' : 'Link profile' }}
      </ui5-button>
      <details class="help">
        <summary>How do I find my community ID?</summary>
        <p>Open your profile at community.sap.com. The URL ends with either
           <code>/user-id/123456</code> (numeric ID) or <code>/user/thomas_jung</code>
           (login slug). Either works — paste it here.</p>
        <a href="https://developers.sap.com/tutorials/community-profile.html" target="_blank">
          More about your community profile ↗
        </a>
      </details>
      <ui5-message-strip v-if="errorState" :design="errorDesign" hide-close-button>
        {{ errorMessage }}
      </ui5-message-strip>
    </div>

    <div v-else-if="state === 'linked'" class="linked-chip">
      <ui5-avatar size="S" shape="Circle">
        <img :src="profile.avatarUrl" :alt="profile.name" @error="onAvatarError" />
      </ui5-avatar>
      <div class="chip-text">
        <strong>{{ profile.name }}</strong>
        <span>@{{ profile.khorosLogin }}{{ profile.rank ? ' · ' + profile.rank : '' }}</span>
      </div>
      <a :href="profile.profileUrl" target="_blank">View profile ↗</a>
      <ui5-button design="Transparent" @click="onUnlink">Unlink</ui5-button>
    </div>

    <div role="alert" aria-live="polite">
      <ui5-message-strip v-if="status === 'just-linked'" design="Positive">
        Linked to {{ profile.name }}.
      </ui5-message-strip>
    </div>
  </section>
</template>
```

**Status-to-UI mapping for `setKhorosLink` responses:**

| Status | Strip design | User-facing copy |
|---|---|---|
| `not-found` | Negative | "We couldn't find that community user. The lookup needs at least one public post; lurkers can't be found." |
| `already-claimed` | Negative | "That community profile is already linked to another tutorial user." |
| `invalid-input` | Information | "Enter your community login (e.g. `thomas_jung`) or numeric ID." |
| `upstream-unavailable` | Information | "SAP Community is unreachable right now. Try again in a few minutes." |
| `persist-failed` | Negative | "Couldn't save. Try again." |

### Splitting `MyCompletions.vue`

`MyCompletions.vue` today renders **two** sections (Recent Activity timeline + All Completions table) from one `fetch('/api/getMyCompletions()')`. We split into `RecentActivity.vue` and `AllCompletions.vue`, both calling the same endpoint independently.

**Cost:** one extra network call per `/me` load.

**Why accepted:** (a) the response is small and CAP-side cacheable; (b) preserves perfect panel independence — collapsing one panel doesn't pay the data cost of the other; (c) makes it possible to drop or replace one panel later without touching the other.

**Rejected alternative:** a shared composable (`useMyCompletions()`) with module-scoped reactive state. Vue's island pattern in this codebase deliberately does not share state across `createApp` boundaries (see existing `LearningPreferences.vue` vs `MyCompletions.vue`).

### Nav-dropdown changes

`hugo-apps/src/nav-dropdown/` reads `khorosAvatarUrl` and `khorosLogin` from `/auth/user`:

```ts
// existing initials path:
//   if (user.avatarUrl) <img src={user.avatarUrl}> else <Initials />
// becomes:
const avatarUrl = user.khorosAvatarUrl || user.avatarUrl
if (avatarUrl) {
  <img src={avatarUrl} onerror={swapToInitials} alt={user.firstName} />
} else {
  <Initials />
}
```

Plus a new menu item in the popover:

```html
<a v-if="user.khorosLogin"
   href={`https://community.sap.com/t5/user/viewprofilepage/user-id/${user.khorosId}`}
   target="_blank">
  View community profile ↗
</a>
```

### UI5 bootstrap

`CommunityProfile.vue` uses: `ui5-title`, `ui5-text`, `ui5-input`, `ui5-button`, `ui5-avatar`, `ui5-message-strip`. All except `ui5-avatar` are already registered in `hugo/assets/js/ui5-bootstrap.ts`. We register `Avatar` there — **NEVER** import it from a Vue island's `main.ts` (memory: `[feedback_ui5_duplicate_bundle_kills_settheme]`). The `scripts/check-island-ui5-imports.cjs` regression guard catches violations.

The Hugo layout's `<ui5-panel>` collapse-state script awaits `customElements.whenDefined('ui5-panel')` so it doesn't run before `ui5-bootstrap.ts` registers Panel.

## Caching & error handling

### `srv/lib/khoros-cache.js`

```js
// Bounded LRU keyed by khorosId. Module-scoped singleton.
const cache = new Map()
const MAX_ENTRIES = 500
const TTL_MS = 6 * 60 * 60 * 1000   // 6h

export function get(khorosId) {
  const entry = cache.get(khorosId)
  if (!entry) return null
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    cache.delete(khorosId); return null
  }
  cache.delete(khorosId); cache.set(khorosId, entry)   // bump to MRU
  return entry.profile
}

export function set(khorosId, profile) {
  cache.delete(khorosId)
  cache.set(khorosId, { profile, fetchedAt: Date.now() })
  if (cache.size > MAX_ENTRIES) {
    cache.delete(cache.keys().next().value)            // evict oldest
  }
}

export function evict(khorosId) { cache.delete(khorosId) }
export function _resetForTests() { cache.clear() }
```

**Per-process scope.** Two CF instances may each hit upstream once per `khorosId` before either's cache warms. Acceptable for v1; if it ever causes a rate-limit problem, the next step is a Redis-backed shared cache.

### Error handling matrix

| Where | Failure mode | User-visible behaviour |
|---|---|---|
| `setKhorosLink` → upstream 5xx | Khoros API down | `{ status: 'upstream-unavailable' }` → Information strip |
| `setKhorosLink` → upstream null | Lurker / bad input / perm revocation | `{ status: 'not-found' }` |
| `setKhorosLink` → unique constraint | Another user claimed first | `{ status: 'already-claimed' }` |
| `setKhorosLink` → DB write fails | Transient HANA blip | `{ status: 'persist-failed' }` |
| `getKhorosProfile` cache miss + upstream 5xx | Khoros API down while chip rendering | Last-known-good fallback; chip renders; WARN log |
| `getKhorosProfile` cache miss + upstream null | Account deleted on Khoros side | Last-known-good fallback; WARN log |
| Nav-dropdown's `<img>` 404s | Hot-linked CDN URL invalidated | `onerror` swaps to initials |
| `/auth/user` queried before backfill | Brand-new user, never linked | All 3 fields `null` → unlinked state; zero-error path |

**Idempotency:** `setKhorosLink` with the same input twice no-ops (UPDATE writes the same row). `clearKhorosLink` when already-unlinked: returns `ok`.

### Logging (existing `cds.log('khoros')` channel)

- `INFO` on successful link/unlink (sapId, khorosId, action).
- `WARN` on upstream 5xx (with `Retry-After` if returned).
- `WARN` on cache-miss + null upstream (account-deleted scenario).
- `WARN` on empty-search-success (mirrors reference repo's silent-revocation canary).
- `ERROR` on DB failure during link/unlink.

**No new metrics endpoint** for v1. The `Users` audit log answers "how many users linked, when?".

**No rate-limiter** on `setKhorosLink` for v1. The action is `@requires: 'authenticated-user'`, the abuse incentive is essentially nil. If observed, add an in-memory 5/hr/user limiter using the `/feedback/submit` pattern.

## Test plan

| Layer | File | What's covered |
|---|---|---|
| Unit | `test/unit/khoros-client.test.js` | Mocked-fetch: numeric→`author.id`, slug→`author.login`, `dot→underscore` normalisation, fallback to dotted slug, empty-items canary, 5xx propagation. |
| Unit | `test/unit/khoros-cache.test.js` | TTL expiry, LRU eviction at cap, MRU re-insert on get, `evict()` on unlink. |
| Unit | `test/unit/community-profile.test.ts` | Vue island states (unlinked / linked / linking / errored), each `status` enum mapped to the right strip + copy, unlink. |
| Hybrid | `test/hybrid/khoros-link.test.js` | Real HANA: link writes 4 columns; second user with same `khorosId` → 409; clear nulls all 4; `@cap-js/audit-logging` row written; anonymisation cascade scrubs the 3 personal fields. `khoros-client` mocked. |
| Smoke | `test/smoke/me-page.test.js` | `GET /me` returns 200 and HTML contains the 4 mount-point div ids. |

Memory: `[feedback_skip_hybrid_test_costs_two_pr_cycles]` — the `@assert.unique` constraint behaves differently between SQLite (unit) and HANA (hybrid), so the hybrid test is mandatory.

## Rollout & deployment

**No feature flag.** Justified: display-only unlock, no quality-bar fallback needed, and a flag would gate six surfaces (schema, API, two Vue islands, nav-dropdown, admin UI) — a half-disabled state is more confusing than a clean ship.

**Deploy sequence:**

1. PR merge.
2. `cf push tutorials-db-deployer` (or full `mbt build && cf deploy`) — adds 4 nullable columns. Schema rollback path: revert PR + redeploy *leaves columns in place* (column drop is destructive HDI); a follow-up cleanup PR can drop them if needed.
3. Approuter `/me` layout ships with the same deploy — no Hugo content rebuild needed (this is a layout change, not tutorial content).
4. Smoke test on DEV: link a known Khoros account, verify chip + nav-dropdown swap, unlink, verify admin "Clear" action.

**No phased rollout.** Audience is the existing logged-in user base; no canary cohort. Per-user `Unlink` is the one-click recovery path if anyone hits a snag.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Khoros's anonymous `messages.author.*` endpoint gets revoked next | Low | High | Cache + last-known-good means existing links keep rendering for 6h; new links fail with a clear error. Empty-items canary surfaces the revocation in logs. Triage = swap to authenticated client (separate issue). |
| Khoros bulk-renames slugs again | Medium over years | Low | We join on `khorosId`; `khorosLogin` refreshed every 6h. New slug propagates within 6h of any user hitting `/me`. |
| Khoros S3 avatar CDN URL invalidated | Low | Low | `<img onerror>` → initials fallback. |
| Two users race for the same Khoros account | Very low | Low | Unique constraint → 409 → friendly "already-claimed" message. |
| User types another person's handle to fake-claim | Low | Cosmetic-only | Display-only unlock → embarrasses the impersonator, not the impersonatee. Future Devtoberfest-style consumers add their own verification. |
| User who linked then triggered anonymisation | Medium over years | Low | Existing `cascade: 'identity-replace'` walks `@PersonalData.IsPotentiallyPersonal` annotations. Hybrid test asserts cascade. |
| API rate-limit on a deploy stampede | Low | Medium | LRU cache absorbs repeats. If observed, add 1s in-flight de-dup. |
| Vue island ships before HDI deploy completes (ordering bug) | Low | Low | `/auth/user` returns `null` for missing columns → island renders unlinked → resolves after HDI deploy. |
| Mixing Khoros section into Learning Preferences confuses users | Low | Low | Both visible by default; if telemetry suggests confusion, move to its own panel — no schema change. |

## Documentation deliverables

1. **`docs/developers/architecture/khoros-link.md`** — schema, endpoints, cache, reference-repo lineage, the "`messages.author.*` is our only public surface" gotcha.
2. **`docs/end-users/me-page.md`** — short user-facing page on what "Link your community profile" does, with the screenshot from the inline help expander.
3. **`docs/developers/reference/cap-cds-gotchas.md`** — append note on `@assert.unique` + nullable columns AND on why `khorosId` is unique but `khorosLogin` is not. Per memory `[feedback_platform_facts_belong_in_docs_not_memory]`, this stays in docs only — no `CLAUDE.md` edit.
4. **`docs/.vitepress/config.ts`** — sidebar entries for the two new pages (predocs:build will reject otherwise).

## Decisions explicitly NOT made

- **Feature flag** — none. Justified above.
- **Naming in user-visible copy** — always "SAP Community profile", never "Khoros".
- **Touching the anonymisation cascade module** — unnecessary; annotations are sufficient.
- **Migration scripts** — none; no data to migrate.
- **Server-side persistence of panel collapse state** — `localStorage` only for v1.
- **Single-PR vs split-PR** — single PR. Splitting risks half-states (schema deployed, UI not, or vice versa).
- **Admin set-on-behalf-of** — deferred to v2.
