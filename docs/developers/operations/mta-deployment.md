# MTA Deployment Runbook

Complete deployment procedure for standing up the tutorials-poc stack in a CF space. Creates its own isolated service instances (HANA HDI, XSUAA, Destination, etc.) — does NOT reuse legacy IMS services.

## Architecture

```text
tutorials-poc MTA
├── tutorials-db-deployer  (type: hdb — deploys CDS schema to HDI container)
├── tutorials-srv          (type: nodejs — CAP OData/REST backend)
└── tutorials-approuter    (type: approuter.nodejs — serves static UI + proxies to srv)

Resources (created by MTA):
├── tutorials-hana         (HDI container — com.sap.xs.hdi-container)
├── tutorials-xsuaa        (XSUAA application — org.cloudfoundry.managed-service)
├── tutorials-destination  (Destination lite — org.cloudfoundry.managed-service)
├── tutorials-mail         (optional — fails gracefully if plan unavailable)
├── tutorials-audit-log    (optional)
└── tutorials-cloud-logging (optional)
```

## Prerequisites

- CF CLI logged in to target org/space
- `mbt` (MTA Build Tool) installed: `npm i -g mbt`
- `cf deploy` plugin installed: `cf install-plugin multiapps`
- Node.js ≥ 20

## Step 1: Build & Deploy MTA

```bash
cd .deploy
mbt build
cf deploy mta_archives/tutorials-poc_1.0.0.mtar -e ../deploy/dev.mtaext
```

The `dev.mtaext` extension adds DEV-specific overrides (debug logging, approuter name suffix, expose CAP UI). For production, omit `-e` or provide a prod extension.

**What happens:**

1. `before-all` runs: `npm install`, `cds build --production`, copies `xs-security.json` into `.deploy/`
2. MTA creates service instances (HDI, XSUAA, etc.) if they don't exist
3. `tutorials-db-deployer` runs as a CF task — deploys all CDS-compiled artifacts + `.hdbmigrationtable` + `.hdbsequence` files to the HDI container
4. `tutorials-srv` starts with bindings to all required services
5. `tutorials-approuter` builds admin-shell + scanner-ui into static assets, then starts

**First deploy** takes ~10 minutes (HDI container creation + full schema deploy). Subsequent deploys are incremental.

## Step 2: Populate Data (First Deploy Only)

After a fresh HDI deploy, mission/group slugs are empty. The build pipeline needs slugs to generate pages.

```bash
# Assign slugs from the mapping file (87 missions, 66 groups)
npx cds bind --exec -- node scripts/setup-dev-data.cjs

# Verify: /build/catalog returns text slugs
curl -s https://<srv-url>/build/catalog | jq '.missions[0:3] | .[].slug'
```

## Step 3: Publish Tutorial Content to HANA

Tutorials are served from HANA BLOBs, not static files. After Hugo builds, publish to the CAP endpoint:

```bash
# Set the shared API key (must match CONTENT_API_KEY on tutorials-srv)
export CONTENT_API_KEY="tutorials-content-publish-2024"

# Ensure CONTENT_API_KEY is set on the deployed srv
cf set-env tutorials-srv CONTENT_API_KEY "$CONTENT_API_KEY"
cf restart tutorials-srv

# Build Hugo site
npm run build:all

# Delta-aware publish (only changed files uploaded)
CAP_BASE_URL="https://<srv-url>" npm run publish-content
```

Use `--dry-run` to preview, `--force` to skip delta detection, `--verbose` for extra logging.

## Step 4: XSUAA Role Collections

Role collections are defined in `xs-security.json` and created automatically when the XSUAA service instance is created/updated. To manually refresh:

```bash
cf update-service tutorials-xsuaa -c xs-security.json
```

**Assign users to role collections** in BTP Cockpit:

1. Navigate to Security → Role Collections
2. Find "Tutorials Admin" / "Tutorials Developer" / "Tutorials Display"
3. Add users (e-mail addresses from SAP IDP)

Note: CF CLI cannot assign users to role collections — this is a BTP subaccount-level operation.

## Step 5: Verify Deployment

