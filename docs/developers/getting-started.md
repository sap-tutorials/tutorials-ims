---
title: Getting Started
description: Local development setup, scripts, environment variables, hybrid HANA workflow, and local deploy procedure for the tutorials-ims platform.
---

# Getting Started

This guide covers everything a platform engineer needs to clone, build, run, and deploy the tutorials-ims platform locally. If you only want to author or update tutorial content, see the author guides instead.

## Prerequisites

- Node.js 20+ (build scripts use native `fetch`)
- npm 10+
- `cf` CLI (Cloud Foundry) — required for hybrid dev and deploys
- `mbt` (Multi-Target Application Build Tool) — required for local deploys
- Docker (optional) — for running MailHog or other local SMTP during email testing

## Install and run locally

```bash
npm install
npm run fetch-tutorials   # Fetch tutorial markdown from GitHub + CAP catalog
cds watch                 # Start CAP server (http://localhost:4004)
npm run dev               # Hugo dev server (separate terminal)
npm run build:all         # Full production build
```

Tutorials must be fetched before `dev` or `build` — `fetch-tutorials` populates `.tutorial-cache/` (gitignored) and generates pages into `hugo/content/tutorials/` (also gitignored). Delete `.tutorial-cache/` to force a full re-fetch from GitHub.

## Folder map

