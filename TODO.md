# Gap Analysis — tutorials-poc

## Executive Summary

The tutorials-poc project has a working **learner-facing frontend** (tutorial navigation, progress tracking, App Space event view) and a **CAP backend** that is substantially complete. The CDS data model covers all 35 IMS entities, all 4 services are implemented with handlers, the job scheduler is running, and the STOMP broker is wired. The remaining gaps are: **admin UI** (no frontend for admin operations), **content push pipeline** (template only, not deployed), **static content webhook** (no CI/CD), and a few backend edge cases not yet validated against production IMS.

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
- [ ] **Integration testing against real HANA** — Unit test coverage unknown; need to verify CDS compiles and deploys to HDI container
- [ ] **Adobe Analytics destination config** — Client exists but BTP Destination for `sap.d1.sc.omtrdc.net` may not be configured
- [ ] **NGDS destination config** — Client exists but BTP Destination not verified
- [ ] **Mail service binding** — `mail-client.js` exists but no BTP Mail Service instance confirmed
- [ ] **Leaderboard cache** — DisplayService has `getLeaderboard` but no TTL cache (IMS uses 600s eventId cache)
- [ ] **Production smoke tests** — No automated deployment verification suite
- [x] **Plan checkboxes** — The 4 plan files in `docs/superpowers/plans/` still show all tasks unchecked; update them to reflect reality

---

## 2. Admin UI (Entirely Missing)

The IMS React 15 admin frontend has **11 pages** — none have equivalents:

- [ ] Tutorial Dashboard (freshness/ownership tracking) — **HIGH** priority, most operationally important
- [ ] Mission Management (nested completion paths) — **HIGH** priority, complex nested form
- [ ] Groups Management (CRUD) — **HIGH** priority, required for mission composition
- [ ] Events Management (CRUD) — **MEDIUM** priority, currently hardcoded (`eventId=38`)
- [ ] Privacy/GDPR Tools (lookup + anonymize) — **MEDIUM** priority, compliance requirement
- [ ] Board/Analytics Dashboard (KPIs + charts) — **MEDIUM** priority, operational visibility
- [ ] Featured Tasks Curation — **MEDIUM** priority, homepage curation tool
- [ ] Prizes Management (simple CRUD) — **LOW** priority, name-only entity
- [ ] Accomplishments Management (rule-based badges) — **LOW** priority, SQL rules engine
- [ ] Statistics Export (CSV download) — **LOW** priority, date-range form
- [ ] Tags (read-only table) — **LOW** priority, reference data

---

## 3. AEM Endpoints Still Active

3 of 8 frontend endpoints still route through AEM:

- [ ] Progress Series (`/bin/ims/progressSeries`) — AppSpace.vue completion data; needs slug-to-IMS-ID mapping in CAP
- [ ] Solr Search (`/bin/ims/search`) — Icon/tag lookup for tutorial cards; need CAP equivalent or direct tag resolution
- [ ] QR Code (`/bin/ims/qrcode`) — PNG generation for event badges; already has `/api/qrcode` in CAP — verify wiring

Endpoints 1, 5, 6, 7, 8 are replaced by CAP. The AEM proxy layer can be fully retired once these 3 are resolved.

---

## 4. Content Push Pipeline (Template Only)

Current state: `docs/tutorial-repo-dispatch.yml` is a **template** workflow file, not deployed anywhere.

- [ ] Install workflow in sap-tutorials repos (or at org level via reusable workflow)
- [ ] Fill in `<OWNER>` placeholder in the dispatch URL
- [ ] Create receiving workflow in tutorials-poc (`.github/workflows/rebuild-on-dispatch.yml`)
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

- [ ] **Email retry dashboard** — `FailedEmails` entity exists and retry job runs, but no UI to inspect/manage failed emails
- [ ] **NGDS failed message inspector** — `NGDSFailedMessages` entity has data but no admin view to triage failures
- [ ] **Notification 4-stage escalation** — Current impl does level-based routing but needs verification against IMS's exact stage-0/1/2/3 logic and resend-after-1-month timing

---

## 8. Priority Ranking (Updated)

| # | Gap | Impact | Effort | Status |
|---|-----|--------|--------|--------|
| 1 | Content push pipeline (dispatch + receiving workflow) | Blocks author workflow | Low | Not started |
| 2 | Static content webhook (CI/CD redeploy) | Blocks production content updates | Medium | Not started |
| 3 | AEM endpoint retirement (3 remaining) | Blocks AEM decommission | Medium | QR done, 2 remain |
| 4 | Admin UI — Tutorial Dashboard | Blocks content operations | High | Not started |
| 5 | Admin UI — Missions + Groups CRUD | Blocks content curation | High | Not started |
| 6 | BTP service bindings (Mail, NGDS dest, Analytics dest) | Blocks production job execution | Medium | Code done, config needed |
| 7 | GDPR/Privacy tools (admin UI) | Compliance risk | Medium | Backend done, no UI |
| 8 | Integration testing on HANA | Confidence in deploy | Medium | Not started |
| 9 | Real-time display (frontend WebSocket) | Event experience degradation | Medium | Backend done, frontend not wired |
| 10 | Plan doc cleanup | Housekeeping | Low | Plans show unchecked but work is done |

---

## 9. Immediate Action Items

- [ ] Deploy the dispatch workflow to at least one sap-tutorials repo as proof-of-concept
- [ ] Create the receiving workflow in tutorials-poc (`.github/workflows/rebuild.yml`)
- [ ] Wire the 2 remaining AEM endpoints to CAP (progress series slug mapping is the key blocker; QR code already done)
- [ ] Configure BTP Destinations for NGDS and Adobe Analytics
- [ ] Verify `cds deploy --to hana` succeeds with the full 35-entity schema
- [ ] Decide on static content delivery — full MTA redeploy vs. HTML5 Repository vs. `cf push approuter`

---

## 10. Reported Bugs (Team Feedback 2026-04-29)

- [ ] **Tutorial search blanks the screen** — Typing in the Navigator search causes the page to go blank (likely a Vue reactivity or error boundary issue in TutorialNavigator)
- [ ] **App Space not showing data** — AppSpace.vue fails to display event/progress data (check `/api/getEventProgress` response and hardcoded `eventId`)
- [ ] **Dark mode toggle not working** — Theme toggle button doesn't flip `data-theme` or persist to localStorage
- [ ] **Mission/Group pages return 404** — Some mission/group links lead to non-existent pages (content generation only produces pages for missions with populated `slug` fields; see `populate-slugs` migration step)
