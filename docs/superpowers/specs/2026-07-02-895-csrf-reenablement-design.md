# CSRF re-enablement on XSUAA routes (#895)

**Status:** design approved, awaiting spec review
**Date:** 2026-07-02
**Issue:** [#895](https://github.com/sap-tutorials/tutorials-ims/issues/895) (parent: [#808](https://github.com/sap-tutorials/tutorials-ims/issues/808); deferred by [#905](https://github.com/sap-tutorials/tutorials-ims/pull/905))

## 1. Problem

Every route in [approuter/xs-app.json](../../../approuter/xs-app.json) carries `csrfProtection: false` — 36 occurrences. On XSUAA-authenticated routes with non-GET methods, this disables the AppRouter's built-in `x-csrf-token` fetch/validate flow. Any logged-in user visiting an attacker-controlled page can be coerced into cross-origin state-changing requests; the XSUAA session cookie ships automatically on top-level form POSTs.

`SameSite=Lax` on the session cookie and same-origin policy on scripted `fetch()` mitigate most of the drive-by risk today, but that is defense-in-depth we should not be relying on. AppRouter's default is `csrfProtection: true` — the fix is to remove the overrides, and then verify every mutating client fetches the token first.

## 2. Goal & non-goals

**Goal.** Ship a single PR that:

1. Removes `csrfProtection: false` from every route in `xs-app.json` (both XSUAA and anonymous — the flag is a no-op on anonymous routes and removing it keeps the file uniform).
2. Adds a shared `csrfFetch()` helper for hand-rolled Vue-island / analytics-explorer / admin-ext client fetches that mutate state.
3. Adds a build-time guard that fails CI if a new mutating `fetch()` is added without going through `csrfFetch()` (allowlist for the OData V4 model which handles CSRF automatically).
4. Adds a smoke test that proves CSRF enforcement is on in DEV.

**Non-goals.**

- No changes to CAP srv-side behaviour. CAP does not enforce CSRF itself — the AppRouter does, and CAP receives already-validated requests. The change is purely at the edge and in the client callers.
- No changes to the anonymous-route flow (feedback, homepage, alerts, ui-event, advocates, search, build, content, health, `.well-known`, ord, tutorials reader, `/auth/user`, ChatConfig, devtoberfest status/terms, concepts reader). AppRouter never enforces CSRF on anonymous routes; removing the flag is cosmetic and matches the default.
- No changes to Fiori Elements V4 admin apps. Their OData model auto-fetches CSRF; they work as-is once the flag flips.
- No new env-var kill-switch. The rollback lever is `git revert`.

## 3. Chosen approach

**One PR, all XSUAA routes at once, backed by a shared client helper.**

Rejected alternatives:

- **Phased by scope (admin+author first, then rest).** Adds two review cycles and a coordination window; the client-side surface is small enough to audit exhaustively in one pass, and the shared helper eliminates per-island regressions.
- **Approuter middleware kill-switch env-var.** Adds a rollback lever that does not exist for any other approuter setting today. The behaviour is deterministic: either every client fetches the token, or it does not. `git revert` is a cleaner rollback and forces the fix rather than allowing the flag to linger.

## 4. Scope: exact route inventory

Every occurrence of `"csrfProtection": false` in [approuter/xs-app.json](../../../approuter/xs-app.json) is deleted. The routes split into two behaviour classes:

### 4.1 Behaviour-changing (XSUAA, mutating)

| Route pattern | Scope | Client families that mutate |
|---|---|---|
| `^/scanner/(.*)$` | `MobileApp` | UI5 scanner app (`app/scanner/webapp/`) + Vue `scanner-vue` island |
| `^/api/devtoberfest/(join\|me)$` | authenticated | `hugo-apps/src/devtoberfest/TermsDialog.vue` |
| `^/admin/exports/(.*)$` | `Admin` | `app/analytics-explorer/src/composables/useExport.ts` |
| `^/admin/analytics/(.*)$` | `Admin` | `app/analytics-explorer/src/api/sql.ts`, `useSavedQueries.ts` |
| `^/admin/(.*)$` | `Admin` | 14 Fiori Elements apps (auto-CSRF) + 7 hand-rolled admin ext controllers (2 without CSRF today) |
| `^/author/(.*)$` | `Tutorial.Author` | Author tile (Fiori V4 model → auto-CSRF) |
| `^/graph/(.*)$` fallback | `Admin` | Concept admin ext controllers (already CSRF-aware) |
| `^/display/(.*)$` | `DisplayApp` | display-app Vue (Socket.IO GET-only; no client change required) |
| `^/api/v1/(.*)$` | `ConsolidationScope` | External integration surface (documented; no client to update) |
| `^/chat/(.*)$` | authenticated | `hugo-apps/src/chat` islands (via `useApi.ts`) + `app/analytics-explorer/src/composables/useJouleChat.ts` |
| `^/api/(.*)$` fallback | authenticated | **11 hand-rolled Vue-island fetches — highest risk** |
| `^/tutorials-qa/(.*)$`, `^/tutorials-qa/_nav\.json$`, `^/qa-search/(.*)$` | `Tutorial.Author` | GET-dominant (no client change); publish path is server-to-server (out of scope) |
| `^/_dev/?(.*)$`, `^/(\$api-docs/.*)$` | `Admin` | Rare devtool use; documented in runbook |

### 4.2 No behaviour change (anonymous)

`csrfProtection: false` is removed for uniformity on: `/auth/user`, `/api/devtoberfest/(status|terms)`, `/api/ChatConfig`, `/api/advocates`, `/api/alerts`, `/api/ui-event`, `/search/*`, `/socket.io/*`, `/ws/*`, `/rest/*`, `/build/*`, `/homepage/*`, `/feedback/*`, `/health*`, `/.well-known/*`, `/ord/*`, `/content/*`, `/concepts/*`, `/tutorials/*` reader, `/tutorials/_nav.json`.

AppRouter enforces CSRF only on non-GET requests to authenticated routes, so removing the flag on `authenticationType: "none"` routes is a no-op. Uniform file, unchanged behaviour.

## 5. Client helper: `csrfFetch()`

### 5.1 Module

New file: `hugo-apps/src/shared/csrf-fetch.ts` (exported via `hugo-apps/src/shared/index.ts`).

Sibling copy for the analytics-explorer bundle: `app/analytics-explorer/src/api/csrf-fetch.ts` (analytics-explorer is a separate Vite build; sharing via file symlink is fragile on Windows — sibling copy with a shared unit test set is the pragmatic choice; a note in each file points at the other and reminds the reader they must stay in sync).

### 5.2 Contract

```ts
export async function csrfFetch(
  url: string,
  init?: RequestInit,
): Promise<Response>
```

- If `init.method` is undefined, `GET`, `HEAD`, or `OPTIONS`, pass through directly to `fetch()`. AppRouter never enforces CSRF on these.
- Otherwise:
  1. If the module-cached token is unset, do a `GET /auth/user` with header `x-csrf-token: fetch` and read `x-csrf-token` from the response headers into the module cache. If the response is not 2xx or does not carry the header, throw a labelled error (`CsrfFetchError: unable to acquire token`).
  2. Send the original request with `x-csrf-token: <cached>` added to headers.
  3. If the response is `403` and the `x-csrf-token` response header equals `required`, clear the module cache, refetch the token once, retry the original request exactly once. If it fails again, return the second response to the caller.
- `credentials: 'include'` is added if not already set (Vue islands hit the approuter from the same origin, but explicit is safer for local dev where port hopping happens).

### 5.3 Rationale for `GET /auth/user`

- Cheap (returns ~100 bytes of user JSON when logged in).
- Authenticated (approuter emits the token on any authenticated request).
- Already exists in [approuter/xs-app.json](../../../approuter/xs-app.json:99-104).
- Public-facing pages that gate a mutation behind login already probe `/auth/user` (e.g. [hugo-apps/src/tutorial-feedback/api.ts](../../../hugo-apps/src/tutorial-feedback/api.ts:3-10)) — reuse is natural.

### 5.4 Token lifetime

Approuter's token is stable across a session (same value returned on every fetch). Module-scope caching in the SPA is sufficient. Page reload → fresh module → fresh fetch on first mutation. No cookie or localStorage persistence needed.

### 5.5 Call sites to migrate

Vue islands (`hugo-apps/src/`) — 8 files touched:

- `shared/useApi.ts` — replace `fetch()` inside `post()` with `csrfFetch()`. Fanout: `nav-dropdown/*`, `browse/*`, `me/AllCompletions.vue`, `me/RecentActivity.vue`, and other consumers of `useApi().post`.
- `tutorial-reset/TutorialReset.vue` — replace direct `fetch('/api/resetTutorialProgress', …)`.
- `code-check/CodeCheck.vue` — replace direct `fetch('/api/codecheck', …)`.
- `validation/Validation.vue` — replace direct `fetch('/api/validate-answer', …)`.
- `me/LearningPreferences.vue` — replace direct `fetch('/api/setLearningPreferences', …)`.
- `me/CommunityProfile.vue` — replace two direct `fetch()` calls (setKhorosLink, clearKhorosLink).
- `tutorial-pip/useStepNavigation.ts` — replace direct `fetch('/api/completeStep', …)`.
- `devtoberfest/TermsDialog.vue` — replace direct `fetch(apiJoin, …)` (join endpoint is XSUAA).

Vue islands hitting anonymous endpoints — **no change** (their POSTs bypass CSRF): `tutorial-feedback/api.ts`, `tutorial-rating/TutorialRating.vue`, `shared/analytics/tracker.ts`.

Admin ext controllers (`app/admin/*/webapp/ext/`) — 2 files that today do a direct `POST` without the two-step:

- `tutorials/webapp/ext/SourceMarkdownHandler.controller.js` — add the same `x-csrf-token: fetch` handshake used by the 8 sibling controllers ([app/admin/verb-definitions/webapp/ext/ActionsController.js:20-27](../../../app/admin/verb-definitions/webapp/ext/ActionsController.js#L20-L27) is the reference implementation).
- `advocates/webapp/ext/AdvocatePhotoController.js` — same treatment.

Rationale for not moving admin ext controllers to `csrfFetch()`: they are compiled by UI5 tooling, not the Vite bundle, so they cannot import from `hugo-apps/src/shared/`. Copying the helper into every admin controller would be worse than the existing per-file two-step. Sticking with the existing pattern keeps the diff small.

Analytics Explorer composables (`app/analytics-explorer/src/`) — 4 files, all funnel through 2 helper functions:

- `api/sql.ts` — 1 direct `POST /admin/analytics/runSelectQuery` → use `csrfFetch()`.
- `composables/useExport.ts` — 1 direct `POST /admin/exports/...` → use `csrfFetch()`.
- `composables/useJouleChat.ts` — 1 direct `POST /chat/...` → use `csrfFetch()`.
- `composables/useSavedQueries.ts` — 4 POSTs and 1 DELETE, all through the file-local `jsonFetch()` helper ([app/analytics-explorer/src/composables/useSavedQueries.ts:38-49](../../../app/analytics-explorer/src/composables/useSavedQueries.ts#L38-L49)). Replace `fetch(url, …)` inside `jsonFetch()` with `csrfFetch(url, …)`; all 5 call sites upgrade for free.

## 6. Config change

Diff on `xs-app.json`: delete the `"csrfProtection": false` property (and the preceding comma) from all 36 routes. No other keys change.

Because the change is purely subtractive and touches every route the diff is large but mechanical — reviewable at a glance because the resulting file has zero occurrences of the substring.

## 7. Verification

### 7.1 Build-time guard: `scripts/check-csrf-clients.ts`

Runs as part of `postbuild:apps` (same slot as `check-build-collisions.ts`). Walks:

- `hugo-apps/src/**/*.{ts,vue}`
- `app/admin/**/webapp/**/*.js`
- `app/analytics-explorer/src/**/*.{ts,vue}`
- `app/scanner/webapp/**/*.js`

For each file, an ESLint-shaped AST scan (using `@babel/parser` + `@vue/compiler-sfc` for Vue SFCs, already present as transitive deps) finds every `fetch(...)` and `useApi().post(...)` call whose second argument contains `method:` set to a non-GET verb. For each hit:

- If the call is inside a function that also calls `csrfFetch(` — pass.
- If the call is inside a Vue-island file and the fetch URL matches an anonymous-route allowlist (`/feedback/*`, `/api/ui-event`, `/api/advocates/*`) — pass.
- If the call is inside an admin ext controller and the surrounding block references `x-csrf-token` — pass.
- Otherwise fail with a file:line diagnostic and a link to this design doc.

The guard also grep-asserts that `approuter/xs-app.json` contains zero occurrences of `"csrfProtection"` (any value) — belt-and-braces against a future regression that re-adds the flag.

### 7.2 Smoke test: `test/smoke/csrf.test.js`

- `POST` to `/admin/Tutorials` at the DEV approuter with a valid session cookie but no `x-csrf-token` → expect `403` and response header `x-csrf-token: required`.
- `GET /auth/user` with header `x-csrf-token: fetch` → expect `200` and a non-empty `x-csrf-token` response header.
- `POST /admin/Tutorials` with the fetched token → expect not-403 (may still be 401/405 depending on shape; only assert the CSRF enforcement layer is passed).

The test uses the same fixture as the other smoke tests (SMOKE_BASE_URL, SMOKE_ADMIN_BEARER_TOKEN) and runs automatically after the deploy step in [.github/workflows/deploy.yml](../../../.github/workflows/deploy.yml).

### 7.3 Manual DEV pass (recorded in the PR body)

Playwright script exercises each Vue-island mutation on DEV:

1. Tutorial rating widget (POST `/feedback/submit`) — anon, must still work.
2. Tutorial reset (`/api/resetTutorialProgress`) — XSUAA, must succeed.
3. Learning preferences save (`/api/setLearningPreferences`) — XSUAA.
4. Community profile Khoros link save + clear (`/api/setKhorosLink`, `/api/clearKhorosLink`) — XSUAA.
5. Code check submit (`/api/codecheck`) — XSUAA.
6. Validation quiz submit (`/api/validate-answer`) — XSUAA.
7. Complete-step from tutorial PiP (`/api/completeStep`) — XSUAA.
8. Devtoberfest join (`/api/devtoberfest/join`) — XSUAA.
9. Analytics-explorer save query + rerun (`/admin/analytics/...`) — XSUAA Admin.
10. Analytics-explorer SQL tab run (`/admin/analytics/runSelectQuery`) — XSUAA Admin.
11. Analytics-explorer export (`/admin/exports/...`) — XSUAA Admin.
12. Admin app tile save on a couple of admin apps that use the OData V4 model — XSUAA Admin (regression check for auto-CSRF).
13. Admin tutorials app "regenerate source markdown" action (`SourceMarkdownHandler`) — XSUAA Admin.
14. Admin advocates app "upload photo" (`AdvocatePhotoController`) — XSUAA Admin.

The Playwright script itself is ephemeral; the PR body links to a recording (or transcript) proving each step returned a 2xx.

## 8. Rollout

1. Merge to `main`.
2. Deploy to DEV via [.github/workflows/deploy.yml](../../../.github/workflows/deploy.yml) (auto on push to main).
3. Smoke test in the same run must pass.
4. Manual Playwright pass on DEV, evidence attached to the PR.
5. When PROD cutover happens (end-of-July 2026 per memory), the change ships with everything else.

## 9. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A Vue island I missed still uses hand-rolled `fetch()` for a mutation | Low | 403 in DEV | Build-time guard catches it before the PR merges. |
| Approuter version does not honour `csrfProtection: true` as default (regression in `@sap/approuter`) | Very low | All mutations 403 | Smoke test on DEV catches it in the same CI run. Rollback is `git revert`. |
| `/auth/user` returns 200 for anonymous users (with `authenticationType: "xsuaa"` this shouldn't happen, but the route was previously bypassable) | Very low | Anon users hit the token fetch, get redirected to login | The current route already requires XSUAA — no change. If the user is anonymous, the mutating call would also require login; the token-fetch redirect is expected UX. |
| Admin ext controller changes conflict with an in-flight PR (Fiori tooling is fussy about controller shape) | Low | Merge conflict | Small blast radius (2 files); rebase-safe. |
| Analytics-explorer sibling `csrf-fetch.ts` drifts from the hugo-apps copy over time | Medium (year-scale) | Behaviour inconsistency | Add a shared unit test set (`test/csrf-fetch.spec.ts`) that both files import from, and a comment header pointing at the sibling. Fully eliminating this would require extracting a workspace package — out of scope. |
| A future PR adds a new mutating `fetch()` without `csrfFetch()` | Medium | New 403 in prod | Build-time guard exists to prevent this. |
| `csrfFetch()` retry-on-403 loops if the server always returns `x-csrf-token: required` even after a valid token (server bug) | Very low | UI blocks on one mutation | Retry is hard-capped at once. Second failure is returned to the caller who surfaces an error toast. |

## 10. Success criteria

- All 36 `csrfProtection: false` occurrences deleted from `xs-app.json`.
- `scripts/check-csrf-clients.ts` runs green in CI and detects a synthetic regression added in a throwaway commit during PR review.
- `test/smoke/csrf.test.js` passes on DEV post-deploy.
- All 14 manual Playwright flows return 2xx on DEV.
- No CSRF-related 403s in DEV logs 24h after deploy (grep `x-csrf-token: required` in CF logs).
- Issue #895 closed by the merge.

## 11. Open questions

None. Design approved conversationally by Tom on 2026-07-02.
