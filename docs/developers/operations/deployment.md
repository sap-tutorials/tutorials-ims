---
title: Deployment
description: SAP BTP Cloud Foundry deployment — MTA modules, BTP service bindings, and AppRouter route architecture.
---

# Deployment

> Source: extracted from project README, 2026-05-25.

Two MTAs deploy to SAP BTP Cloud Foundry: the **main** `tutorials-ims` MTA
([.deploy/mta.yaml](../../../.deploy/mta.yaml)) and the **MCP** `tutorials-mcp` MTA
([mta-mcp.yaml](../../../mta-mcp.yaml)). The main MTA owns the service instances; the MCP MTA
adopts them. Main-MTA deploy:

```bash
mbt build
cf deploy mta_archives/*.mtar
```

MCP-MTA deploy is separate and manual (`npm run deploy` does not cover it):

```bash
mbt build -f mta-mcp.yaml -t mta_archives
cf deploy mta_archives/*.mtar -e deploy/mcp-dev.mtaext -f
```

See [operations/mta-deployment.md](mta-deployment.md) for the full runbook.

#### MTA Modules

The main MTA ([.deploy/mta.yaml](../../../.deploy/mta.yaml)) defines five modules — the prod and QA channels share an AppRouter and XSUAA instance but each gets its own srv app and HDI container. The MCP MTA ([mta-mcp.yaml](../../../mta-mcp.yaml)) adds a sixth deploy unit, `tutorials-srv-mcp`.

