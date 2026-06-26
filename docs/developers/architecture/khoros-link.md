# Khoros community-link

How SAP Community profiles link to tutorial users (issue #566).

## Schema

Four columns on `Users` (`db/schema.cds`): `khorosId` (numeric, `@assert.unique`),
`khorosLogin` (slug, refreshed lazily, NOT unique), `khorosAvatarUrl` (hot-linked
from khoros-mining CDN), `khorosLinkedAt`. All nullable; unlinked users start at
all-null.

## Endpoints

- `POST /api/setKhorosLink` (`DeveloperService`) — user claims their Khoros profile.
  Returns a status enum so the Vue island can render specific error UI per case.
- `POST /api/clearKhorosLink` (`DeveloperService`) — user unlinks.
- `GET /api/getKhorosProfile()` (`DeveloperService`) — chip refresh; goes through
  the 6h LRU cache. **Note:** this "GET" intentionally writes back to the DB when
  the upstream avatar URL has drifted from the persisted one. Documented side
  effect; keeps the nav-dropdown's avatar current without a separate refresh
  endpoint. New maintainers should be aware that `getKhorosProfile()` is not a
  pure read.
- `POST /admin/clearKhorosLink` (`AdminService`) — admin override (Admin role
  required). Bound on the `Users` entity in Fiori Elements V4 ("Clear Khoros link"
  action button on the Users Object Page). No corresponding admin-set; that's
  deferred.
- `/auth/user` carries `khorosId`, `khorosLogin`, `khorosAvatarUrl` for the
  current user (so the nav-dropdown's avatar swap costs zero extra roundtrip).

## Khoros lookup

The `srv/lib/khoros-client.js` module ports the reference repo
(https://github.com/SAP-samples/sap-community-activity-badges) to native fetch.
Anonymous direct `/api/2.0/users/:id` reads were revoked mid-2026; we now
project `messages.author.*` against `/api/2.0/search`. **Users with zero
community posts cannot be found via this surface.** A future revocation of
the search endpoint as well would require a Khoros service principal.

The tenant prefix (`khhcw49343`) is held in `KHOROS_TENANT_PREFIX` for a future
one-line rotation.

## Cache

`srv/lib/khoros-cache.js` — bounded LRU keyed by `khorosId`, 6h TTL,
500-entry cap, per-process.

**Two CF instances may each warm independently** — the cache is module-scoped
and not Redis-shared. The handler unit-tests don't fully verify cross-instance
behaviour (the test process imports `khoros-cache.js` as a different module
instance than the live CAP runtime, so cross-instance assertions can't be made
inside vitest). The standalone Task 1 unit tests cover get/set/evict/TTL
semantics independently; the handler's cache calls are verified by code
inspection. A future Redis-backed shared cache would close this gap.

## Last-known-good

When `getKhorosProfile` upstream is down or returns null (account deleted),
the chip still renders from persisted DB fields with a blank rank. Logs the
warning but does not surface to the user.

## GDPR

Three of the four columns are `@PersonalData.IsPotentiallyPersonal`. The
existing `cascade: 'identity-replace'` cascade walks them on anonymisation —
no code changes needed.

## Frontend

`/me` page is three collapsible `ui5-panel`s (collapse state in localStorage,
per-device, not synced):

- **Learning Preferences** — existing `LearningPreferences.vue` island + the
  new `CommunityProfile.vue` island (claim / linked chip / unlink). They sit
  in the same panel by design — the Khoros section is a sub-section under a
  divider.
- **Recent Activity** — extracted from the original `MyCompletions.vue`, now
  shows just the `<ui5-timeline>` of recent completions.
- **All Completions** — extracted from the original `MyCompletions.vue`, now
  shows just the toolbar + sortable / filterable table.

Each Vue island owns its own `fetch('/api/getMyCompletions()')` — they don't
share state. One extra network call per `/me` load is the accepted cost for
panel-independence.

Nav-dropdown (top-right user avatar in `hugo/layouts/partials/header.html`)
swaps the initials for the Khoros avatar image when linked, and the popover
gains a "View community profile ↗" menu item. The `<img onerror>` falls back
to initials if the Khoros CDN serves a 404.

## Admin override

The Users Object Page in the Accounts admin tile (`/admin-ui/#accounts-display`)
shows three Khoros columns (khorosId, khorosLogin, khorosLinkedAt) as
read-only fields in a "SAP Community" facet. A "Clear Khoros link" bound action
button lets admins unlink on behalf of users (e.g. for support tickets:
"please unlink my account, I made a typo"). Admin-set-on-behalf-of is NOT
implemented in v1 (the admin can clear, the user re-links).

## Tests

| Layer | File | What's covered |
|---|---|---|
| Unit | `test/unit/khoros-cache.test.js` | TTL, MRU bump, eviction, evict-on-unlink |
| Unit | `test/unit/khoros-client.test.js` | numeric vs slug fingerprint, dot-to-underscore, fallbacks, 5xx, empty-items |
| Unit | `test/unit/developer-service-khoros.test.js` | 8 handler tests using mocked fetch |
| Unit (Vue) | `hugo-apps/src/me/__tests__/CommunityProfile.test.ts` | 7 island state tests |
| Hybrid | `test/hybrid/khoros-link.test.js` | real HANA: 4 schema tests + 1 admin-clear test (5 total) |
| Smoke | `test/smoke/me-page.test.js` | /me HTML shape (4 mount points + 3 panels) |