The full annotated folder map lives in the [project README](https://github.com/sap-tutorials/tutorials-ims/blob/main/README.md#folder-map). The most important entry points for local development:

- `approuter/` — Express-based AppRouter; serves Hugo static build, proxies to CAP, mounts admin/scanner/analytics SPAs
- `srv/` — CAP Node.js services (DeveloperService, AdminService, AnalyticsService, ContentStore, ChatService, etc.)
- `app/` — Standalone UI apps: `admin-shell/`, `admin/` (Fiori Elements), `analytics-explorer/` (Vue), `scanner/` (UI5), `display-app/` (Vue)
- `hugo/` and `hugo-apps/` — Static site (Hugo) and the Vue 3 page-level islands compiled into `hugo/static/js/`
- `scripts/` — Build and migration scripts (`fetch-tutorials.ts`, `publish-content.ts`, `migrate-*.js`)
- `db/` — CDS data model + audit/change-tracking annotations
- `test/` — Vitest workspaces: `unit/`, `hybrid/`, `smoke/`

## Scripts reference

The full script tables (Setup / Dev / Build / Test / Content publishing / QA channel / Migration) live in the [project README](https://github.com/sap-tutorials/tutorials-ims/blob/main/README.md#scripts). Run `jq '.scripts' package.json` for the complete machine-readable list.

## Environment variables

Deploy-time variables for the MTA modules (CF env, role collections, secrets) are documented in [.deploy/DEPLOY.md](../../.deploy/DEPLOY.md). The tables below cover variables commonly set during local dev, CI, and migration.

### Build pipeline (fetch + publish)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | No | — | Avoids GitHub API rate limits when fetching tutorial markdown + commit metadata |
| `TUTORIALS_GITHUB_TOKEN` | No | — | CI-side alias for `GITHUB_TOKEN` (used by `deploy.yml`, `rebuild-content*.yml`) |
| `CAP_BASE_URL` | No | `http://localhost:4004` | CAP srv URL (build pipeline, `publish-content`, migration scripts) |
| `CAP_QA_BASE_URL` | No | — | QA-channel CAP srv URL for `publish-content:qa` |
| `CONTENT_API_KEY` | Yes (publish) | — | Bearer token for `POST /content/publish` and `/content/rollback` |
| `CONTENT_API_KEY_QA` | Yes (QA publish) | — | Bearer token for QA-channel `/content/publish` |
| `TUTORIAL_SLUG` | No | — | If set, `fetch-tutorials` busts the cache for that single slug; `rebuild-content.yml` skips the `RepoCatalog` upload |
| `INCLUDE_CONTRIBUTION_REPOS` | No | `false` | Include `*-Contribution` repos in fetch (prod channel only allows on opt-in) |
| `ONLY_CONTRIBUTION_REPOS` | No | `false` | QA channel: fetch from `*-Contribution` repos exclusively |

### CAP runtime (srv/)

| Variable | Required | Default | Description |
|---|---|---|---|
| `CONTENT_API_KEY` | Yes | — | Required to accept content publish writes; without it `/content/publish` returns 401 |
| `SUBMISSION_SALT_SECRET` | Yes (feedback) | — | IP-hash salt for `/feedback/submit`; bridge returns 503 if missing |
| `EXPOSE_CAP_UI` | No | `false` | Enables `/_dev` Swagger UI + CAP index page (DEV/QA only — never set in prod) |
| `CHAT_MODEL_NAME` | No | — | Override the Joule chat completion model |
| `SEARCH_RATE_LIMIT_MAX` | No | `60` | Per-IP search request limit per window |
| `SEARCH_RATE_LIMIT_WINDOW_MS` | No | `60000` | Search rate-limit window in ms |
| `DASHBOARD_URL` | No | Production URL | Tutorial Dashboard URL injected into notification emails |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_FROM` / `SMTP_PASS` | No | — | SMTP transport for local email testing (e.g., MailHog). In deployed environments these live in BTP Credential Store, managed via `/admin-ui/#secrets-display` — see [SMTP rotation runbook](operations/smtp-credentials-rotation.md). |

### Approuter (approuter/)

| Variable | Required | Default | Description |
|---|---|---|---|
| `REBUILD_API_KEY` | Yes (rebuild) | — | Bearer token for the approuter live-rebuild webhook |
| `CAP_BASE_URL` | No (CF: VCAP) | — | CAP srv URL for proxy fallback when running standalone |

### Testing

| Variable | Required | Default | Description |
|---|---|---|---|
| `SMOKE_BASE_URL` | Yes (smoke) | — | Approuter URL — `npm run test:smoke` target |
| `SMOKE_SRV_URL` | Yes (smoke) | — | CAP srv URL — `npm run test:smoke` target |
| `SMOKE_QA_BASE_URL` / `SMOKE_QA_SRV_URL` / `SMOKE_QA_TOKEN` | Yes (QA smoke) | — | QA-channel smoke-test endpoints + bearer |
| `SMOKE_ADMIN_TOKEN` | No | — | Bearer for admin-only smoke checks |
| `SMOKE_TECH_USER` / `SMOKE_TECH_PASSWORD` | No | — | Basic-auth credentials for tech-user smoke flow |
| `TECH_USERS` / `TECH_USERS_MAPPING` | No | — | Backend tech-user auth config consumed by smoke tests |
| `A11Y_BASE_URL` | Yes (a11y) | — | Target URL for `npm run test:a11y` |
| `ALLOW_HYBRID_WRITES` | No | `false` | Hybrid-test write guard — must be `true` to permit INSERT/UPDATE/DELETE |

### QA preview rendering (srv-qa/)

| Variable | Required | Default | Description |
|---|---|---|---|
| `PREVIEW_SITE_PATH` | No | bundled | Path to preview-site Hugo project |
| `PREVIEW_HUGO_BIN` | No | `hugo` | Hugo binary to invoke for preview renders |
| `PREVIEW_HUGO_ARGS_PREFIX` | No | — | Extra args prepended to every Hugo preview call |
| `PREVIEW_HUGO_TIMEOUT_MS` | No | — | Per-render timeout |
| `PREVIEW_MAX_CONCURRENT` | No | — | Max concurrent preview renders |
| `PREVIEW_QUEUE_TIMEOUT_MS` | No | — | Queue wait timeout before 503 |
| `SRV_URL_QA` | No | — | QA srv URL passed to preview renderer |

### Migration (legacy IMS cutover)

| Variable | Required | Default | Description |
|---|---|---|---|
| `IMS_BASE_URL` | Yes (migrate) | — | Legacy Java IMS approuter URL |
| `IMS_AUTH_TOKEN` | Yes (migrate) | — | Bearer token for Java IMS API |
| `IMS_DB_URL` / `IMS_DB_USERNAME` / `IMS_DB_PASSWORD` | Yes (HANA migrate) | — | Direct HANA creds for `migrate:hana` (IMSDBUSER schema) |
| `IMS_HANA_CREDENTIALS` / `CAP_HANA_CREDENTIALS` | No | — | Alternate JSON-form HANA credentials for migration |
| `MIGRATION_OUTPUT_DIR` | No | `.migration-data/` | Where migration export files are written |

## Hybrid HANA development

When you need to develop against real HANA Cloud (e.g., to test BLOB content serving or HDI artifacts), bind a deployed service instance and run CAP and the approuter locally.

### Bind to DEV

Run `npm run bind:setup` once after cloning to wire up the hybrid env files. Before each session, `cf login` and target the DEV space — `cds bind --exec` resolves credentials from the targeted space.

### Run the stack

CAP server with content key:

```bash
CONTENT_API_KEY=local-dev-key npx cds bind --exec -- npx cds-serve
```

Approuter (in a separate terminal, listens on port 5000):

```bash
cd approuter && node server.js
```

Publish tutorial HTML to the bound HANA:

```bash
CONTENT_API_KEY=local-dev-key npm run publish-content -- --force
```

> **Windows note:** the `KEY=value cmd` inline-prefix syntax is bash/zsh only. In PowerShell use `$env:CONTENT_API_KEY="local-dev-key"; npx cds bind --exec -- npx cds-serve`, in cmd use `set CONTENT_API_KEY=local-dev-key && npx cds bind ...`, or run the command from Git Bash.

### Why content publishing is required

Tutorial HTML is served exclusively from HANA BLOBs — there is no static fallback. Without a publish, every `/tutorials/*` request returns 404. Always pass `--force` to bypass delta detection; the default delta mode treats publishes as full snapshots and silently drops slugs not in the payload.

## Local deploy process

When CI is broken or you need a quick iterative deploy, build and push from `.deploy/` directly.

### Steps

```bash
cf target -s <dev-space>
cd .deploy
mbt build
cf deploy mta_archives/tutorials-poc_1.0.0.mtar -e ../deploy/dev.mtaext -f
```

### Optional env vars

```bash
cf set-env tutorials-srv CONTENT_API_KEY "<your-publish-key>"
cf set-env tutorials-srv EXPOSE_CAP_UI "true"
cf restart tutorials-srv
```

### Verify

- `/_dev` — Swagger UI is reachable (only when `EXPOSE_CAP_UI=true`)
- `/scanner-ui/` — UI5 scanner app loads
- `/admin-ui/` — admin shell loads with all components

### Troubleshooting

- Stuck deploy: list operations with `cf mta-ops`, then abort with `cf deploy -i <op-id> -a abort`
- Admin UI blank: `cf ssh tutorials-approuter -c "ls app/static/admin-ui/"` to confirm the bundle was deployed
- Scanner 404: confirm `app/static/scanner-ui/` exists in the deployed approuter

## DEV database setup (slug population)

After a fresh DB deploy or when slugs are missing (missions/groups show numeric IDs instead of text slugs in `/build/catalog`), run:

```bash
# 1. Ensure you're logged into CF DEV space
cf login

# 2. Run the setup script against HANA (deletes autotest junk + assigns slugs)
npx cds bind --exec -- node scripts/setup-dev-data.cjs

# 3. Verify: /build/catalog should return text slugs like "abap-dev-get-started"
curl -s https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/catalog | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.missions.slice(0,3).map(m=>m.slug))"
```

The script uses `.migration-data/slug-mapping.json` (87 missions, 66 groups) extracted from ContentFiles. It assigns slugs sequentially to records that don't already have one — the specific legacyId doesn't matter since content serving only requires the slug to exist.

Flags: `--skip-cleanup` (skip autotest deletion), `--skip-slugs` (skip slug assignment), `--dry-run` (preview only).

## Testing

- `npm test` — fast unit tests on in-memory SQLite
- `npm run test:hybrid` — real HANA via `cds bind --exec` (set `ALLOW_HYBRID_WRITES=true` to permit writes)
- `npm run test:smoke` — HTTP-based, set `SMOKE_BASE_URL` + `SMOKE_SRV_URL`

See [Testing Guide](operations/testing-guide.md) for the full setup, fixtures, and CI integration.

## Common pitfalls

- **Tutorials must be fetched before dev/build** — Hugo content is generated, not committed. Run `npm run fetch-tutorials` after a clean clone.
- **`hugo/content/tutorials/` is generated** — never edit those files; they're overwritten on the next fetch. Edit parsers in `scripts/parsers/` instead.
- **`publish-content` needs `--force` in production** — default delta mode breaks production publishes. The server treats publishes as full snapshots, so a partial payload silently drops slugs not in it.
- **HANA LOB locator expiry** — never SELECT a BLOB column alongside metadata in a single CDS QL query on HANA. Use raw SQL via `db.run()` for BLOB retrieval (see `srv/lib/content-store.js`).
- **Node 20+ required** — build scripts use native `fetch` with no polyfill.