```bash
APPROUTER="https://<approuter-url>"
SRV="https://<srv-url>"

# Health
curl -s "$SRV/health" | jq .status        # "ok"
curl -s "$SRV/health/db" | jq .status      # "ok"

# Public endpoints (no auth)
curl -s "$SRV/build/catalog" | jq .missions[0].slug

# Auth enforcement
curl -s -o /dev/null -w "%{http_code}" "$SRV/admin/"  # 401

# UI apps
curl -s -o /dev/null -w "%{http_code}" "$APPROUTER/admin-ui/"    # 200
curl -s -o /dev/null -w "%{http_code}" "$APPROUTER/scanner-ui/"  # 200

# Content serving
curl -s -o /dev/null -w "%{http_code}" "$APPROUTER/tutorials/abap-dev-get-started/"  # 200
```

## Key Files

| File | Purpose |
|------|---------|
| `.deploy/mta.yaml` | Main MTA deployment descriptor |
| `deploy/dev.mtaext` | DEV-specific extension (debug logging, app name suffix) |
| `xs-security.json` | XSUAA scopes, role templates, role collections |
| `approuter/xs-app.json` | AppRouter route definitions |
| `.cdsrc-private.json` | Local hybrid bindings (gitignored) |

## Parallel Operation with Legacy IMS

The MTA creates its own service instances (prefixed `tutorials-*`). Legacy IMS services (`ims-hana-dev-container`, `xsuaa-imsdev`, etc.) remain untouched in the same space. Both systems can run simultaneously until cutover validation is complete, then legacy apps can be stopped/deleted.

## Scaling Constraints

**`tutorials-srv` is pinned to `instances: 1` in both `mta.yaml` and `.deploy/mta.yaml`. Do not raise this without first replacing the in-process rate limiters with a shared store.**

Three rate limiters in `tutorials-srv` keep state in process-local memory:

| Location | Protects | Effect at N>1 instances |
|---|---|---|
| [srv/developer-service.js:7](../../../srv/developer-service.js#L7) (`RATE_LIMIT` Map) | `POST /feedback/submit` — 5 submissions/hr/IP | Effective ceiling becomes 5×N/hr/IP |
| [srv/lib/ip-rate-limit.js](../../../srv/lib/ip-rate-limit.js) | `/search` — 60 req/min/IP | Effective ceiling becomes 60×N/min/IP |
| [srv/lib/chat-rate-limit.js](../../../srv/lib/chat-rate-limit.js) | Joule chat — per-user request cap | Effective cap becomes N× per user |

Multi-instance does not break correctness — submissions, searches, and chats still work. The limiters simply enforce a softer ceiling than configured. For a feedback-form spam guard the honeypot is the primary defense and a relaxed rate limit is acceptable, but for `/search` and chat this matters more.

If you do need to scale `tutorials-srv` horizontally, the options are (rough effort order):

1. **Lower per-instance limits proportionally** — set an `INSTANCE_COUNT` env var and divide thresholds by it. Crude but zero-code; honeypot still does the heavy lifting on feedback.
2. **HANA-backed buckets** — add a `RateLimitBuckets` entity, write through it on each request, daily TTL cleanup. No new service binding; reuses HANA. Best fit for this codebase.
3. **Redis service binding** — bind a `redis-cache` BTP managed service, use atomic `INCR` with TTL. Textbook pattern but adds a new service dependency for one feature.

Cross-references:

- TODO §22 "Feedback rate limit — multi-instance safe store"
- The chat rate limiter has an env-tunable cap (`SEARCH_RATE_LIMIT_MAX` / `SEARCH_RATE_LIMIT_WINDOW_MS`) — useful for the per-instance-divide workaround above.

## Troubleshooting

- **Optional services fail**: Expected if mail/audit-log/cloud-logging plans aren't entitled. Marked `optional: true` — deploy continues.
- **xs-security.json not found**: The `before-all` copies it to `.deploy/`. If deploy fails with config-path error, ensure `cp ../xs-security.json .` is in the build commands.
- **Slugs missing after deploy**: Run `npx cds bind --exec -- node scripts/setup-dev-data.cjs`. The script assigns slugs from `.migration-data/slug-mapping.json`.
- **Content 404s**: Content must be published to HANA after deploy. Run `npm run publish-content` with `CAP_BASE_URL` and `CONTENT_API_KEY` set.
- **Role collection not working**: Role collections are created by XSUAA update, but user assignment is manual (BTP Cockpit → Security → Role Collections).
