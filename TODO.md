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
- [x] **STOMP WebSocket broker** (`srv/lib/stomp-broker.js`) — Attached to HTTP server on `cds.on('listening')`, broadcasts on tutorial completion
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

## 4. Content Push Pipeline (Template Only)

Current state: `docs/tutorial-repo-dispatch.yml` is a **template** workflow file, not deployed anywhere.

- [ ] Install workflow in sap-tutorials repos (or at org level via reusable workflow)
- [ ] Fill in `<OWNER>` placeholder in the dispatch URL
- [ ] Create receiving workflow in tutorials-ims (`.github/workflows/rebuild-on-dispatch.yml`)
- [ ] Configure `TUTORIALS_DISPATCH_TOKEN` secret (GitHub PAT with repo scope)

---

## 5. Static Content Update Webhook (Not Implemented)

No mechanism exists to update the AppRouter's static content when tutorials change.

- [ ] Decide on delivery approach:
  - Option A: GitHub Actions dispatch → rebuild → `cf deploy` (simplest, full redeploy)
  - Option B: GitHub Actions dispatch → rebuild → push to HTML5 Repository (incremental)
  - Option C: Hybrid — rebuild static + `cf push approuter` only (faster than full MTA)
- [ ] Implement CI/CD pipeline for chosen approach
- [ ] Test end-to-end: tutorial commit → dispatch → rebuild → deployed content updated

---

## 6. Real-Time Event Display (Deferred to Phase 2)

- [ ] WebSocket subscription in AppSpace.vue (currently fetches once on mount)
- [ ] Display UI equivalent (big-screen dashboard for events) — separate React app in IMS
- [ ] STOMP broker already registered in `srv/server.js` — wire frontend to it
- [ ] **Research: Replace custom STOMP broker with `@cap-js/websocket` plugin** — The official CAP WebSocket plugin exposes CDS services over WebSocket/Socket.IO via a simple `@protocol: 'websocket'` annotation. Would replace our hand-rolled `srv/lib/stomp-broker.js` + manual `ws` dependency + `cds.on('listening')` wiring with a declarative CDS event model. Supports both standard WebSocket and Socket.IO, integrates with CDS auth, and eliminates custom Express attachment code. Current STOMP broker broadcasts `tutorialCompleted` events — these would become CDS events on the DisplayService. See <https://cap.cloud.sap/docs/plugins/#websocket>

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
- [ ] **Notification 4-stage escalation** — Current impl does level-based routing but needs verification against IMS's exact stage-0/1/2/3 logic and resend-after-1-month timing
- [ ] **Research: Telemetry plugin (`@cap-js/telemetry`)** — Provides automatic OpenTelemetry instrumentation for traces, metrics, and logs with zero code changes. Shows hierarchical timing breakdowns (request → service → DB query) in console during dev. Exports to SAP Cloud Logging, Dynatrace, or Jaeger in production. Would give visibility into slow endpoints (e.g. `createTaskRecord` with accomplishment evaluation, NGDS calls, account merge), job execution times, and DB query performance — critical for operating at scale with 7 scheduled jobs and multiple external integrations. See <https://cap.cloud.sap/docs/plugins/#telemetry>
- [ ] **Research: ORD plugin (`@sap/cds-ord`)** — Generates Open Resource Discovery documents exposing a standard metadata catalog of all CDS services, entities, and APIs. Provides a single Service Provider Interface endpoint for external systems to automatically discover available resources. Would make our 4 services (DeveloperService, AdminService, DisplayService, ConsolidationService) discoverable by BTP integration tools, API Management, and other SAP landscape systems without manual documentation. Supports both static catalog generation and runtime inspection. See <https://cap.cloud.sap/docs/plugins/#ord-open-resource-discovery>
- [ ] **Research: Swagger UI (`cds-swagger-ui-express`)** — Community plugin that mounts an interactive Swagger UI at dev time, auto-generated from CDS service definitions. Registers on `cds.on('bootstrap')` with a one-liner and serves OpenAPI specs for all services. Dev-only (gated behind `NODE_ENV !== 'production'`). Would give developers and API consumers an interactive explorer for DeveloperService, AdminService, DisplayService, and ConsolidationService endpoints without maintaining separate API docs. Also supports `cds compile srv --to openapi` for static spec generation. See <https://www.npmjs.com/package/cds-swagger-ui-express>

---

## 8. Priority Ranking (Updated)

| # | Gap | Impact | Effort | Status |
|---|-----|--------|--------|--------|
| 1 | Content push pipeline (dispatch + receiving workflow) | Blocks author workflow | Low | Not started |
| 2 | Static content webhook (CI/CD redeploy) | Blocks production content updates | Medium | Not started |
| 3 | AEM endpoint retirement (0 remaining) | Blocks AEM decommission | Medium | **Done** — all 8 wired to CAP |
| 4 | Admin UI — Tutorial Dashboard | Blocks content operations | High | **Done** — PR #1 |
| 5 | Admin UI — Missions + Groups CRUD | Blocks content curation | High | **Done** — PR #1 |
| 6 | BTP service bindings (Mail, NGDS dest, Analytics dest) | Blocks production job execution | Medium | Code done, config needed |
| 7 | GDPR/Privacy tools (admin UI) | Compliance risk | Medium | **Done** — PR #1 |
| 8 | Integration testing on HANA | Confidence in deploy | Medium | **Done** — 91 tests passing |
| 9 | Real-time display (frontend WebSocket) | Event experience degradation | Medium | Backend done, frontend not wired |
| 10 | Plan doc cleanup | Housekeeping | Low | Plans show unchecked but work is done |

---

## 9. Immediate Action Items

- [ ] Deploy the dispatch workflow to at least one sap-tutorials repo as proof-of-concept
- [ ] Create the receiving workflow in tutorials-poc (`.github/workflows/rebuild.yml`)
- [x] Wire all AEM endpoints to CAP (progress series, search, QR code — all complete)
- [ ] Configure BTP Destinations for NGDS and Adobe Analytics
- [ ] Verify `cds deploy --to hana` succeeds with the full 35-entity schema
- [ ] Decide on static content delivery — full MTA redeploy vs. HTML5 Repository vs. `cf push approuter`

---

## 10. Reported Bugs (Team Feedback 2026-04-29)

- [ ] **Tutorial search blanks the screen** — Typing in the Navigator search causes the page to go blank (likely a Vue reactivity or error boundary issue in TutorialNavigator)
- [ ] **App Space not showing data** — AppSpace.vue fails to display event/progress data (check `/api/getEventProgress` response and hardcoded `eventId`)
- [ ] **Dark mode toggle not working** — Theme toggle button doesn't flip `data-theme` or persist to localStorage
- [ ] **Mission/Group pages return 404** — Some mission/group links lead to non-existent pages (content generation only produces pages for missions with populated `slug` fields; see `populate-slugs` migration step)
