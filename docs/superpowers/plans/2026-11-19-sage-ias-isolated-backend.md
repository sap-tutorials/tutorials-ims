# SAGE IAS Isolated Backend (`srv-sage`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore SAGE IMS sign-in (broken in 2.0.4) by standing up an isolated IAS-authenticated backend (`srv-sage`) serving SAGE's 5 author ops + preview, and repointing the SAGE extension at it — no embedded secret, no change to the main `tutorials-srv`/srv-qa XSUAA auth.

**Architecture:** New CAP app `srv-sage` in `tutorials-ims` (own MTA, `auth: kind:ias + xsuaa:true`), adopting the shared HANA container as `existing-service`, cloning the proven `srv-mcp`/`srv-qa` isolation pattern (dedicated `.cdsrc.json` build task, thin `server.js`). SAGE authenticates via dedicated IAS public-client PKCE and sends the IAS `id_token` as Bearer.

**Tech Stack:** CAP Node.js, `@sap/xssec` v4 (ias), SAP IAS (identity service), HANA (shared), VS Code extension (TypeScript), Mocha unit tests. Deploy via MTA to CF (DEV first).

**Spec:** `docs/superpowers/specs/2026-11-19-sage-ias-isolated-backend-design.md`

## Global Constraints

- No client secret in the SAGE extension, ever. Secret gate (`grep -rnE "clientSecret[[:space:]]*=|client_secret[\"']?[[:space:]]*:" src/`) stays zero.
- Do NOT modify `tutorials-srv` or `srv-qa` auth models, `server.js`, or their XSUAA middleware. `srv-sage` is additive and isolated.
- `srv-sage` auth: `@requires: 'authenticated-user'` only (NOT XSUAA scopes). Authorization is in-handler by caller identity (`assertOwnership`/`provisionDbUser`), ported from `srv/author-service.js`.
- SAGE sends the IAS **`id_token`** as Bearer (not access_token) — xssec `kind:ias` validates `aud === clientid` (PR #2707).
- `tutorials-ims` PRs target **DEV**, never main/PROD directly. SAGE PRs target `main`. Signed commits (SSH) required on both repos.
- IAS service-instance provisioning + redirect-URI config is **Tom-owned** (BTP); the plan hands exact commands, does not run them against prod.
- Rollout: DEV → SAGE `latest-testing` → verify round-trip → PROD + stable 2.0.5.

## Review Focus

- **IAS token audience mismatch:** SAGE sending access_token instead of id_token → every `srv-sage` call 401s (`aud` check). Pinned by Task 6 (client) + Task 8 (live verify).
- **MyOwnedTutorials returns 0:** author join returns 0 for users who never browser-logged-in (known gotcha) — a green auth but empty panel looks like success. Pinned by Task 8 verifying real data, not just 200s.
- **Ownership bypass:** dropping `@requires:'Tutorial.Author'` to `'authenticated-user'` must NOT loosen per-user scoping — any authenticated IAS user must still see only their own tutorials. Pinned by Task 4 handler tests (caller A cannot read caller B's tutorials).
- **Action-path mismatch:** `srv-sage` must serve the exact action-import path the shipped extension calls (`/author/reviewTutorial` vs `/author/AuthorService.reviewTutorial`). Pinned by Task 5.
- **Main-app regression:** a new MTA sharing the HANA container must not disturb `tutorials-srv` XSUAA routes. Pinned by Task 7 smoke check.

---

## Part A — `tutorials-ims` repo (backend + IAS)

### Task 1: IAS provisioning runbook (Tom-owned; plan hands commands)

**Files:** Create `docs/developers/operations/sage-ias-setup.md`

- [ ] **Step 1:** Write the runbook: `cf create-service identity <plan> tutorials-sage-identity -c {...}` with `oauth2-configuration` = public client (PKCE S256, no secret), `redirect-uris` including `vscode://sap-tutorials.sage-tutorial-extension/**`, for DEV and PROD. Mirror `docs/developers/operations/ias-setup.md`.
- [ ] **Step 2:** Document how to read the resulting clientid + tenant URL (for the extension config) and how to add it as `existing-service` in `mta-sage.yaml`.
- [ ] **Step 3:** Commit. (No deploy; Tom runs the `cf` commands out of band and provides the DEV clientid before Task 6's live verify.)

### Task 2: `srv-sage` app skeleton (thin server + package + build task)

**Files:** Create `srv-sage/server.js`, `srv-sage/package.json`; Modify `.cdsrc.json`

**Interfaces:** Produces the `srv-sage` CAP app that later tasks add services to. `auth: { kind: ias, xsuaa: true }`.

- [ ] **Step 1:** `srv-sage/server.js` — copy `srv-mcp/server.js` (77 lines) shape; drop the `/mcp-auth` rewrite region. Healthz + bootstrap only.
- [ ] **Step 2:** `srv-sage/package.json` — copy `srv-mcp/package.json:26-56` `cds.requires`: `auth: {kind:ias, xsuaa:true}`, `db:{kind:hana}`. Remove MCP-specific `MainDeveloperService` remote binding.
- [ ] **Step 3:** `.cdsrc.json` — add build task after the srv-mcp one (`.cdsrc.json:55-64`): `{ "for":"nodejs", "src":"srv-sage", "dest":"srv-sage", "options": { "model": ["srv-sage","db"] } }`.
- [ ] **Step 4:** Verify build task compiles an empty-but-valid model: `npx cds build --production 2>&1 | grep -i srv-sage` → shows srv-sage built, no error.
- [ ] **Step 5:** Commit (signed).

### Task 3: `srv-sage` author service model (5 ops, IAS-gated)

**Files:** Create `srv-sage/author-sage-service.cds`

**Interfaces:** Produces `AuthorSageService` exposing: entities `MyOwnedTutorials` (from `db/views`), `Tags`; actions `isSlugAvailable(slug) returns {value:Boolean}`, `reviewTutorial(tutorialId)`, `snoozeTutorial(tutorialId, days)`. All `@requires: 'authenticated-user'`.

- [ ] **Step 1:** Write the `.cds`: `using { com.sap.developers.ims } from '../db/schema';` + `using from '../db/views';`. Define the service with `@path` matching what the extension calls (resolve in Task 5), the 2 read entities + 3 actions, service-level `@requires: 'authenticated-user'`. Do NOT `using { AdminService }`.
- [ ] **Step 2:** `npx cds compile srv-sage/author-sage-service.cds` → compiles with no unresolved refs.
- [ ] **Step 3:** Commit (signed).

### Task 4: `srv-sage` handlers (ported, with ownership tests)

**Files:** Create `srv-sage/author-sage-service.js`, `srv-sage/lib/` (bundled `resolve-db-user` + minimal deps); Test: `srv-sage/test/author-sage.test.js` (or repo's test location)

**Interfaces:** Consumes the model from Task 3. Ports from `srv/author-service.js`: `MyOwnedTutorials` caller-scoped read, `Tags` read, `isSlugAvailable`, `reviewTutorial`, `snoozeTutorial`, plus `assertOwnership`/`provisionDbUser`/`resolveDbUser`. No AI/GitHub/credstore imports.

- [ ] **Step 1 (RED):** Write handler test: two distinct authenticated identities A and B; A's `MyOwnedTutorials` returns only A's tutorials, and A calling `reviewTutorial` on B's tutorialId is rejected (ownership). Use the repo's CAP test harness (in-memory sqlite or test HANA).
- [ ] **Step 2:** Run → FAIL (no handler).
- [ ] **Step 3:** Implement handlers, porting the identity-resolution + ownership logic verbatim from `srv/author-service.js` (adapt the auth-context read for `kind:ias`).
- [ ] **Step 4:** Run → PASS; ownership enforced.
- [ ] **Step 5:** Commit (signed).

### Task 5: Preview route in `srv-sage` + pin action path

**Files:** Create `srv-sage/preview-renderer.js` (+ `srv-sage/lib/parsers.bundle.mjs`), wire route in `srv-sage/server.js`; reference: deployed extension source

- [ ] **Step 1:** Pin the action-path: read `imsApiClient.ts` on SAGE `main` (un-minified) — record whether it calls `/author/reviewTutorial` (bare) or `/author/AuthorService.reviewTutorial`. Set `srv-sage`'s service `@path` + action names to serve the exact path the shipped 2.0.4 extension uses (so DEV testing works without a client change), noting any client alignment needed in Task 6.
- [ ] **Step 2:** Port `srv-qa/preview-renderer.js` (194 lines, Node builtins + `./lib/parsers.bundle.mjs` only) into `srv-sage/`; wire `POST /preview/render` in `srv-sage/server.js` behind the same IAS auth as the service (authenticated-user).
- [ ] **Step 3:** Test: `POST /preview/render` with sample markdown returns rendered HTML (port a minimal case from any existing preview test).
- [ ] **Step 4:** Run → PASS. Commit (signed).

### Task 6: `mta-sage.yaml` (new MTA, existing-service adoption)

**Files:** Create `mta-sage.yaml`; Modify `docs/developers/operations/mta-deployment.md` (document the new MTA)

- [ ] **Step 1:** Write `mta-sage.yaml` mirroring `mta-mcp.yaml`: module `tutorials-srv-sage` (`path: gen/srv-sage`); adopt as `existing-service`: `tutorials-hana`, `tutorials-sage-identity` (IAS), `tutorials-xsuaa` (hybrid fallback). Build: `npm install` + `cds build --production`. No credstore/destination.
- [ ] **Step 2:** `mbt build -f mta-sage.yaml -t mta_archives` (wrap noisy output) → produces mtar, no error.
- [ ] **Step 3:** Document the MTA + its `existing-service` dependency on the main MTA (deploy main first) in mta-deployment.md.
- [ ] **Step 4:** Commit (signed). **Open PR → DEV.**

### Task 7: Deploy to DEV + main-app regression smoke (Tom-gated deploy)

- [ ] **Step 1:** After PR merges to DEV and Tom has provisioned `tutorials-sage-identity` (Task 1): deploy `mta-sage.yaml` to DEV (`cf deploy`, Tom-authorized). 
- [ ] **Step 2:** Smoke: `tutorials-srv` XSUAA browser route still works (hit an existing authenticated endpoint) — confirms the shared-HANA new MTA didn't disturb the main app.
- [ ] **Step 3:** Record the DEV `srv-sage` host URL + DEV IAS clientid/tenant for Part B.

---

## Part B — SAGE extension repo

### Task 8: Repoint SAGE auth + API to IAS/`srv-sage`; testing release; verify

**Files (SAGE repo):** Modify `src/lib/sync/imsAuth.ts`, `src/lib/ims/imsApiClient.ts`, `CHANGELOG.md`, `RELEASE-NOTES.md`, `package.json` (→ 2.0.5)

- [ ] **Step 1:** `imsAuth.ts` — change `authUrl`/`tokenUrl` to the IAS tenant (`https://<tenant>/oauth2/authorize` + `/oauth2/token`), `clientId` to the dedicated SAGE IAS clientid. Keep PKCE + state. **Return the `id_token`** (not `access_token`) from `createSessionFromToken`/`getAccessToken` — per PR #2707. Keep secret absent.
- [ ] **Step 2:** `imsApiClient.ts` — base URL → DEV `srv-sage` host (Task 7). Align action path to Task 5's pinned form if needed.
- [ ] **Step 3:** Update/extend unit tests for the changed auth (id_token selection) + client base.
- [ ] **Step 4:** Secret gate zero; `tsc`/compile/lint clean; unit suite green.
- [ ] **Step 5:** Bump 2.0.5, CHANGELOG/RELEASE-NOTES. Commit (signed). Open PR → `main`.
- [ ] **Step 6 (VERIFICATION GATE — Tom):** After merge, cut SAGE `latest-testing` pointed at DEV. Tom installs, signs in. **Confirm: sign-in succeeds AND My Tutorials shows real tutorials (not 0) AND preview renders.** Only on pass does the project proceed to stable PROD (`srv-sage` PROD deploy + stable 2.0.5) — a separate, explicitly-authorized step outside this plan.

## Notes for executor

- Live IAS round-trip and all CF deploys are Tom-gated — the plan builds and tests everything buildable/testable; the DEV deploy (Task 7) and the testing-release verify (Task 8.6) require Tom. Do not claim the fix works until Task 8.6 passes.
- Part A and Part B are sequential (B needs A's DEV host + clientid). Within Part A, Tasks 2→6 are a build chain; Task 1 (runbook) is independent and can go first.
- The `@requires` downgrade to `authenticated-user` is safe ONLY because in-handler ownership is ported intact (Task 4) — do not skip the A-vs-B ownership test.
