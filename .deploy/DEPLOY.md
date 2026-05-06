# Deployment Guide

## Quick Reference

```bash
# Full stack deploy (srv + approuter with admin UI)
bash .deploy/deploy-full.sh

# Admin UI + Approuter only
bash .deploy/deploy-admin.sh

# Approuter only (after static content or config changes)
cf push tutorials-approuter -f .deploy/mta.yaml
```

## Prerequisites

- `cf login` to the target space (DEV/QA/PROD)
- Node.js >= 20, npm, `mbt` CLI, `cf` CLI with multiapps plugin
- For content publishing: `CONTENT_API_KEY` env var set on `tutorials-srv`

## Architecture

```
MTA deploys two modules:
┌──────────────────────────────────────────────────────────────┐
│ tutorials-srv           → CAP Node.js backend                │
│ tutorials-approuter     → @sap/approuter (serves static +    │
│                           proxies to srv, includes admin UI   │
│                           as static files at /admin-ui/)      │
└──────────────────────────────────────────────────────────────┘
```

The admin UI is built into the approuter's `static/admin-ui/` directory during
the MTA build. No HTML5 App Repository is used — direct static file serving.

Tutorials are served from HANA BLOBs via CAP (not static files).

## Blue-Green Deployment (Production Only)

Production deploys use `--strategy blue-green` for zero-downtime releases:

1. New app versions are deployed alongside the running ones
2. Production routes are mapped to both old and new simultaneously
3. Once healthy, old apps are unmapped and deleted

This is automatic — the CI workflow applies it when deploying to `prod`.

**Manual prod deploy with blue-green:**
```bash
cf deploy mta_archives/tutorials-poc_1.0.0.mtar \
  -e deploy/prod.mtaext \
  --var content-api-key="$CONTENT_API_KEY" \
  --var rebuild-api-key="$REBUILD_API_KEY" \
  --var approuter-url="https://tutorials-prod-approuter.cfapps.us30.hana.ondemand.com" \
  --strategy blue-green \
  --skip-testing-phase
```

**If a blue-green deploy fails mid-way** (leaves idle apps running):
```bash
cf mta-ops                           # Find the stuck operation
cf deploy -i <op-id> -a abort        # Abort and clean up
```

**Key constraints:**

- Both old and new apps share the same HANA HDI container — schema migrations
  affect both simultaneously. Destructive schema changes (column renames/deletes)
  must be handled in two releases: first deprecate, then remove.
- The `job-lock.js` distributed lock prevents duplicate cron execution during overlap.
- Do NOT run `publish-content` during a blue-green deploy window.

## Deploy Scenarios

### 1. Admin UI + Approuter (`deploy-admin.sh`)

Use when: admin shell code changed, approuter config changed.

```bash
bash .deploy/deploy-admin.sh
```

What it does:
1. `npm install` + `cds build --production` (generates `gen/srv`)
2. `mbt build` — builds admin shell and copies into approuter static/
3. `cf deploy` pushes approuter with embedded admin UI

Verify:
```bash
curl -sI https://<approuter>/admin-ui/   # Should return 200 or 302 (XSUAA redirect)
```

### 2. Full Stack Deploy

Use when: CAP service code changed, DB schema changed, or first-time setup.

```bash
cd .deploy
mbt build -p cf --mtar tutorials-full.mtar
cf deploy mta_archives/tutorials-full.mtar
```

### 3. CAP Server Only

Use when: only `srv/` code changed (no schema, no UI, no approuter changes).

```bash
npx cds build --production
cf push tutorials-srv -p gen/srv
```

### 4. Publish Tutorial Content

Use after Hugo build to push HTML to HANA:

```bash
export CONTENT_API_KEY="tutorials-content-publish-2024"
export CAP_BASE_URL="https://<srv-url>"
npm run publish-content
```

### 5. Approuter-Only Push

Use when: only `approuter/` config changed (xs-app.json, server.js).

```bash
cf push tutorials-approuter
```

Note: `.cfignore` excludes `static/tutorials/`, `node_modules/`, and `default-env*.json`.

### 6. Hugo Template / Static Asset Changes

Use when: Hugo layouts, partials, or `hugo/static/` files changed (e.g., header, CSS).

The `.deploy/mta.yaml` does NOT run Hugo — it only builds CDS + admin UI. You must
rebuild Hugo manually and copy output to `approuter/static/` before deploying:

```bash
# 1. Rebuild Hugo
hugo --source hugo --minify

# 2. Copy output to approuter (mirrors what the CI MTA does)
cp -r hugo/public/* approuter/static/
rm -rf approuter/static/tutorials
mkdir -p approuter/static/tutorials

# 3. Deploy approuter with fresh static content
cd .deploy
mbt build
cf deploy mta_archives/tutorials-poc_1.0.0.mtar -e ../deploy/dev.mtaext -m tutorials-approuter -f
```

Why: The root `mta.yaml` (used by CI) has the full pipeline — fetch tutorials, build Hugo,
copy output, then deploy. The `.deploy/mta.yaml` is a lightweight local variant that skips
all of that for speed. If you only deploy via `.deploy/` without rebuilding Hugo first,
the approuter will serve stale HTML from whatever was last in `approuter/static/`.

## Troubleshooting

### Admin UI returns 404 or blank page

The admin-ui is served as static files from `approuter/static/admin-ui/`.

```bash
# Check if admin UI files exist in the deployed app
cf ssh tutorials-approuter -c "ls app/static/admin-ui/"
# Should show: Component.js, manifest.json, xs-app.json, components/, view/, ...
```

Fix: Re-run `deploy-admin.sh` to rebuild admin-shell and redeploy.

### Navigator shows empty / stale data

Tutorial navigation comes from CAP at `/content/nav`, NOT from static files.
If stale, the approuter might have a cached static `_nav.json`.

```bash
# Verify the CAP endpoint returns data
curl -s https://<srv-url>/content/nav | head -c 200

# Check if approuter has a stale file
cf ssh tutorials-approuter -c "ls app/static/tutorials/ 2>/dev/null"
```

Fix: Ensure `approuter/static/tutorials/` doesn't exist locally or in the deployed app.
The `.cfignore` and MTA `build-parameters.ignore` both exclude it.

### MTA deploy stuck / operation running

```bash
cf mta-ops                           # List operations
cf deploy -i <op-id> -a abort        # Abort stuck operation
```

### Blue-green left idle apps (prod)

If a prod deploy fails after creating the new apps but before completing the switch,
idle `-blue` suffixed apps may remain:

```bash
cf apps | grep -i idle               # Find idle apps
cf mta-ops                           # Find the failed operation
cf deploy -i <op-id> -a abort        # Clean up (deletes idle apps)
```

## Environment Variables

| Variable | Set On | Purpose |
|----------|--------|---------|
| `CONTENT_API_KEY` | tutorials-srv | Auth for content publish/rollback endpoints |
| `EXPOSE_CAP_UI` | tutorials-srv | Enables `/_dev` Swagger UI (DEV/QA only) |
| `REBUILD_API_KEY` | tutorials-approuter | Auth for live content rebuild endpoint |

All env vars are set via MTA variables in the mtaext files (`${var-name}` syntax),
resolved at deploy time with `--var var-name=value`. No post-deploy `cf set-env`
or `cf restart` is needed.

For manual one-off changes: `cf set-env <app> <VAR> <value> && cf restart <app>`
