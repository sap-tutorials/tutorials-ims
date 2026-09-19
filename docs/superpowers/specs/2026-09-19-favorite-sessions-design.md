# Favorite Sessions — Design (#2393)

## Problem

Users cannot favorite TechEd or Devtoberfest sessions. Issue #2393: let a
user favorite one or more sessions, and add a "show only favorites" filter to
both event families across their views (grid, schedule, calendar).

## Constraints (established patterns — do not deviate)

- **User identity from JWT only.** Every user-scoped write resolves the user via
  `resolveDbUserId(req.user)` inside the handler; never from a request param
  (IDOR rule — `srv/developer-service.cds:102-115`, `srv/lib/user-progress.js:12-25`,
  regression test `test/hybrid/developer-progress-idor.test.js`).
- **Public pages, optional authed overlay, degrade to anonymous.** The event
  pages are public and edge-cacheable; user-specific state is layered on via a
  separate authed fetch that returns 200 (not 401) when anonymous. Blueprint:
  Devtoberfest `my-completions` (`srv/routes/devtoberfest-schedule.js:189-257`)
  + `hugo-apps/src/devtoberfest-schedule-shared/feed.ts` `fetchMyCompletions`
  (credentials:'include', non-2xx/non-JSON → `{authenticated:false}`).
- **Client-side auth signal.** `document.documentElement.dataset.authenticated`
  set by `hugo/layouts/partials/header.html` from `/auth/user`; consumed by
  islands via `hugo-apps/src/devtoberfest-schedule-shared/useAuth.ts`
  (`auth-resolved` CustomEvent, one-shot per load, #548).
- **No raw SQL** — `cds.ql`/CQL only. **`@requires` guards** every user-scoped op.

## Two source identity schemes (the core wrinkle)

| Source | Backing entity | Stable id used as `sessionRef` |
|---|---|---|
| TechEd | owned `TechEdSessions` (`db/external/teched.cds`) | `slug` (String 200, unique) |
| Devtoberfest | cross-container facade `external.devtoberfest.Session` (`db/external/devtoberfest.cds`, `@cds.persistence.exists`) | `ID` (String 36) |

A unified favorites model needs a **discriminator** + the source-appropriate id,
exactly as `TaskRecords` uses `taskType` + `taskLegacyId`.

## Data model — `db/schema.cds`

```cds
entity SessionFavorites : cuid, managed {
  user       : Association to Users @mandatory;   // FK column user_ID
  sourceType : String enum { TECHED; DEVTOBERFEST; } @mandatory;
  sessionRef : String(200) @mandatory;            // TechEd slug | Devtoberfest ID
}
```

- Uniqueness: `@assert.unique.favorite: [user, sourceType, sessionRef]` — at most
  one row per (user, session).
- **Favorite = INSERT, unfavorite = DELETE.** No soft-delete/status column: the
  toggle is idempotent by row presence, and there is no history requirement.
- No FK to `TechEdSessions`/facade — `sessionRef` is a loose id (facade has no
  reliable FK target on SQLite unit runs; TechEd slug is stable). Referential
  integrity is not required: a favorite pointing at a since-removed session is
  simply not rendered (the feed drives what's shown).

## API — `DeveloperService` (`srv/developer-service.{cds,js}`)

Both ops `@(requires: 'authenticated-user')`, user resolved in-handler.

```cds
action   toggleSessionFavorite(sourceType : String, sessionRef : String)
           returns { favorited : Boolean; };
function getMyFavorites()
           returns array of { sourceType : String; sessionRef : String; };
```

- **`toggleSessionFavorite`** — validate `sourceType ∈ {TECHED,DEVTOBERFEST}` and
  non-empty `sessionRef` (400 otherwise). Resolve `dbUserId` from JWT. SELECT
  existing row on `[user_ID, sourceType, sessionRef]`; if present → DELETE, return
  `{favorited:false}`; else INSERT (new `cds.utils.uuid()`), return `{favorited:true}`.
- **`getMyFavorites`** — resolve `dbUserId`; anonymous → `[]`. Return this user's
  rows projected to `{sourceType, sessionRef}` only. `Cache-Control: no-store`
  handled by the OData response for authed reads (mirrors my-completions intent).

Reachable through approuter at `/api/toggleSessionFavorite`, `/api/getMyFavorites`.

**No custom Express overlay routes.** The `getMyFavorites` OData function already
provides an authed, graceful-anonymous read; islands call it with
`credentials:'include'` exactly as they would a custom route — one fewer moving part.

## Shared island lib — `hugo-apps/src/devtoberfest-schedule-shared/`

- `useAuth.ts` — reused unchanged for gating star + facet.
- `feed.ts` — add `fetchMyFavorites()`: GET `/api/getMyFavorites`,
  `credentials:'include'`; on any non-2xx **or** non-JSON content-type
  (approuter login-redirect HTML) return `{authenticated:false, favorites:[]}`
  instead of throwing. Mirrors `fetchMyCompletions` (`feed.ts:75-89`).
- New `favorites.ts`:
  - a module-level reactive `Set<string>` keyed `"${sourceType}:${sessionRef}"`,
    shared across the views mounted on one page load;
  - `toggleFavorite(sourceType, ref)` — optimistic mutate of the Set, POST
    `/api/toggleSessionFavorite` (credentials:'include'), revert on failure;
  - `isFavorite(sourceType, ref)`, `loadFavorites()` (calls `fetchMyFavorites`,
    seeds the Set), `hasKey(sourceType, ref)` helper.

## UI — both event families, all views

Gate everything on `useAuth().isAuthenticated` (hidden for anonymous, same as
the Devtoberfest completion ✓ column, `App.vue:230,293-295`).

- **Star toggle** on each session card/row. Click → `toggleFavorite`. Filled when
  favorited. Anonymous: not rendered.
- **"Show only favorites" facet** — a toolbar toggle, deep-linked `?fav=1` via the
  existing url-state helpers.
  - TechEd: `teched-sessions-grid/filter.ts` `filterSessions` (add `onlyFavorites`
    predicate, AND with existing facets) + toolbar in `App.vue`; same facet in
    `teched-schedule` + `teched-calendar`.
  - Devtoberfest: `devtoberfest-schedule/App.vue` client filter (`:64-74`) +
    `devtoberfest-sessions-grid` + `devtoberfest-sessions-calendar`.
- Data load: each page calls `loadFavorites()` in parallel with the feed
  (like `loadData` merges completions, `devtoberfest-schedule/App.vue:97-100`).

## Testing

- **Unit (in-memory SQLite):**
  - `toggleSessionFavorite` insert → delete → insert idempotency; return flag.
  - `getMyFavorites` scoped to caller only (two users, no leakage).
  - **IDOR**: favorite is created for the JWT user regardless of any body param;
    mirror `developer-progress-idor.test.js`.
  - Bad `sourceType` / empty `sessionRef` → 400.
  - Anonymous `getMyFavorites` → `[]`.
- **Island (pure):** `teched-sessions-grid/filter.ts` favorites-facet unit test
  (that module is already pure-tested — extend it).
- **Anonymous UI:** star + facet hidden when `isAuthenticated` false.

## Out of scope

- No favorites count / analytics, no email digest, no cross-device sync beyond the
  server row (it is already server-persisted, so sync is inherent).
- No KG/embedding/GC changes. If a user-cascade delete of `Users` exists, add
  `SessionFavorites` to it during implementation (verify); otherwise no GC entry.
- Homepage / other surfaces: only TechEd + Devtoberfest views per the issue.
