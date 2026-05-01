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
- [ ] Verify `cds deploy --to hana` succeeds with the full 35-entity schema
- [x] Decide on static content delivery — rebuild endpoint on AppRouter (`/admin/rebuild`)

---

## 10. Reported Bugs (Team Feedback 2026-04-29)

- [x] **App Space not showing data** — Root cause: EventDisplay required an `imsUrl` URL parameter (legacy from Java IMS era). Fixed by removing the parameter and using relative URLs via AppRouter proxy. Also added `/rest/` route to `xs-app.json`. AppSpace.vue itself was already using relative paths correctly.
- [x] **Dark mode toggle not working** — Root cause: `toggleTheme()` handler only existed in `tutorial.ts` (loaded only on tutorial detail pages). Fixed by moving the click delegation handler to the inline `<script>` in `head.html` (runs on all pages). Also fixed toggle alignment in shellbar (added explicit height, line-height:0, centered thumb).
- [ ] **Mission/Group pages return 404** — Some mission/group links lead to non-existent pages (content generation only produces pages for missions with populated `slug` fields; see `populate-slugs` migration step)