| Module | MTA | Type | Source | Requires | Purpose |
| --- | --- | --- | --- | --- | --- |
| `tutorials-db-deployer` | main | `hdb` | `gen/db` | `tutorials-hana`, `tutorials-cloud-logging` | Prod HANA schema + indexes (one-shot HDI deploy). Cloud Logging binding forwards deployer stdout for ~30-day forensic retention (#257). |
| `tutorials-db-qa-deployer` | main | `hdb` | `gen/db-qa` | `tutorials-hana-qa`, `tutorials-cloud-logging` | QA HANA schema (peer of `db/`, namespace `com.sap.developers.ims.qa`). Cloud Logging binding mirrors prod for QA forensic parity. |
| `tutorials-srv` | main | `nodejs` | `gen/srv` | hana, xsuaa, destination, mail, audit-log, cloud-logging, aicore | CAP backend (9 services + jobs + Socket.IO + content store + RAG); serves `/mcp/*`, `/mcp-pat/*`, `/mcp-admin/*` |
| `tutorials-srv-qa` | main | `nodejs` | `gen/srv-qa` | hana-qa, xsuaa | QA-channel CAP srv (re-renders author drafts via `srv-qa/lib/parsers.bundle.mjs`) |
| `tutorials-approuter` | main | `approuter.nodejs` | `approuter/` | xsuaa, `srv-api` (destination), `srv-qa-api` (destination), `srv-mcp-api` (destination) | XSUAA login + static delivery + reverse proxy to both srv apps AND the MCP app |
| `tutorials-srv-mcp` | **mcp** | `nodejs` | `gen/srv-mcp` | hana, xsuaa, identity (IAS), credstore, destination | Authenticated MCP backend — serves ONLY `/mcp-auth/*`; adopts the main MTA's services as existing-service |

The AppRouter routes `^/tutorials-qa/(.*)`, `^/qa-search/(.*)` to the `srv-qa-api` destination, `^/mcp-auth/(.*)` to the `srv-mcp-api` destination (the external MCP app), and everything else (`/api/*`, `/admin/*`, `/display/*`, `/content/*`, `/mcp/*`, `/mcp-pat/*`, `/mcp-admin/*`, etc.) to `srv-api`. WebSocket paths (`^/socket\.io/`, `^/ws/`) are `authenticationType: 'none'` because the scope check happens at namespace join.

#### BTP Service Bindings

| Resource | Service / plan | Required by | Notes |
| --- | --- | --- | --- |
| `tutorials-hana` | `hana` / `hdi-shared` | `tutorials-srv`, `tutorials-db-deployer`, `tutorials-srv-mcp` | Prod HDI container (`com.sap.xs.hdi-container`) |
| `tutorials-hana-qa` | `hana` / `hdi-shared` | `tutorials-srv-qa`, `tutorials-db-qa-deployer` | QA-channel HDI container — separate from prod, no cross-foreign-keys |
| `tutorials-xsuaa` | `xsuaa` / `application` | all srv apps + approuter + `tutorials-srv-mcp` | Configured from [.deploy/xs-security.json](../../../.deploy/xs-security.json) (Admin, MobileApp, DisplayApp, Tutorial.Author, ConsolidationScope, DeveloperApp scopes) |
| `tutorials-identity` | `identity` / IAS | `tutorials-srv-mcp` | IAS public-PKCE client for `/mcp-auth/*` `mcp-remote` clients (primary auth; XSUAA is the fallback) |
| `tutorials-destination` | `destination` / `lite` | `tutorials-srv`, `tutorials-srv-mcp` | NGDS + SCI remote endpoints; the MCP app uses it for the main-srv write-forward destination |
| `tutorials-credstore` | `credstore` / `standard` | `tutorials-srv`, `tutorials-srv-mcp` | BTP Credential Store (deploy-time secrets) |
| `tutorials-mail` | `mail` / `standard` | `tutorials-srv` | SMTP for notification escalation emails |
| `tutorials-audit-log` | `auditlog` / `standard` (optional) | `tutorials-srv` | `@cap-js/audit-logging` sink for `@PersonalData` events |
| `tutorials-cloud-logging` | `cloud-logging` / `standard` (optional) | `tutorials-srv`, `tutorials-db-deployer`, `tutorials-db-qa-deployer` | OTLP ingest enabled; backs the `cfLogsUrl` virtual on `PipelineLog` / `JobExecutionLog`. Deployer bindings (#257) capture HDI deploy stdout for ~30-day forensic retention. |
| `tutorials-aicore` | `aicore` / `extended` (optional) | `tutorials-srv` | Backs `ChatService` + embeddings + RAG (`getRelevantSteps` tool) |

The MCP MTA creates **none** of these — it declares each as `org.cloudfoundry.existing-service` and adopts the instances the main MTA owns.

`optional: true` resources let `mbt build && cf deploy` succeed in a subaccount that hasn't entitled them yet (e.g., a fresh sandbox without AI Core). The srv app degrades gracefully when bindings are missing — chat returns 503, audit logging falls through to the console sink, OTLP export is no-op.

#### Route Architecture

The AppRouter (`approuter/xs-app.json`) evaluates routes top-to-bottom on first match — so order matters. There are ~28 active routes; canonical reference for auth/scope per route is [testing-endpoints.md](./testing-endpoints.md).

##### Static UIs (XSUAA + scope, served from `approuter/static/<route>/`)

| Pattern | Backed by | Auth |
| --- | --- | --- |
| `^/admin-ui/(.*)$` | `app/admin-shell/dist/` (TNT shell + 13 Fiori Elements components) | XSUAA + `Admin` |
| `^/analytics-ui/(.*)$` | `app/analytics-explorer/dist/` (Vue 3 + Monaco) | XSUAA + `Admin` |
| `^/scanner-ui/(.*)$` | `app/scanner/webapp/` (UI5 BarcodeScanner) | XSUAA + `MobileApp` |
| `^/scanner-vue/(.*)$` | `hugo-apps/src/scanner-vue/` island | XSUAA + `MobileApp` |

##### Authenticated API proxies (XSUAA + scope, → `srv-api` destination → `tutorials-srv`)

| Pattern | Service | Scope |
| --- | --- | --- |
| `^/admin/exports/(.*)$` | `ExportsService` | `Admin` |
| `^/admin/analytics/(.*)$` | `AnalyticsService` (gated entity surface + `runSelectQuery`) | `Admin` |
| `^/admin/(.*)$` | `AdminService` | `Admin` |
| `^/display/(.*)$` | `DisplayService` | `DisplayApp` |
| `^/api/v1/(.*)$` | `ConsolidationService` | `ConsolidationScope` |
| `^/api/(.*)$` | `DeveloperService` + `/api/qrcode`, `/api/recommendations` | XSUAA (any) |
| `^/chat/(.*)$` | `ChatService` + `/chat/stream` (SSE) | XSUAA (any) |
| `^/scanner/(.*)$` | `ScannerService` OData functions | XSUAA + `MobileApp` |
| `^/auth/user$` | Identity probe | XSUAA (any) |
| `^/login(\?.*)?$` | OAuth2 entry (XSUAA redirect) | XSUAA |

##### QA channel (XSUAA + `Tutorial.Author`, → `srv-qa-api` destination → `tutorials-srv-qa`)

| Pattern | Target on srv-qa | Notes |
| --- | --- | --- |
| `^/tutorials-qa/_nav\.json$` | `/content/nav` | QA-only navigation metadata |
| `^/tutorials-qa/search/?(.*)$` | static `/qa/search/$1` | search page shell from Hugo QA build |
| `^/qa-search/(.*)$` | `/search/$1` | QA-only `SearchService` proxy |
| `^/tutorials-qa/(.*)$` | `/content/tutorials/$1` | preview HTML from `tutorials-hana-qa` BLOBs |

##### Public / unauthenticated (no session required)

| Pattern | Purpose |
| --- | --- |
| `^/api/ChatConfig(.*)$` | Chat client bootstrap — config only, no PII |
| `^/search/(.*)$` | `SearchService` — public tutorial search |
| `^/content/(.*)$` | Tutorial HTML serve + `/content/hashes`, `/content/nav` (writes are bearer-token gated by `CONTENT_API_KEY` at the srv) |
| `^/build/(.*)$` | Build pipeline catalog/navigator/repo-catalog endpoints (CI consumers) |
| `^/feedback/(.*)$` | `/feedback/submit` (rate-limited, IP hashed via `SUBMISSION_SALT_SECRET`) |
| `^/health(/.*)?$` | Liveness + DB connectivity |
| `^/.well-known/(.*)$`, `^/ord/(.*)$` | ORD discovery |
| `^/rest/(.*)$` | Custom REST escape hatch (server-defined sub-routes) |
| `^/tutorials/_nav\.json$` → `/content/nav` | Prod navigation metadata |
| `^/tutorials/(.*)$` → `/content/tutorials/$1` | Prod HTML rewrite to HANA-backed serve |

##### WebSocket transport (auth: none at the router; scope enforced at namespace join)

| Pattern | Namespace | Scope check |
| --- | --- | --- |
| `^/socket\.io/(.*)$` | Socket.IO upgrade transport | (none — namespace-level) |
| `^/ws/(.*)$` | `/ws/display` | `DisplayApp` enforced inside `@cap-js-community/websocket` plugin |
| `^/ws/(.*)$` | `/ws/event-stream` | anonymous (kiosk monitors) |

The router is intentionally `authenticationType: "none"` for `^/socket\.io/` and `^/ws/` because the WebSocket plugin runs scope checks at namespace-join time — adding XSUAA at the router would force an OAuth dance the Socket.IO client can't complete cleanly. See [authentication.md](../architecture/authentication.md) for the full token flow.

##### Catch-all (last)

`^/(.*)$` → `localDir: static/` (Hugo build output: homepage, `/tutorials/{slug}` shells, `/missions/{slug}`, `/groups/{slug}`, `/me/`, `/event-display/`, `/app-space/`, plus the compiled Vue islands in `hugo/static/js/`). `authenticationType: "none"` — public Hugo content with lazy login on demand.
