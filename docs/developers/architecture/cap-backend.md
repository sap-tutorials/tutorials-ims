---
title: CAP Backend
description: Services, entities, jobs, and bootstrap details for the Node.js CAP service under srv/.
---

# CAP Backend

> Source: extracted from project README, 2026-05-25.

The CAP Node.js service is the complete replacement for the Java IMS Spring Boot application.

## Services

CDS `@requires` is the in-process gate; the AppRouter ([approuter/xs-app.json](../../../approuter/xs-app.json)) adds additional XSUAA scope checks per route in front of `/api/*`, `/admin/*`, etc. — see [docs/developers/operations/testing-endpoints.md](../operations/testing-endpoints.md) for the canonical route → scope mapping.

| Service | Path | `@requires` | Purpose |
|---------|------|-------------|---------|
| DeveloperService | `/api` | `any` | Tutorial progress, step completion, event progress, `ChatConfig` public projection, `getRelevantSteps` for non-RAG fallback |
| AdminService | `/admin` | `Admin` | Full CRUD over admin entities, GDPR anonymization, Joule settings (singleton), audit-log + change-tracking surface |
| AnalyticsService | `/admin/analytics` | `Admin` | Ad-hoc analytics — entity browser over `@analytics.exposed` views + `runSelectQuery` action (SELECT-only, allowlisted, `LIMIT 5001`) |
| ExportsService | `/admin/exports` | `Admin` | Long-running export jobs (CSV / Excel) for missions, accounts, completions |
| DisplayService | `/display` | `DisplayApp` | Event leaderboard, burnup charts, track stats — feeds the rotating event-monitor dashboard via Socket.IO events on the `/ws/display` namespace |
| ConsolidationService | `/api/v1` | `ConsolidationScope` | Account merge + legacy IMS endpoint compatibility for cutover-era integrations |
| ScannerService | `/scanner` | `authenticated-user` | UI5 barcode-scanner functions: `getContestant(accountNumber)`, `claimPrize(recordId)`. Approuter route additionally gates with scope `MobileApp` |
| SearchService | `/search` | `any` | `SearchableItems` HANA full-text projection — backs the global search bar, navigator, and Joule's `searchTutorials` tool |
| ChatService | `/chat` | `authenticated-user` | ORD-symmetric shell with no entities; the streaming work happens at `POST /chat/stream` (Express, registered in `bootstrap`) |
| EventStreamService | `event-stream` | `any` | WebSocket + REST event-stream feed for live tutorial-completion broadcasts |

The QA channel runs a parallel `tutorials-srv-qa` app (separate HDI container, separate slug-bytes URL) with its own service set focused on author-preview workflows: `ContentService` (preview, publish-to-QA), `SearchService` (QA-scoped), and the `POST /preview/render` endpoint consumed by the VSCode extension. All QA services require XSUAA scope `Tutorial.Author`. See [docs/developers/operations/qa-channel-bootstrap.md](../operations/qa-channel-bootstrap.md).

## Built-in CAP Endpoints

CAP exposes additional routes that aren't defined in CDS but are useful (and dangerous) in production. The defaults in [srv/server.js](../../../srv/server.js) lock these down — see lines 47-71 for the gate.

| Route | What it is | Production state |
|-------|-----------|------------------|
| `/` | CAP launchpad / welcome page (lists services + entities) | **Blocked** in production by an early-middleware 404 unless `EXPOSE_CAP_UI=true` |
| `/_dev/*` | Same launchpad surface for `cds watch`-style dev exploration | Approuter route gates with scope `Admin`; CAP only mounts it when `cds.env.server.index = true` (set by `EXPOSE_CAP_UI=true`) |
| `/$api-docs/*` | Swagger UI + OpenAPI 3 specs (one per service, with diagram) | Blocked by the same middleware. Only enabled when `EXPOSE_CAP_UI=true`; approuter route additionally requires scope `Admin` |
| `/<service-path>/$metadata` | OData v4 metadata document — exists for every CDS service automatically | Always available behind the service's normal auth (`@requires` + approuter scope) — relied on by Fiori Elements + the admin shell components |
| `/<service-path>/<EntitySet>` | OData v4 collection endpoints generated from `entity` / `view` declarations in each service `.cds` | Always available; auth follows the parent service |

