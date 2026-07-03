# Authorization Parity with Legacy Java IMS (Issue #809)

- **Date:** 2026-07-03
- **Issue:** [#809](https://github.com/sap-tutorials/tutorials-ims/issues/809)
- **Author:** Thomas Jung + Claude (brainstorming session)
- **Status:** Draft — pending review

## Problem

Legacy Java IMS enforced authorization verbosely: every REST controller and every Spring Data repository method carried a `@PreAuthorize("hasAnyAuthority(...)")` annotation, and 23 `@WithMockUser` test classes ran ~460 role-matrix assertions covering (endpoint × HTTP verb × scope) allow/forbid tuples.

The current CAP replacement relies primarily on **service-level `@requires`** annotations plus approuter route-scope gates. This is elegant when a service is homogeneous, but it obscures granularity when actions inside one service have different trust levels — and it makes authorization changes hard to review because the guard is not co-located with the code it protects.

An audit across both codebases (see [Appendix A](#appendix-a--current-cap-authorization-surface) and [Appendix B](#appendix-b--legacy-java-ims-authorization-surface)) surfaced three acute misconfigurations, a large gap in scope-level test coverage, and a set of endpoints where CAP is measurably looser than the legacy equivalent. This spec fixes them in three layered phases.

## Goals

- Close the authorization posture gap between legacy Java IMS and CAP using pragmatic (not exhaustive-legacy) parity as the yardstick.
- Ship in three PRs so each is reviewable and independently revertable.
- Establish a role-matrix test pattern that ratchets forward — every future service or action gets its `auth.test.js` entry.

## Non-goals

- Reintroducing legacy endpoints that don't exist in CAP (statistic dashboards, prize CSV, environment tabs).
- New authentication mechanisms (SAML/passkeys/etc.). This is authorization only.
- Changing the scope/role-collection *design* — `Admin`, `SuperAdmin`, `ContentAuthor`, `DeveloperApp`, `MobileApp`, `DisplayApp`, `ConsolidationScope`, `Tutorial.Author`, `KnowledgeGraph.Admin`, `Everyone` stay as they are.
- Removing anonymous routes documented as intentional (`/api/alerts`, `/api/advocates`, `/api/ChatConfig`, homepage anonymous browse). These are audited but not tightened.
- Introducing XSUAA attribute-restricted scopes, custom scope hierarchies, or auth-failure telemetry beyond existing `@cap-js/audit-logging` coverage.

## Design

Three layered phases: **A** (acute misconfig fixes) → **B** (test framework + coverage) → **C** (per-action tightening). Each ships as an independent PR.

### Phase A — Acute misconfigurations

Three fixes, each as its own commit inside one PR so a bad one reverts independently.

#### A1 — Remove `Tutorial.Author` auto-grant

**Change:** In [xs-security.json](../../xs-security.json), remove `"$XSAPPNAME.Tutorial.Author"` from the top-level `authorities` array. Keep it in the `TutorialAuthor` role template.

**Current state:** `authorities: ["$XSAPPNAME.Tutorial.Author","$XSAPPNAME.Everyone"]` auto-grants the QA-preview scope to every authenticated JWT, defeating the `Tutorials Author` role-collection.

**Target state:** `authorities: ["$XSAPPNAME.Everyone"]`. QA-preview access requires explicit role-collection assignment.

**Operational impact:** Users currently relying on the auto-grant lose QA-preview (`/tutorials-qa/*`, `/qa-search/*`) and author-service (`/author/*`) access until assigned to `Tutorials Author` role-collection. Requires:
- Pre-deploy audit — who currently has QA access (via SCI CPS API or cockpit)?
- `cf update-service tutorial-system-dev-xsuaa -c @xs-security.json` after deploy (memory-flagged pattern: [xsuaa_scope_changes_need_manual_update_service](../../../../../../.claude/projects/d--projects-tutorials-poc/memory/xsuaa_scope_changes_need_manual_update_service.md))
- Role-collection grant list ready to run via `btp` CLI

**Test:** New `test/unit/xs-security-authorities.test.js` asserts `authorities` contains exactly `["$XSAPPNAME.Everyone"]`. Regression re-adding `Tutorial.Author` fails CI.

#### A2 — ScannerService requires `MobileApp` scope

**Change:** In `srv/scanner-service.cds`, swap `@requires: 'authenticated-user'` → `@requires: 'MobileApp'`.

**Rationale:** Approuter route `^/scanner/(.*)$` already requires `MobileApp` at ingress, but direct-srv-URL access (hybrid dev, or via a leaked srv URL) only requires an authenticated JWT today. Aligning the CDS scope with the approuter route closes the bypass.

**Operational impact:** None for production users routing through the approuter. Local hybrid-dev with tech-user Basic auth needs the tech-user's `TenantSettings.techUsers` entry to include `MobileApp` in its role list.

**Test:** Extend `test/unit/scanner-claim-prize-ownership.test.js` (or new `scanner-service-auth.test.js`) — `withUser({scopes:['MobileApp']})` → allowed; `withUser({scopes:['authenticated-user']})` → 403.

#### A3 — Tech-user default role removal

**Change:** In `srv/lib/tech-user-auth.js:23`, replace the silent default of `['Admin']` for role-less tech-user entries with a parse-time throw carrying a clear error message.

**Rationale:** Silent Admin default is a supply-chain / config-drift risk. Legacy Java's equivalent required an explicit `authority` on every tech user (`app.techUsers` map). Aligning removes an unaudited elevation path.

**Operational impact:** Any existing `TenantSettings.techUsers` entry without a role field will fail at boot. Migration checklist ships with the PR:

1. Query `SELECT techUsers FROM TenantSettings` on DEV and PROD.
2. Parse each entry (format: `user:pass:role1,role2;…`); identify role-less entries.
3. Back-fill with explicit `Admin` role via admin UI (preserves current behavior).
4. Deploy the fail-loud change.

**Test:** In `test/unit/tech-user-auth.test.js` — role-less entry parse throws; role-present parses correctly; empty role list also throws.

#### Phase A deliverables

- 3 code changes + 3 tests + 1 runbook update (`docs/developers/operations/xsuaa-role-collection-assignment.md` — new file)
- Deploy checklist including the `cf update-service xsuaa` step and the tech-user audit query
- Rollback plan: each fix reverts independently; A1's revert requires re-running `cf update-service`

### Phase B — Role-matrix test framework

Hybrid harness: in-process (CDS `withUser`) for the exhaustive matrix, HTTP-with-signed-JWT tier for end-to-end auth-middleware coverage (~15–20 cases only).

#### B1 — `test/auth/` layout

```
test/auth/
├── _harness/
│   ├── with-user.js           # cds.User injection for in-process
│   ├── http-fixture.js        # cds.serve() + signed JWTs
│   ├── fake-xsuaa.js          # jose-signed JWT factory keyed to test JWK
│   └── matrix.js              # matrix() DSL helper
├── services/                  # one file per CDS service
│   ├── admin-service.auth.test.js
│   ├── author-service.auth.test.js
│   ├── analytics-service.auth.test.js
│   ├── developer-service.auth.test.js
│   ├── display-service.auth.test.js
│   ├── consolidation-service.auth.test.js
│   ├── scanner-service.auth.test.js
│   ├── knowledge-graph-service.auth.test.js
│   ├── homepage-service.auth.test.js
│   ├── search-service.auth.test.js
│   ├── chat-service.auth.test.js
│   ├── event-stream-service.auth.test.js
│   └── exports-service.auth.test.js
└── express/                   # Express-route auth
    ├── content-store.auth.test.js
    ├── feedback.auth.test.js
    ├── health.auth.test.js
    ├── auth-user-endpoint.auth.test.js
    ├── build-endpoints.auth.test.js
    ├── admin-embeddings.auth.test.js
    ├── admin-metrics.auth.test.js
    ├── advocates.auth.test.js
    ├── alerts.auth.test.js
    ├── devtoberfest.auth.test.js
    ├── codecheck.auth.test.js
    └── validate-answer.auth.test.js
```

All new files added to the `unit` Vitest workspace (in-memory SQLite, no HANA, no `cf login`). Total: ~26 new test files.

Existing `test/unit/*-auth*.test.js` files stay in place. Duplicated coverage between an existing test and the new matrix file is accepted until Phase B ships, then a follow-up commit removes the older tests only after confirming coverage parity — never mid-PR (avoids the mistake of removing coverage before proving replacement works).

#### B2 — `withUser` helper (in-process, CDS layer)

```js
// test/auth/_harness/with-user.js
import cds from '@sap/cds';

export function withUser({ id = 'test-user', scopes = [], attrs = {}, roles } = {}) {
  const rolesMap = Object.fromEntries((roles ?? scopes).map(s => [s, true]));
  return new cds.User({ id, roles: rolesMap, attr: attrs });
}

export async function asUser(user, fn) {
  return cds.context.run({ user }, fn);
}
```

Usage:
```js
it('MyTutorials READ requires Admin', async () => {
  const anon = withUser({ scopes: [] });
  await expect(asUser(anon, () => SELECT.from(MyTutorials)))
    .rejects.toMatchObject({ code: '403' });

  const admin = withUser({ scopes: ['Admin'] });
  await expect(asUser(admin, () => SELECT.from(MyTutorials))).resolves.toBeDefined();
});
```

#### B3 — `matrix()` DSL

Compact syntax; expands to one `it()` per case at import time so the test runner reports each cell separately.

```js
matrix({
  action: 'AdminService.rebuildContent',
  invoke: (srv) => srv.send('rebuildContent'),
  cases: [
    { scopes: ['Admin'],         expect: 'allow' },
    { scopes: ['SuperAdmin'],    expect: 'allow' },   // SuperAdmin grants Admin
    { scopes: ['ContentAuthor'], expect: 403 },
    { scopes: ['DeveloperApp'],  expect: 403 },
    { scopes: [],                expect: 401 },
  ],
});
```

Failures point at exactly one (endpoint × scope) cell. Action names are literal strings, so IDE search still finds them.

#### B4 — HTTP-with-signed-JWT tier

For a small (~15–20 case) integration set that proves the whole auth chain end-to-end: approuter forwards JWT → srv middleware validates → `req.user.is(scope)` sees the right scopes.

Uses `jose` to sign JWTs with a per-test-run RSA keypair; the public JWK is served from an in-process HTTP mock on a random port. `@sap/xssec` is pointed at that mock via `VCAP_SERVICES.xsuaa[0].credentials.url` env var. Same pattern as existing `test/hybrid/kg-*` tests — formalizing, not inventing.

Cases:
- `/admin/*` — `Admin` → 200; anonymous → 401; only `DeveloperApp` → 403
- `/author/*` — `Tutorial.Author` → 200; anonymous → 401
- `/display/*` — `DisplayApp` → 200; anonymous → 401
- `/api/v1/user-merge/*` — `ConsolidationScope` → 200; wrong scope → 403
- `/graph/runSparql` — `KnowledgeGraph.Admin` → 200; anonymous → 401
- `/graph/neighborhood` — anonymous → 200 (proves public-KG allowlist end-to-end)
- `/scanner/*` — `MobileApp` → 200; only `authenticated-user` → 403 (proves Phase A2)
- `/content/publish` — bearer positive → 200; missing → 401; wrong → 403
- `/tutorials-qa/*` — `Tutorial.Author` → 200; without → 401 (proves Phase A1)

#### B5 — Coverage gaps closed

- `DisplayService` positive path for `DisplayApp` scope (no test exists today)
- `ConsolidationService` — `ConsolidationScope` positive; wrong scope → 403; anonymous → 401
- `AnalyticsService.@restrict` row filter: `withUser({id:'alice'})` sees only her `SavedQueries`; `withUser({id:'bob'})` cannot UPDATE/DELETE alice's rows
- `AuthorService` per-action ownership assertions
- `AdminService` action matrix — ~40 actions each getting one row
- KG public allowlist vs KG.Admin action gate (both sides)
- Tech-user Basic auth: correct pass → role set matches tenant config; wrong pass → 401; role-less entry → boot-error (proves A3)
- `/api/ui-event` — anonymous is intentional (asserts empty scope reaches handler)
- `HomepageService.recordRedirectHits` — anonymous reaches; rate-limiter engages
- Row-level `req.user.attr` filters — one representative case (`getMyCompletions` filters by JWT `user_uuid`)

#### B6 — Ratchet: `check-auth-matrix-completeness.cjs`

`pretest` gate that parses all `srv/*.cds` for `@requires`/`@restrict` and greps `test/auth/services/*.auth.test.js` for action names. Any action missing from the matrix fails CI.

- **Phase B PR:** ships as **warn** (does not block CI).
- **Phase C PR:** flipped to **fail-loud**.

This ordering means adding a new action to a service without a corresponding matrix row eventually blocks CI — but not until the initial matrix is complete, so Phase B doesn't accidentally block unrelated work.

Placement: `scripts/check-auth-matrix-completeness.cjs`.

#### B7 — Non-negotiables

- Every `.auth.test.js` file MUST include an "unauthenticated" case for every action (empty scopes → 401). At minimum, that proves the guard exists.
- Every action defined in `srv/*.cds` MUST appear in the matrix (enforced by B6).
- Assertion count target: ≥ 200 across `test/auth/**` (legacy Java had ~460 across a larger surface).

### Phase C — Per-action tightening (pragmatic parity)

Pragmatic = tighten where CAP is currently looser than the operational model requires; don't create endpoints to match legacy ones that don't exist in CAP. Every surviving looseness gets an in-code annotation.

#### C1 — Legacy → CAP mapping table

Full table (~60 rows) below in [Appendix C](#appendix-c--legacy--cap-endpoint-mapping). Excerpt:

| Legacy Java endpoint | Legacy guard | CAP equivalent | CAP guard today | Action |
|---|---|---|---|---|
| `POST /task-records` | Admin, DeveloperApp, MobileApp | `DeveloperService.createTaskRecord` | `authenticated-user` | Keep + annotate (JWT-user-scoped) |
| `GET /task-records/search/findByAccountNumber` | Admin | `ScannerService.getContestant` | `MobileApp` (post-A2) | ✅ parity |
| `GET /statistic` | Admin, DeveloperApp, MobileApp | *no CAP equivalent* | — | Skip (endpoint removed) |
| `POST /tags/updateDevelopersTags` | Admin, CA, D | `AdminService.Tags UPDATE` | Admin | ✅ tighter (fine) |
| `GET /tutorialMeta` | Admin, CA | `AuthorService.MyTutorials` | Tutorial.Author + ownership | ✅ tighter (fine) |
| `PATCH /prize-records/{id}` | Admin, DeveloperApp, MobileApp | `ScannerService.claimPrize` | `MobileApp` + ownership (post-A2) | ✅ parity |
| `GET /tutorials/{id}/steps/search` | Admin, D | folded into content-serve | anonymous `/content/tutorials/*` | ✏️ Annotate looser-by-design |
| Global `/actuator/health` | permitAll | `/health` | anonymous | ✅ parity |
| Basic-auth tech-users → SCOPE_Admin | any credentialed | `basicAuthMiddleware` → tenant-config roles | tenant-config roles (post-A3) | ✅ tighter |

#### C2 — Concrete tightening changes

**DeveloperService:**
- `createTaskRecord`, `completeStep`, `resetTutorialProgress`, `findTaskProgressByUserAndTasksIds`, `countCompletedMissionsTotal`, `countCompletedMissionsPercent`, `getProgress`, `getMyCompletions`, `getEventProgress`, `getAppSpaceProgress` — stay `authenticated-user`; add group annotation `// AUTH: authenticated-user — user-scoped by JWT user_uuid; no scope split needed`.
- `setLearningPreferences`, `setKhorosLink`, `clearKhorosLink`, `getKhorosProfile` — same annotation; keep.
- `submitTutorialFeedback` — anonymous with salt+rate-limit. Annotate `// AUTH: anonymous by design — public feedback form; rate-limited by IP; salt-hashed submitter`.

**AdminService:**
- Service-level `@requires: 'Admin'` covers everything. No per-action `SuperAdmin` split beyond the KG `publishConcept`/`unpublishConcept` gate already in place.
- `rebuildContent` — stays `Admin` (decision locked in Section 4 of design; rebuild is idempotent, no data-loss risk).
- Every mass-mutation action (`classifyCategories`, `reclassify`, `generateExplainers*`, `seedEmbeddings*`, `orphanPurge`) — verify `Admin` gate present; no change.

**AuthorService:**
- Add `@restrict` (belt-and-suspenders alongside existing JS guards):
  - `MyTutorials`, `MyAuthoredTutorials`, `MyOwnedTutorials` READ — `@restrict: [{ grant: 'READ', where: 'authorSapId = $user.attr.user_uuid' }]`.
- Per-action ownership checks (`rebuildContent`, `reviewTutorial`, `snoozeTutorial`, `toggleMonitor`) — already imperative JS; keep.

**KnowledgeGraphService:**
- Concepts UPDATE: add CDS-level `@restrict` mirroring the imperative `before UPDATE` guard so `PATCH /graph/Concepts(...)` from anonymous fails at OData parse.
- Anonymous allowlist (`neighborhood`, `Concepts` READ, `ConceptEdges`, `TutorialConceptLinks`, `pathBetween`, `conceptsForUser`, `explore-data`, `path`) — annotate that CDS `@requires: 'any'` matches approuter allowlist by design.

**HomepageService, SearchService, EventStreamService:**
- Anonymous by design. Add `// AUTH: anonymous by design — public browse; rate-limited by IP` code comments. No `@requires` change.

**ConsolidationService, DisplayService:**
- Already correctly scoped. Test coverage only (added in Phase B).

**ScannerService:**
- Phase A2 fixes scope to `MobileApp`.
- Phase C adds tenant-scope JS check to `scanner-service.js:getContestant` — `contestant.tenant === req.user.attr.zid` (or equivalent tenant claim). Cross-tenant enumeration blocked; same-tenant enumeration by design (scanners work event-wide).

**ExportsService:**
- `@requires: 'Admin'` ✅ parity. No change.

#### C3 — Phase C deliverables

- Legacy→CAP mapping table (Appendix C, ~60 rows)
- Per-service annotation-only tightening (C2)
- CDS `@restrict` on `AuthorService.MyTutorials*` and `KnowledgeGraphService.Concepts` UPDATE
- Tenant-scope check in `scanner-service.js:getContestant`
- `scripts/check-auth-matrix-completeness.cjs` flipped from warn to fail-loud
- All Phase B matrix tests that depend on C-tightening now passing (list them explicitly in the plan)
- `docs/developers/reference/testing-endpoints.md` gains a "required scope" column
- Memory `feedback_auth_matrix_ratchet_is_load_bearing.md` written

## Cross-cutting concerns

### Test isolation & speed

All new tests in the `unit` Vitest workspace (in-memory SQLite). Target: entire `test/auth/**` runs in < 30s locally on the primary tree. HANA-only cases (rare) move to `test/hybrid/` with the standard opt-in guard.

Signed JWTs use a per-test-run RSA keypair generated at harness boot; public JWK served from an in-process HTTP mock on a random port. `@sap/xssec` pointed at the mock via `VCAP_SERVICES.xsuaa[0].credentials.url` env var. Same pattern as existing `test/hybrid/kg-*`.

### CI integration

- `package.json` `scripts.test` runs everything in the unit workspace, so `test/auth/**` runs on every PR.
- `check-auth-matrix-completeness.cjs` runs in `pretest` — warn in Phase B, fail in Phase C.
- No new CI workflow.

### Documentation

New/updated docs under `docs/developers/`:
- **New:** `docs/developers/architecture/authorization.md` — "how auth works in this codebase" architecture doc. Covers CDS `@requires`/`@restrict`, approuter scope routing, Express middleware layers, tech-user Basic auth, KG anonymous allowlist, tenant scoping.
- **New:** `docs/developers/operations/xsuaa-role-collection-assignment.md` — runbook for Phase A1 rollout.
- **Updated:** `docs/developers/reference/testing-endpoints.md` — every endpoint gains a "required scope" column populated from the mapping.
- **Updated:** `docs/developers/operations/mta-deployment.md` — deploy checklist gains "run `cf update-service tutorial-system-dev-xsuaa -c @xs-security.json` if xs-security.json changed since last deploy".

Docs registered in `docs/.vitepress/config.ts` sidebar; `predocs:build` gate catches omissions.

### Memory updates

After ship: one new memory only, `feedback_auth_matrix_ratchet_is_load_bearing.md`, explaining that `test/auth/services/*.auth.test.js` files are a completeness ratchet — adding a CDS action without updating the matrix will fail CI once Phase C ships.

Platform-fact content (scope list, role-collection names, mapping table) goes in `docs/developers/architecture/authorization.md`, not memory (per [feedback_platform_facts_belong_in_docs_not_memory](../../../../../../.claude/projects/d--projects-tutorials-poc/memory/feedback_platform_facts_belong_in_docs_not_memory.md)).

### Rollout order & rollback

**Order:** A → B → C, three independent PRs deployed in three separate `cf deploy`s. A bakes ≥ 1 working day before B deploys. B lands on green `main` before C is opened. ~1 week calendar time.

**Rollback:**
- **A:** each of A1/A2/A3 reverts independently. A1 additionally requires re-running `cf update-service` to restore old scope-set.
- **B:** test-only. Full revert safe; no production code touched.
- **C:** annotations + `@restrict` + one JS tenant check. Reverts cleanly. B tests that depend on C-tightened behavior must be `it.skip`ped if C is reverted — spec lists them explicitly in the plan.

## Acceptance criteria

### Phase A ships when

- [ ] `xs-security.json` `authorities` array contains only `["$XSAPPNAME.Everyone"]`
- [ ] `srv/scanner-service.cds` uses `@requires: 'MobileApp'`
- [ ] `srv/lib/tech-user-auth.js` throws at parse time on role-less tech-user entries
- [ ] 3 unit tests exist (`test/unit/xs-security-authorities.test.js`, extended `scanner-service-auth.test.js`, extended `tech-user-auth.test.js`)
- [ ] `docs/developers/operations/xsuaa-role-collection-assignment.md` exists and covers current holders, cockpit + `btp` CLI grant procedure, audit
- [ ] Deploy runbook step for `cf update-service xsuaa` added to `mta-deployment.md`
- [ ] `TenantSettings.techUsers` audit run against DEV and PROD; role-less entries back-filled
- [ ] PR merged, deployed to DEV, `cf update-service` executed, one working-day soak
- [ ] `/auth/user` shows expected `isAuthor` value for both a role-collection-holder and a non-holder (Playwright verification)

### Phase B ships when

- [ ] `test/auth/_harness/` contains `with-user.js`, `http-fixture.js`, `fake-xsuaa.js`, `matrix.js`
- [ ] `test/auth/services/` contains one `.auth.test.js` per CDS service (12 services)
- [ ] `test/auth/express/` contains one `.auth.test.js` per Express-route group (~12 files)
- [ ] Total assertion count ≥ 200
- [ ] Every action in `srv/*.cds` appears in the matrix (proved by `scripts/check-auth-matrix-completeness.cjs` in warn mode)
- [ ] Existing `test/unit/*-auth*.test.js` files remain green
- [ ] `test/auth/**` completes in < 30s locally
- [ ] `docs/developers/architecture/authorization.md` exists
- [ ] PR merged; CI green on `main`

### Phase C ships when

- [ ] Legacy→CAP mapping table complete (~60 rows in Appendix C)
- [ ] Every `// AUTH: looser by design — <reason>` annotation exists in code cited by the mapping
- [ ] CDS `@restrict` added on `AuthorService.MyTutorials*`, `KnowledgeGraphService.Concepts` UPDATE
- [ ] Tenant-scope JS check added to `scanner-service.js:getContestant`
- [ ] `scripts/check-auth-matrix-completeness.cjs` flipped to fail-loud
- [ ] All Phase B matrix tests dependent on C-tightening are passing (explicit list in plan)
- [ ] `docs/developers/reference/testing-endpoints.md` has "required scope" column
- [ ] Memory `feedback_auth_matrix_ratchet_is_load_bearing.md` written
- [ ] PR merged; deployed; soak

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Phase A1 removes QA access for users who need it | Medium | High (author UX regression) | Pre-deploy audit of current holders; role-collection grants prepared |
| Phase A3 fail-loud crashes boot in prod if a role-less tech-user entry exists | Medium | High (outage) | Pre-deploy `TenantSettings.techUsers` audit query; back-fill roles before ship |
| Phase B tests flaky on signed-JWT HTTP tier (`@sap/xssec` mocks historically fragile) | Medium | Medium (CI noise) | Keep HTTP tier to ≤ 20 cases; in-process is the exhaustive layer |
| Phase C `@restrict` on `MyTutorials*` breaks a working query when `user_uuid` isn't populated | Low | Medium (author UI regression) | Existing `resolveDbUser` already depends on `user_uuid`; smoke-test after deploy |
| Matrix ratchet blocks unrelated PRs | Medium (first month) | Low (dev friction) | Ships as warn in B; flip to fail in C after initial matrix complete; escape hatch documented |
| Scope-name typo in a test asserts the wrong thing | Low | Low | Central `SCOPES` constant in `_harness/`; typo = compile-time error via IDE |

## Explicit deferrals (out of scope)

- XSUAA attribute-restricted scopes (`attributes` block in `xs-security.json`) — legacy Java doesn't use them.
- Row-level security via CAP `where` clauses beyond `MyTutorials*` — future work.
- Custom scope hierarchy changes — not touched here.
- Auth-failure telemetry — `@cap-js/audit-logging` covers write failures on annotated entities; no new instrumentation.
- Rate limiting — orthogonal to authorization; existing IP rate-limiters stay as-is.

---

## Appendix A — Current CAP authorization surface

Full audit output from parallel Explore agents (2026-07-03). Summarized by category.

### A.1 CDS-level auth (`@requires` / `@restrict`)

| Service | Path | Service-level guard | Notes |
|---|---|---|---|
| AdminService | `/admin` | `@requires: 'Admin'` | Redundant re-assertions on ~10 sensitive singletons |
| AuthorService | `/author` | `@requires: 'Tutorial.Author'` | Ownership via JS |
| AnalyticsService | `/admin/analytics` | `@requires: 'Admin'` | `SavedQueries`/`QueryHistory` `@restrict` by `createdBy=$user` |
| ExportsService | `/admin/exports` | `@requires: 'Admin'` | |
| DisplayService | `/display` | `@requires: 'DisplayApp'` | WebSocket + OData |
| ConsolidationService | `/api/v1` | `@requires: 'ConsolidationScope'` | SCI merge |
| ScannerService | `/scanner` | `@requires: 'authenticated-user'` | **A2 tightens to `MobileApp`** |
| ChatService | `/chat` | `@requires: 'authenticated-user'` | Handler is Express `/chat/stream` |
| KnowledgeGraphService | `/graph` | `@requires: 'any'` | Admin actions carry `KnowledgeGraph.Admin`; Concepts UPDATE via imperative guard |
| DeveloperService | `/api` | `@requires: 'any'` | Per-entity/action mix of `authenticated-user` and `any` |
| HomepageService | `/homepage` | `@requires: 'any'` | |
| SearchService (prod) | `/search` | `@requires: 'any'` | IP rate-limit only |
| SearchService (QA) | `/search` (srv-qa) | `@requires: 'Tutorial.Author'` | Channel-gated |
| EventStreamService | `event-stream` | `@requires: 'any'` | WS + REST |

### A.2 XSUAA scopes (`xs-security.json`)

10 scopes: `Admin`, `SuperAdmin`, `ContentAuthor`, `DeveloperApp`, `MobileApp`, `DisplayApp`, `ConsolidationScope`, `Tutorial.Author`, `KnowledgeGraph.Admin`, `Everyone`.

Role collections: `Tutorials Admin`, `Tutorials SuperAdmin`, `Tutorials Developer`, `Tutorials Display`, `Tutorials Author`, `Tutorials Scanner`.

**Current `authorities` auto-grant (A1 target):** `Tutorial.Author`, `Everyone`. Removing `Tutorial.Author` is A1.

No attribute-restricted scopes are declared — attribute-style row filtering happens in CDS `@restrict where` clauses or JS via `req.user.attr`.

### A.3 Approuter routes (`approuter/xs-app.json`)

40+ routes; scope requirements summarized here. Full audit in the original explore report; the mapping table (Appendix C) references the specific routes touched.

### A.4 Express-route auth

- **`basicAuthMiddleware`** at `srv/server.js:191` — everything registered after gets tech-user auth. Default role fallback → `Admin` (A3 target).
- **`contentAuthMiddleware`** — bearer token (`CONTENT_API_KEY`) for `/content/publish*`, `/content/rollback`, etc.
- **Anonymous routes** — `/health`, `/health/db`, `/api/ui-event`, `/api/advocates*`, `/api/alerts`, `/api/ChatConfig*`, `/api/devtoberfest/(status|terms)`, `/build/*` (audit-list), `/homepage/*`, `/feedback/submit`, `/graph/(neighborhood|Concepts|…)`, `/search/*`, `/socket.io/*`, `/ws/*`, `/rest/*`, `/content/*`, `/tutorials/*` (public read).
- **Admin-gated Express** — `/admin/embeddings/stats`, `/admin/metrics/live`, `/admin/analytics/export`, `/admin/advocates/:slug/photo` — check `user.is('Admin')` in handler.

### A.5 JS-level auth

- `req.user.is('Admin')` — 12 sites
- `req.user.attr` (JWT claims) — 4 sites
- `req.reject(401|403)` — 15 sites
- Anonymous checks (`user.id === 'anonymous'`) — 25 sites
- Bearer/basic middleware — 2 sites (`content-store.js`, `tech-user-auth.js`)

### A.6 Existing auth test coverage

- Smoke: `auth-enforcement.test.js`, `author-scope-routes.smoke.test.js`, `express-route-mutations.test.js`, `csrf-enforcement.test.js`, `xss-reflection.test.js`, `qa-routes.test.ts`, `tutorial-author-fk.smoke.test.js`
- Unit: `srv/kg-service-auth.test.js`, `approuter/xs-app-graph-routes.test.js`, `auth-user-endpoint.test.js`, `check-public-endpoints.test.ts`, `scanner-claim-prize-ownership.test.js`, `author-rebuild-ownership.test.js`, `orphan-purge-endpoint.test.js`, `srv/kg-concepts-write-guard.test.js`
- Hybrid: `kg-neighborhood-anonymous.test.js`, `kg-sparql-execute-json-contract.test.js`

Total: ~9 targeted auth tests. Coverage gaps enumerated in Phase B — Section B5.

---

## Appendix B — Legacy Java IMS authorization surface

Full audit output from parallel Explore agents (2026-07-03). Summarized by category.

### B.1 Global security config

**`WebSecurityConfiguration.java`** — Spring Security 5 style; JWT resource server; `csrf().disable()`.

URL rules:
- `permitAll()` — `/actuator/health`, `/actuator/info`, `/public/**`
- `GET /tutorials`, `/tutorialMeta`, `/tags` — `hasAnyAuthority(SCOPE_Admin, SCOPE_DeveloperApp, SCOPE_ContentAuthor)`
- `anyRequest().authenticated()` fallback

**`BasicAuthBypassFilter`** — reads Basic-Auth header; matches against `AppTechUsers` (from `app.techUsers` yml); on match injects auth with `SCOPE_Admin`. Real elevation path.

**JWT → authority converter** — strips namespace prefix, prepends `SCOPE_`. `imsprod.Admin` → `SCOPE_Admin`.

**`Authority` constants:** `EVERYONE`, `CONTENT_AUTHOR`, `DEVELOPER_APP`, `MOBILE_APP`, `DISPLAY_APP`, `ADMIN`, `SYSTEM`, `CONSOLIDATION_SCOPE`.

### B.2 Controller endpoints × role matrix

~90 controller endpoints across 22 controllers, each with `@PreAuthorize`. Details in the mapping table (Appendix C).

Notable programmatic checks:
- `AccountMergeController.checkOAuthScope()` — literal `consolidation` scope.
- `AuditUserFilter` — extracts `user_uuid` claim for JPA auditing.

### B.3 Repository-level `@PreAuthorize`

25 `@RepositoryRestResource` interfaces with per-method `@PreAuthorize`. Spring Data REST auto-exposes CRUD; the annotations are the primary guard.

Repositories exposed WITHOUT `@PreAuthorize` (rely on global `.authenticated()`): `NGDSFailedMessagesRepository` (`/ngds-failed-messages`).

### B.4 Service-bean method security

Zero `@PreAuthorize` in service beans. All method security is on controllers + repositories.

### B.5 Test coverage

**23 test classes, ~467 `@WithMockUser` cases** all extending `AbstractAuthorizationTest`. Roles exercised: `CONTENT_AUTHOR`, `DEVELOPER_APP`, `MOBILE_APP`, `DISPLAY_APP`, `ADMIN`. Positive/negative allow/forbid matrix per (endpoint × verb × role).

Top files by case count: `TaskRecordAuthorizationTest` (42), `MissionAuthorizationTest` (36), `EventAuthorizationTest` (35), `PrizeAuthorizationTest` (32), `GroupAuthorizationTest` (32), `TutorialAuthorizationTest` (32), `AccomplishmentAuthorizationTest` (29), `UserAuthorizationTest` (29), `CheckpointAuthorizationTest` (28), `TagAuthorizationTest` (28).

### B.6 XSUAA scope model

Scopes (dev): `imsdev.Admin`, `imsdev.ContentAuthor`, `imsdev.DeveloperApp`, `imsdev.MobileApp`, `imsdev.DisplayApp`, `imsdev.Everyone`.

Role templates: `Admin`, `ContentAuthor`, `DeveloperApp`, `MobileApp`, `DisplayApp`, `Everyone`.

`consolidation` scope — externally-configured OAuth client (SCI); not in `xs-security.json`.
`System` scope — internal only; injected by `ServiceSecuritySupport` for background jobs.

---

## Appendix C — Legacy → CAP endpoint mapping

Complete mapping table lives in the Phase C plan document (drafted alongside the implementation plan). Placeholder for the final artifact.

Expected ~60 rows across four "action" columns: **parity** ✅, **tighter (CAP is stricter)** ✅, **removed (no CAP equivalent)**, **looser by design (annotated in code)** ✏️.

Skeleton established in Phase C — Section C1. Full population happens in the Phase C plan.

---

## Change log

- **2026-07-03** — Initial draft. Brainstorming session with Thomas Jung. Design decisions locked: full parity scope; A/B/C decomposition; single master spec covering all three phases; `Tutorial.Author` auto-grant removed; hybrid test framework (in-process + signed-JWT HTTP tier); pragmatic parity for Phase C (`rebuildContent` stays Admin; ScannerService gets tenant-scope check).