`EXPOSE_CAP_UI` is intentionally NOT set on `tutorials-srv` in production. To temporarily enable the launchpad for debugging, set the env var on the live app, restart, and unset it when done:

```bash
cf set-env tutorials-srv EXPOSE_CAP_UI true && cf restart tutorials-srv
# … debug via /_dev under an Admin token …
cf unset-env tutorials-srv EXPOSE_CAP_UI && cf restart tutorials-srv
```

`tutorials-srv-qa` explicitly sets `EXPOSE_CAP_UI: false` in `mta.yaml` (see [.deploy/mta.yaml](../../../.deploy/mta.yaml)) — the QA service must never expose the launchpad even by accident, since the QA HDI container holds in-flight author content.

## Custom Endpoints (Express)

Registered on `cds.on('bootstrap')` in [srv/server.js](../../../srv/server.js) (a few in `served` once `cds.middlewares` is available). These run as raw Express routes — no OData parsing, no entity layer — and either bypass CAP's auth entirely (public probes, build-time data) or compose `context + auth` middleware manually.

A few are registered in `bootstrap` *specifically* to reserve the path before CAP's OData router mounts a service at the same prefix (`/admin/*`, `/chat/*`). Without that reservation OData would interpret the path as a resource and return `Invalid resource path` / `404`.

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/health` | GET | None | Liveness probe — always returns 200 + timestamp |
| `/health/db` | GET | None | Readiness probe — runs `SELECT 1 FROM DUMMY` against the bound HDI; returns 503 on connection error |
| `/auth/user` | GET | XSUAA | Returns `{ authenticated, id, email, givenName, familyName }` for the current IDP session — used by Joule and the admin shell to greet by first name |
| `/api/qrcode` | GET | XSUAA (via approuter) | Generates a per-tutorial QR PNG for the event-floor scanner UI |
| `/api/recommendations` | GET | XSUAA (via approuter) | Personalized "what's next" rail — blends embedding centroid + co-completion |
| `/build/catalog` | GET | None | Mission + group catalog for the static-site Hugo build |
| `/build/navigator` | GET | None | Side-nav tree (mission → group → tutorial) for the navigator Vue island |
| `/build/slug-mapping` | GET | None | Numeric-legacyId → slug map, used by migration + redirect tooling |
| `/build/co-completions` | GET | None | Co-completion graph used by `/api/recommendations` and admin analytics |
| `/build/repo-catalog` | GET | None | RepoCatalog snapshot — which slugs live in which `sap-tutorials/*` repo |
| `/build/repo-catalog` | POST | Bearer `CONTENT_API_KEY` | Authoritative writer; `rebuild-content.yml` posts after every full fetch |
| `/content/nav` | GET | None | Manifest navigation metadata for the active content version |
| `/content/hashes` | GET | None | `{ slug: sha256 }` map of currently-served tutorials — read by `publish-content.ts` for delta computation |
| `/content/tutorials/*slug` | GET | None (via approuter `/tutorials/*`) | Decompresses + serves tutorial HTML from HANA BLOBs with ETag + bounded LRU cache (50 MB) |
| `/content/publish` | POST | Bearer `CONTENT_API_KEY` | Accepts `{ trigger, hugoVersion, files: { slug: base64gzip } }` — creates a new manifest version and triggers async embedding pipeline via `setImmediate` |
| `/content/rollback` | POST | Bearer `CONTENT_API_KEY` | Reverts the active manifest to the previous version |
| `/feedback/submit` | POST | None (rate-limited, via approuter) | Bridge to `DeveloperService.submitTutorialFeedback` action — derives client IP from leftmost `X-Forwarded-For` and injects via `AsyncLocalStorage`. Requires `SUBMISSION_SALT_SECRET` or returns 503 |
| `/chat/stream` | POST | XSUAA + `authenticated-user` | Joule SSE streaming — reserved in `bootstrap` (before `ChatService` mounts at `/chat`); the late-bound dispatcher is replaced in `served` once `cds.middlewares` exists |
| `/admin/embeddings/stats` | GET | XSUAA + `Admin` | RAG embedding coverage stats for the Joule admin tile — reserved before `AdminService` OData router mounts at `/admin` |
| `/admin/analytics/*` | ALL | XSUAA + `Admin` | Reservation for the `AnalyticsService` OData adapter — without this, the `AdminService` OData router at `/admin` intercepts first and 404s |
| `/admin/exports/exportLegacyData` | GET | XSUAA + `Admin` | Streaming legacy-data export bridge — same OData-collision reservation pattern as the analytics path |

`/search` is a regular CDS service surface but is wrapped in `bootstrap` with a per-IP rate limiter ([srv/lib/ip-rate-limit.js](../../../srv/lib/ip-rate-limit.js); 60 req/min default, tunable via `SEARCH_RATE_LIMIT_MAX` / `SEARCH_RATE_LIMIT_WINDOW_MS`).

For the canonical end-to-end smoke matrix (route → upstream service → expected response), see [docs/developers/operations/testing-endpoints.md](../operations/testing-endpoints.md).

## WebSocket (Socket.IO)

Real-time event-floor dashboards subscribe to tutorial-completion events over a Socket.IO transport. Two CAP services expose the WS surface alongside their OData projections — see `@protocol: ['odata', 'websocket']` on [DisplayService](../../../srv/display-service.cds#L3) (XSUAA `DisplayApp`, includes user name) and `@protocol: ['websocket', 'rest']` on [EventStreamService](../../../srv/event-stream-service.cds#L1) (anonymous, kiosk-friendly, payload minus PII). Clients connect to Socket.IO namespaces `/ws/display` and `/ws/event-stream`; the underlying transport URL is `/socket.io/?EIO=4&transport=websocket`.

**Why Socket.IO, not raw WebSocket.**

- **Topic-based fan-out is built in.** Each event monitor subscribes only to its own event ID — the server filters automatically via the `contexts: [String(event.legacyId)]` argument to `cds.connect.to('DisplayService').emit(...)` (see [srv/developer-service.js:494](../../../srv/developer-service.js#L494)). The CAP WebSocket plugin maps `contexts` onto Socket.IO rooms; with raw WS we'd reinvent the routing table by hand.
- **Reconnection, heartbeats, and transport fallback come for free.** `socket.io-client` (~30 KB minified) handles automatic reconnect, heartbeat ping/pong, and falls back from WebSocket to long-polling on locked-down networks — useful for kiosks behind corporate proxies.
- **Authenticated vs anonymous split is one config change, not a separate stack.** `DisplayService` is gated by XSUAA scope `DisplayApp`; `EventStreamService` is anonymous (`@requires: 'any'`) and emits the same payload minus PII. The handler in `developer-service.js` emits to both sequentially with the same `contexts:` filter.

**Implementation.** [`@cap-js-community/websocket`](https://www.npmjs.com/package/@cap-js-community/websocket) is the CAP plugin doing the WS plumbing — declaring `@protocol: 'websocket'` on a service is enough to mount the namespace; emitting a CDS `event` (e.g. `event tutorialCompleted { ... }` in the `.cds`) becomes a Socket.IO event on the corresponding namespace. The transport is selected via `"websocket": { "kind": "socket.io" }` in [package.json](../../../package.json) (the plugin also supports `ws` and STOMP). No custom broker code lives in this repo — `socket.io@^4.8.0` runs in `tutorials-srv`, and `socket.io-client@^4.8.0` ships in [app/display-app/](../../../app/display-app/) and the `event-display` / `app-space` islands in [hugo-apps/](../../../hugo-apps/).

**Production access.** Approuter routes `^/socket\.io/` and `^/ws/` are wired with `authenticationType: 'none'` (see [approuter/xs-app.json](../../../approuter/xs-app.json#L155-L168)) — the WS handshake itself bypasses approuter auth, and `DisplayService` enforces the `DisplayApp` scope at the CAP layer when a connection joins the `/ws/display` namespace.

## Scheduled Jobs

Registered via `cds.on('served')` in [srv/jobs/scheduler.js](../../../srv/jobs/scheduler.js). Every job is wrapped in `runWithLock(name, durationMs, fn)` ([srv/jobs/job-lock.js](../../../srv/jobs/job-lock.js)) — only one instance runs each tick across the CF app fleet. The pipeline log row created per run is queryable in the admin shell with a virtual `cfLogsUrl` jumping straight to the matching Cloud Logging window (±10s/+30s padding around the run).

| Cron | Job | Description |
|------|-----|-------------|
| `0 0 * * *` (00:00 daily) | `cleanup-step-failures` | Removes `StepFailure` rows older than 90 days |
| `0 1 * * *` (01:00 daily) | `account-merge-batch` | Processes scheduled account merges queued by `ConsolidationService` |
| `0 */2 * * *` (every 2h) | `ngds-retry` | Retries failed NGDS message deliveries |
| `0 3 * * *` (03:00 daily) | `content-gc` | Prunes `ContentFiles` versions in `SUPERSEDED` / `ROLLED_BACK` state older than 7 days, keeping the last 3 for rollback. Never touches `ACTIVE` or `PUBLISHING` |
| `15 3 * * *` (03:15 daily) | `pipeline-log-gc` | Prunes `PipelineLog` entries older than 30 days |
| `30 3 * * *` (03:30 daily) | `embedding-orphan-prune` | Deletes `TutorialEmbedding` rows for slugs no longer in the active manifest |
| `30 * * * *` (hourly :30) | `content-publishing-sweep` | Marks `PUBLISHING` manifests stuck > 60 min as `FAILED` (recovers crashed publishes) |
| `17 * * * *` (hourly :17) | `embedding-reconciliation` | Re-embeds tutorial steps whose `contentHash` drifted; offset to `:17` to dodge the `:00` thundering herd |
| `0 2 * * 0` (Sun 02:00 weekly) | `tutorial-metadata-review` | Self-healing backfill of any missing `TutorialMeta` rows (publish writes them inline; this catches drift) |
| `0 9 * * 1` (Mon 09:00 weekly) | `contributor-notifications` | Computes stale-tutorial notifications, resolves recipients (author + admin CC), sends escalating emails (180-day threshold) |
| `0 */4 * * *` (every 4h) | `email-retry` | Retries failed mail deliveries from the `MailQueue` |
| `0 0 2 1,7 *` (Jan 2 / Jul 2 00:00) | `tag-cleanup` | Removes unused `Tags` rows |

## Key Libraries (srv/lib/)

| File | Purpose |
|------|---------|
| `accomplishment-evaluator.js` | Evaluate badge/accomplishment rules against user progress |
| `account-merge.js` | Merge duplicate user accounts |
| `admin-analytics-runner.js` | Execute curated analytics queries against the allowlisted schema with PII guards |
| `admin-analytics-schema.js` | Allowlist of facts, dimensions, and PII denylist exposed via `AnalyticsService` |
| `admin-docs-index.js` | Load + search the prebuilt admin-docs index used by the Joule `searchAdminDocs` tool |
| `adobe-analytics.js` | Adobe Analytics XML beacon on tutorial completion |
| `analytics-sql-validator.cjs` | Parse + restrict ad-hoc SQL to SELECT-only against allowlisted tables (`runSelectQuery`) |
| `anonymization.js` | Build the operations descriptor to anonymize a user's personal data |
| `build-catalog.js` | Build pipeline data (missions, paths, tutorials) |
| `cf-logs-link.js` | Compose Cloud Logging dashboard URLs from the CF binding + app metadata |
| `chat-context.js` | Joule chat personas (learner + admin) and grounding rules for tool use |
| `chat-orchestrator.js` | Joule turn loop: orchestration client, tool definitions, multi-turn dispatch |
| `chat-rate-limit.js` | Per-user 24-hour sliding-window chat rate limiter |
| `co-completion.js` | Cached co-completion matrix ("learners who completed X also completed Y") |
| `content-store.js` | Tutorial HTML BLOB store: publish, manifest versioning, decompress + serve |
| `contributor-notifications.js` | Compute stale tutorials, escalation routing, config helpers |
| `embedding-client.js` | Azure OpenAI embedding client with batching + retry |
| `embedding-pipeline.js` | Compute + persist tutorial step embeddings (chunked, distributed-lock guarded) |
| `embedding-query.js` | Embed user query and rank steps by cosine similarity (RAG retrieval) |
| `embedding-stats.js` | Aggregate embedding coverage stats for `/admin/embeddings/stats` |
| `event-statistics.js` | Compute task-completion totals + unique users for an event |
| `export-helpers.js` | CSV formatting helpers (TaskRecords export, time-spent rendering) |
| `feedback-salt.js` | Daily-rotating HMAC salt for hashing feedback submitter IPs |
| `ip-rate-limit.js` | Per-IP fixed-window rate limiter for unauthenticated routes |
| `legacy-id.js` | HANA sequence-backed legacy integer IDs |
| `mail-client.js` | Nodemailer transport with BTP Mail binding, template rendering, retry |
| `navigator-catalog.js` | Cached `/build/navigator` handler reading the `NavigatorCatalog` entity |
| `ngds-client.js` | NGDS analytics integration with dead-letter retry |
| `pipeline-log.js` | Insert + complete `PipelineLog` rows for content + embedding pipeline runs |
| `qrcode-handler.js` | QR code PNG generation |
| `recommend.js` | Personalized "what's next" ranking blending embedding centroid + co-completion |
| `repo-catalog.js` | Serve `/build/repo-catalog` (`RepoCatalog` rows decoded into a slug → payload map) |
| `slug-mapping.js` | Build the legacyId → slug map for tutorials, missions, and completion paths |
| `status-calculator.js` | Tutorial + mission progress and status calculation from completion counts |
| `step-text-extractor.js` | Decompress tutorial HTML and extract per-step text (handles parser v1 + v2) |
| `tech-user-auth.js` | Basic-auth tech-user store loaded from `TECH_USERS` env, timing-safe compare |
| `ttl-cache.js` | Tiny in-memory TTL cache supporting sync values and Promise resolution |
| `tutorial-centroid.js` | Cached per-tutorial embedding centroid (averaged step vectors) |
| `tutorial-meta-init.js` | Backfill `TutorialMeta` rows for tutorials missing one (catches drift) |
| `user-progress.js` | Resolve XSUAA sub → `Users.ID` and supply progress data for chat tools |

## Data Model (db/) — prod HDI container `tutorials-hana`

Namespace: `com.sap.developers.ims`. Files split by purpose:

| File | Role |
| --- | --- |
| `db/schema.cds` | Entities, aspects (`TaskBase`, `LegacyKeyed`), enums (`MissionType`, `TaskType`, `TaskStatus`, `ExperienceLevel`) |
| `db/schema-ext.cds` | Extensions (`Missions.groupOrder`, `TaskBase.primaryTagRef`) + `@analytics.exposed` allowlist + `@Aggregation.ApplySupported` for the Analytics Explorer |
| `db/views.cds` | Read-only projections: `Tasks`, `NavigatorCatalog`, `SearchableItems`, `CompletionAnalytics`, `ActiveLearnersDaily`, `TutorialFeedbackAggregate` |
| `db/persistence.cds` | HANA storage hints (`@cds.persistence.exists`, table-type overrides) |
| `db/audit-logging.cds` | `@PersonalData` annotations on Users / UserMetaData / TaskRecords for `@cap-js/audit-logging` |
| `db/change-tracking.cds` | `@changelog` on `ChatSettings` (admin-mutable settings tracked via `@cap-js/change-tracking`) |

### Core entities by concern

#### Identity & people

- **Users** — SAP IDP users (uuid, sapId, legacyId, email, names, avatarUrl)
- **UserMetaData** — per-user preferences (theme, notification opt-ins)
- **PrimaryAccounts / SecondaryAccounts / PrivacyProtectionActions** — account merge + GDPR anonymization audit

#### Learning content

- **Tutorials** — Tutorial metadata (slug, title, time, level, steps)
- **Missions** — Curated mission (slug, type: SEQUENTIAL/SET, groupOrder)
- **Groups** — Group of tutorials inside a mission
- **Steps / Checkpoints** — Step-level records used by progress tracking
- **CompletionPaths / CompletionPathItems / GroupPathItems** — Ordered tutorial→group→mission graph

#### Progress & rewards

- **TaskRecords** — User completion records (step, tutorial, group, mission, checkpoint)
- **AccomplishmentRecords / Accomplishments** — Earned badges and the catalog they reference
- **Events** — Time-boxed learning events (TechEd, Sapphire, Joule launches)
- **Prizes / PrizeRecords / FeaturedTasks** — Event prize pool, claimed records, hero-card promotions

#### Tagging

- **Tags / TutorialTags / GroupTags / MissionTags** — Many-to-many tag assignments (`primaryTagRef` provides value-help association)

#### Tutorial sourcing & freshness

- **TutorialContributors / TutorialRepositories** — GitHub authors and source repos
- **TutorialMeta** — Notification tracking (reviewed date, escalation level)
- **RepoCatalog** — Discovered-tutorial baseline (third-tier discovery fallback, written by CI)

#### Content persistence

- **ContentFiles** — Versioned, gzip-compressed Hugo HTML BLOBs (`slug + version` PK)
- **ContentManifest** — Publish manifest with status (`PUBLISHING / ACTIVE / SUPERSEDED / ROLLED_BACK`)
- **TutorialBodyText** — Plain-text projection of active HTML, refreshed on every publish (powers full-text search)

#### Embeddings & chat

- **TutorialEmbedding** — Per-step embedding vectors (HANA-only at query time; see Gotchas)
- **ChatSettings** — Joule chat config (model, RAG flag, system prompt) — change-tracked

#### Feedback

- **TutorialFeedback** — Per-tutorial NPS rating + comment (also rolled up by `TutorialFeedbackAggregate` view)

#### Operational & observability

- **ImsConfig** — Key-value configuration store (notification gates, email lists)
- **JobLocks** — Distributed lock rows for cron jobs
- **FailedEmails / StepFailures / NGDSFailedMessages** — Persistent failure queues
- **ActiveLearnerRecords / DashboardMonitoredRecords** — Live-event dashboard inputs
- **PipelineLog / PipelineLogItems / JobLogItems** — Structured job-execution log (surfaced via `cfLogsUrl` virtual)
- **DeveloperEnvironmentTabs / DeveloperEnvironmentLinks** — IDE quick-link metadata
- **TimeZones** — Reference table for event scheduling

## Data Model (db-qa/) — QA HDI container `tutorials-hana-qa`

The QA channel is a **separate HDI container** scoped to the `Tutorial.Author` XSUAA scope. It deploys from [db-qa/schema.cds](../../../db-qa/schema.cds) under a distinct namespace `com.sap.developers.ims.qa` and is consumed by the `tutorials-srv-qa` MTA module — no foreign keys, queries, or replication touch the prod tables in [db/](../../../db/).

The QA model is intentionally narrow — it persists **content + pipeline observability only**. There are no user, progress, event, prize, tag, embedding, or feedback tables, because authors preview rendered HTML, they do not generate progress.

| Entity | Role |
| --- | --- |
| `ContentFiles` | Versioned gzip-compressed Hugo HTML BLOBs (same shape as prod, isolated rows) |
| `ContentManifest` | QA publish manifest (`PUBLISHING / ACTIVE / SUPERSEDED / ROLLED_BACK`) |
| `TutorialBodyText` | Plain-text projection for QA full-text search |
| `Tutorials` | Minimal tutorial metadata for the QA navigator (slug, title, level, time) |
| `RepoCatalog` | Author-preview discovery baseline (sourced only from `*-Contribution` repos) |
| `JobLocks` | Per-container distributed locks for QA pipeline jobs |
| `PipelineLog / PipelineLogItems / JobLogItems` | QA pipeline execution log |

QA-channel guardrails:

- Fetch is gated by `ONLY_CONTRIBUTION_REPOS=true` so author drafts in `*-Contribution` repos never bleed into prod
- Publish requires `CONTENT_API_KEY_QA` (separate from prod `CONTENT_API_KEY`)
- Prod and QA schemas are kept aligned by the `.github/workflows/schema-drift-check.yml` workflow — any divergence in shared entity shapes fails CI

## Notification Escalation System

Tutorial contributors receive escalating email reminders when tutorials go 6+ months without review:

| Level | TO | CC | Message |
|-------|----|----|---------|
| 0 (First) | Tutorial owner/author | — | 90-day retirement warning |
| 1 (Second) | Tutorial owner/author | Repo owner | 60-day warning |
| 2 (Third) | Tutorial owner/author | Repo owner + admin list | 30-day warning |
| 3 (Final) | Admin list | — | Deadline passed, arrange removal |

Resend interval: 30 days between escalation levels. Controlled via `ImsConfig` entries `isNotificationSendingAllowed` and `emailListForOutdated`.
