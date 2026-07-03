# MTA Deployment Runbook

Complete deployment procedure for standing up the tutorials-ims stack in a CF space. Creates its own isolated service instances (HANA HDI, XSUAA, Destination, etc.) — does NOT reuse legacy IMS services.

## Architecture

```text
tutorials-ims MTA
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
cf deploy mta_archives/tutorials-ims_1.0.0.mtar -e ../deploy/dev.mtaext
```

The `dev.mtaext` extension adds DEV-specific overrides (debug logging, approuter name suffix, expose CAP UI). For production, omit `-e` or provide a prod extension.

### Canonical app names per environment

The MTA module name `tutorials-approuter` is overridden per environment via the `mtaext` files. The deployed CF app name follows this scheme:

| Env | MTA ext | Deployed app name | Public route |
| --- | --- | --- | --- |
| dev | `deploy/dev.mtaext` | `tutorials-dev-approuter` | `tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com` |
| qa | `deploy/qa.mtaext` | `tutorials-qa-approuter` | `tutorial-system-qa-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com` |
| prod | `deploy/prod.mtaext` | `tutorials-prod-approuter` | `tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com` |

Only ONE `*approuter*` app should exist per space. If `cf apps` shows more than one (e.g. a leftover bare-named `tutorials-approuter` from a manual `cf push`), the duplicate is a hazard — operators can crash the wrong app and the live route stays bound to whichever one was pushed last under that name. **Prevention:** never run `cf push tutorials-approuter` directly; always go through MTA. **Detection:** `cf apps | grep approuter` should return exactly one row. **Recovery:** `cf delete <leftover-name> -f -r` (the `-r` removes any orphaned routes too).

The `cutover-rehearsal.cjs` orchestrator's Step 1 also asserts this invariant — see #363.

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
export CONTENT_API_KEY="<DEV-content-api-key — fetch from BTP credstore, do NOT commit>"

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

Role collections are defined in `xs-security.json` and created automatically when the XSUAA service instance is created via MTA deploy. **Any subsequent change to `xs-security.json` (scope add/remove, role template edit, or authorities-array change) requires a manual `cf update-service` to reconcile the deployed instance.** The MTA `cf deploy` command alone does NOT re-read `xs-security.json`.

```bash
cf update-service tutorial-system-dev-tutorials-xsuaa -c xs-security.json
```

This is a well-known trap. Ship the `cf update-service` step in the same change window as the code deploy.

**Post-Phase-A1 (#809):** the `Tutorial.Author` scope is no longer auto-granted. Users needing QA-preview access must be explicitly assigned to the `Tutorials Author` role collection. See [xsuaa-role-collection-assignment.md](xsuaa-role-collection-assignment.md) for the full runbook.

**Assign users to role collections** in BTP Cockpit:

1. Navigate to Security → Role Collections
2. Find "Tutorials Admin" / "Tutorials Developer" / "Tutorials Display" / "Tutorials Author" / "Tutorials Scanner" / "Tutorials SuperAdmin"
3. Add users (e-mail addresses from SAP IDP)

Note: CF CLI cannot assign users to role collections — this is a BTP subaccount-level operation. Use `btp` CLI for CI/scripted assignments (see the assignment runbook).

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

> **Broader context:** [`docs/developers/architecture/scaling-playbook.md`](../architecture/scaling-playbook.md). This section covers only the three in-process rate limiters (playbook row #2).

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

## Rename cutover (`tutorials-poc` → `tutorials-ims`)

Issue [#635](https://github.com/sap-tutorials/tutorials-ims/issues/635). One-time procedure to retire the legacy `tutorials-poc` MTA identity and matching `xsappname` without recreating service instances or losing HANA data.

The rename touches **two** identity domains that Cloud Foundry tracks independently:

| Domain | What's renamed | Effect |
| --- | --- | --- |
| MTA `ID:` | `tutorials-poc` → `tutorials-ims` in `mta.yaml` and `.deploy/mta.yaml` | CF creates a NEW MTA registration. Service instances are NOT recreated because every `resources:` entry declares an explicit `service-name:` — the deployer adopts the existing `tutorials-hana`, `tutorials-xsuaa`, `tutorials-credstore`, etc. |
| `xsappname` | `tutorials-poc` → `tutorials-ims` in `xs-security.json` and `.deploy/xs-security.json` | XSUAA service instance is **updated** (not recreated) — `cf update-service tutorials-xsuaa -c xs-security.json` flips the scope namespace. Every issued JWT scope literal changes from `tutorials-poc!t<n>.*` to `tutorials-ims!t<n>.*`. Existing role-collection bindings become empty (they reference scopes that no longer exist) and must be re-bound. |

### What is and isn't safe

**Safe (data preserved):**
- HANA HDI containers (`tutorials-hana`, `tutorials-hana-qa`) — adopted by `service-name`. Schema deploys land in the same container. No data loss.
- All managed services (Destination, Audit Log, Cloud Logging, AI Core, credstore, kg-grantor) — same `service-name`, adopted.
- App routes — `tutorials-srv`, `tutorials-srv-qa`, `tutorials-dev-approuter` keep their existing URLs (`tutorial-system-dev-tutorials-*.cfapps.eu10-005.hana.ondemand.com`).
- Source-code scopes — `srv/**/*.cds` uses bare `@requires: 'Admin'` (verified: zero `tutorials-poc.` literals). CAP resolves against `$XSAPPNAME` at runtime, picks up the new prefix automatically.
- AppRouter routes — `approuter/xs-app.json` uses `$XSAPPNAME.*` throughout (no hard-coded prefix).

**Disruption window:**
- ~5-10 minutes of 403s on protected routes between the XSUAA update completing and the role-collection rebind landing. Plan the cutover for a low-traffic window.
- Up to 12 hours of stale-JWT 403s for users with active sessions (JWT TTL). Mitigation: clear the XSUAA client (cockpit → Security → OAuth → Reset client) right after deploy, or just tell affected users to log out + back in.

### Cutover steps

> Run from the `main` branch in the primary worktree (per CLAUDE.md "always deploy from main"). The PR for this rename is #TBD.

**1. Pre-flight: inventory current role-collection bindings**

```bash
# In tutorial-system subaccount (DEV):
node scripts/inventory-role-collections.cjs --subaccount tutorial-system \
  --out .migration-data/role-collections-pre-rename.json
```

Writes the current `Tutorials Admin`, `Tutorials SuperAdmin`, `Tutorials Developer`, `Tutorials Display`, `Tutorials Author`, `Tutorials Scanner` collection definitions + their user/group assignments to disk. This file is the rollback safety net if anything goes wrong.

**2. Build + deploy with the new MTA ID and `xsappname`**

```bash
# Confirm CF target (don't trust muscle memory)
cf target
# org: tutorial-system, space: dev

npm run build:all
cd .deploy && mbt build

# The new mtar filename reflects the new ID:
cf deploy mta_archives/tutorials-ims_1.0.0.mtar -e ../deploy/dev.mtaext -f
```

What happens during the deploy:

- MTA deployer creates a new MTA registration `tutorials-ims`.
- It resolves `resources:` against the space — finds existing `tutorials-hana`, `tutorials-xsuaa`, `tutorials-credstore`, etc. by their `service-name:` and **adopts** them. No `create-service` calls. No HDI redeploy beyond the normal CDS artifact refresh.
- `cf update-service tutorials-xsuaa -c xs-security.json` runs as part of the resource sync, flipping the XSUAA descriptor's `xsappname` to `tutorials-ims`.
- The three apps (`tutorials-srv`, `tutorials-srv-qa`, `tutorials-dev-approuter`) repush. Routes preserved.

**3. Verify role-collection assignments survived the deploy**

XSUAA role collections in the `tutorial-system` subaccount carry scope-template references like `tutorials-poc!t676072.Admin`. The `cf update-service tutorials-xsuaa -c xs-security.json` that runs as part of step 2 **recreates the 6 `Tutorials *` collections inline** from the descriptor — because they're declared in `xs-security.json` itself (`role-collections:` block at lines 64-118), they're rewritten with the new `tutorials-ims.*` template references automatically.

**SUBACCOUNT-level user assignments survive the recreate** because they bind by collection name (e.g. `Tutorials Admin`), not by template reference. In the happy path no manual rebind is needed.

But we don't trust the happy path on a one-time cutover. Verify against the pre-flight snapshot:

```bash
node scripts/migrate-role-collections.cjs \
  --inventory .migration-data/role-collections-pre-rename.json \
  --verify
```

Expected output: every collection reports `OK` with the same user count as the snapshot. Exit code 0.

**If --verify reports MISSING users on any collection**, restore from the snapshot:

```bash
node scripts/migrate-role-collections.cjs \
  --inventory .migration-data/role-collections-pre-rename.json \
  --restore --commit
```

The script re-asserts every user assignment captured in the snapshot. It's idempotent — users already bound return an "already" status; only genuinely-lost assignments cause a write. Run without `--commit` first to preview.

**4. (Optional) Force-refresh active sessions**

In-flight access tokens issued under `tutorials-poc!t<n>` continue to assert the old scope literals until they expire (default 12 h TTL). On a protected route, the JWT validator on `tutorials-srv` sees `scope: ["tutorials-poc!t<n>.Admin"]` but the XSUAA descriptor now offers `tutorials-ims!t<n>.Admin` — result: 403 until the user logs out and back in.

Two ways to shorten the tail:

- **Cockpit (recommended for DEV):** Subaccount → Security → OAuth → "Trust Configuration" → tutorials-xsuaa → "Reset Client Secret". This invalidates the client's signing key, so all outstanding tokens fail validation. Users with active sessions get redirected to login by approuter on next request and come back with fresh JWTs.
- **Wait it out:** for DEV traffic levels, just notify affected users and rely on the 12 h TTL.

Skip this step entirely if step 3 confirmed assignments are intact and DEV traffic is low — the disruption is invisible until a user with an active session hits a protected route.

**5. Verify**

```bash
APPROUTER="https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com"
SRV="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com"

# Public endpoints unchanged
curl -s "$SRV/health" | jq .status                                              # "ok"
curl -s "$SRV/build/catalog" | jq '.missions | length'                          # >0

# Authenticated round-trip — log in via approuter, then check the scope claim
# Open https://<approuter>/auth/user in a browser, sign in, response should show
# scopes prefixed with `tutorials-ims!t<n>.` not `tutorials-poc!t<n>.`

# Tutorial content still serves from HANA
curl -s -o /dev/null -w "%{http_code}\n" "$APPROUTER/tutorials/abap-dev-get-started/"   # 200

# Admin UI loads (requires a valid `Tutorials Admin` collection assignment)
curl -s -o /dev/null -w "%{http_code}\n" "$APPROUTER/admin-ui/"                 # 200
```

**6. Clean up the old MTA registration**

```bash
# Confirm both registrations exist (transient state after step 2):
cf mtas
# expected:
# mta id           version
# tutorials-ims    1.0.<run>
# tutorials-poc    1.0.<prev>

# Drop the old registration WITHOUT touching services or apps
# (the apps have been re-claimed by tutorials-ims; this only removes the metadata record):
cf purge-mta tutorials-poc

# Confirm:
cf mtas
# expected: only tutorials-ims
```

If `cf purge-mta` is not available (older multiapps plugin), `cf undeploy tutorials-poc -f` works — but be sure you do **not** pass `--delete-services`. Without that flag, only the registration record is removed.

### Rollback (if step 2 fails before step 3)

If `cf deploy` of `tutorials-ims_1.0.0.mtar` fails partway through, the XSUAA descriptor update may have already landed. To roll back to `tutorials-poc`:

1. Revert this PR locally: `git checkout main && git pull && git revert <merge-commit>`.
2. `npm run build:all && cd .deploy && mbt build && cf deploy mta_archives/tutorials-poc_1.0.0.mtar -e ../deploy/dev.mtaext -f`.
3. The deploy adopts the same services again — `xsappname` flips back to `tutorials-poc`.
4. After the revert deploy completes, verify assignments with `node scripts/migrate-role-collections.cjs --inventory .migration-data/role-collections-pre-rename.json --verify`. If anything was lost during the failed forward attempt, `--restore --commit` re-asserts from the snapshot.

### PROD cutover

Same procedure, scheduled into the end-of-July 2026 AEM→IMS PROD window. Differences vs DEV:

- Pre-flight inventory runs against the PROD subaccount.
- Blue-green strategy applies (`STRATEGY_FLAGS="--strategy blue-green --skip-testing-phase"` in `deploy.yml:389`) — the new MTA ID still works with blue-green.
- The grep at `deploy.yml:401` was widened to match both names during the cutover window. After PROD cutover lands, narrow it back to `tutorials-ims` only.

### Why not `cf undeploy --delete-services` first (as the issue originally specified)?

The issue's original runbook assumed renaming the MTA `ID:` forced full service-instance recreation. That's only true when `resources:` entries lack explicit `service-name:` declarations. **This codebase already declares `service-name:` on every resource** (see `.deploy/mta.yaml:211-289`), which decouples instance identity from MTA identity. The `--delete-services` flag would actively destroy HANA schemas, force a fresh HDI deploy, and require restoring data from snapshot — the destructive path is exactly what `service-name:` is designed to avoid.

### Post-cutover lessons (2026-07-03 DEV cutover incident)

The first DEV cutover surfaced three failure modes not captured by the original runbook. Fixed by [PR #809-rename-followups](https://github.com/sap-tutorials/tutorials-ims/pull) but worth documenting here for the PROD cutover:

**1. `deploy/*.mtaext` `extends:` field must match the new MTA `ID:`.** The original rename PR flipped `mta.yaml`'s `ID: tutorials-poc` → `tutorials-ims` but left all three `deploy/*.mtaext` files with `extends: tutorials-poc`. The MTA deployer silently ignores an extension whose `extends:` doesn't match the base MTA ID. Effect: every override in `dev.mtaext` (env vars, `app-name`, etc.) was dropped. `tutorials-srv` came up without `CONTENT_API_KEY` / `KNOWLEDGE_GRAPH_ENABLED` / `EXPOSE_CAP_UI`. Fix: update the `extends:` and `ID:` lines in all three mtaext files.

**2. XSUAA broker refuses in-place `xsappname` renames.** The runbook (§Cutover step 2) says `cf update-service tutorials-xsuaa -c xs-security.json` runs as part of MTA deploy. That's true, but if `xs-security.json`'s `xsappname` differs from what the deployed service already has, the broker rejects with `Cannot change AppId with update. Old AppId: X!t<n> New AppId: Y!t<n>`. Even a fresh xsuaa service instance can't claim an AppId that's already registered on the tenant server (a "ghost" from any prior deploy attempt — including one that failed partway). The correct sequence for a rename is:
- Pre-flight inventory (`scripts/inventory-role-collections.cjs`)
- Delete xsuaa: unbind from apps → `cf delete-service tutorials-xsuaa`
- **Pre-create the new xsuaa MANUALLY, outside MTA:** `cf create-service xsuaa application tutorials-xsuaa -c xs-security.json`. This applies the `xsappname` at creation time, which MTA's own `create-service` call sometimes fails to do (it created a service with a random-UUID `xsappname` in the DEV cutover; the fix was to pre-create manually so MTA adopts by `service-name:`).
- Deploy the MTA (adopts the pre-created service).
- Restore user assignments (`scripts/migrate-role-collections.cjs --restore --commit`).

**3. MTA `cf deploy` fails with `Controller operation failed: 500 Internal Server Error: UnknownError(10001)` when an app has stale build state.** The multiapps plugin's `UploadAppStep` calls `getBuildsForApplication` before uploading. If the app has any lingering build record from a prior partial deploy or manual `cf push`, that call returns 500 and blocks the deploy indefinitely (3 automatic retries all fail). Manual `cf push` of the same content works fine — this is specific to the multiapps controller. **Recovery:** `cf delete <app-name> -f` (after unbinding services). The next MTA deploy re-creates the app fresh with clean build state. Applies to any app that has been touched by manual `cf push` OR by an aborted MTA deploy.

**4. When the ghost `xsappname` collides.** If `tutorials-ims!t<n>` is registered on the tenant XSUAA server from an earlier failed attempt, no service instance can claim it. Change `xs-security.json` to a different xsappname (e.g. `tutorials`) to sidestep the ghost. The tenant AppId is minted for as long as the tenant exists; it cannot be reaped from the CF/BTP side.

Estimated PROD-cutover time impact: add ~30 minutes for the pre-create-service step + user-assignment restore, and expect that a full cf-deploy after xsuaa recreation may require deleting 3-4 apps to clear stale build state before it succeeds. Blue-green strategy in PROD does not avoid these issues — it just delays them to the swap phase.



A reference of pitfalls discovered while deploying this project's MTA. Each subsection is a single discovered failure mode with cause and fix. Originally maintained as agent-memory entries; promoted here 2026-06-24 so future deployers find them via the sidebar instead of re-discovering them.

## Gotchas (deploy-time pitfalls)

A reference of pitfalls discovered while deploying this project's MTA. Each subsection is a single discovered failure mode with cause and fix. Originally maintained as agent-memory entries; promoted here 2026-06-24 so future deployers find them via the sidebar instead of re-discovering them.

### `${VAR}` placeholders in mtaext are resolved server-side — envsubst locally first

`${GITHUB_DISPATCH_TOKEN}` (and any other `${...}` placeholder) in `deploy/*.mtaext` is **not** substituted from the local shell's environment. The MTA deploy-service does the resolution server-side against MTA descriptor parameters, and `mta.yaml` doesn't declare these as parameters — so neither `GITHUB_DISPATCH_TOKEN=x cf deploy ...` nor `CF_VAR_github_dispatch_token=x cf deploy ...` work. `cf deploy` itself has no `--var` flag (verified 2026-06-20: returns "Unknown or wrong flags: --var").

**Why:** deploy fails with `Error resolving merged descriptor properties and parameters: Unable to resolve "tutorials-srv#GITHUB_DISPATCH_TOKEN"`.

**How to apply:** When deploying locally without the real PAT (e.g. when CI normally injects it), pre-resolve the mtaext with `envsubst` into a temp copy, deploy that, and delete it after:

```bash
cd d:/projects/tutorials-poc
export GITHUB_DISPATCH_TOKEN=admin-rebuild-disabled-pending-pr   # or real PAT
envsubst < deploy/dev.mtaext > .deploy/dev.mtaext.resolved
cd .deploy && cf deploy mta_archives/tutorials-ims_1.0.0.mtar -e dev.mtaext.resolved -f
rm .deploy/dev.mtaext.resolved
```

A placeholder PAT is safe for ad-hoc deploys: only [srv/lib/rebuild-trigger.js](../../../srv/lib/rebuild-trigger.js)'s admin-write debounce-dispatch consumes it (calling GitHub's `workflow_dispatches` endpoint with `Authorization: token <value>`). GitHub returns 401, the fetch wrapper catches, logs warn, returns — no propagation. So admin-save → auto-rebuild silently no-ops. Reading tutorials, learner progress, quiz submission, code-check, AI-author, search, all admin reads — none affected.

CI uses `--var github-dispatch-token=...` per CLAUDE.md docs — but that's the GitHub Actions / `mbt` deploy step, not raw `cf deploy`. The `mbt deploy` plugin has the flag; `cf deploy` doesn't.

### Empty-value placeholders become YAML `null` and MTA rejects them

When `envsubst < dev.mtaext > dev.resolved.mtaext` substitutes a placeholder with an EMPTY env var (e.g. unset `GITHUB_DISPATCH_TOKEN=""`), the resulting line is `KEY:` followed by a single space and no value. YAML parses that as `null`, NOT as `""`. The MTA descriptor merger rejects null with `"The property X is not optional and has no value"` — even though the BASE mta.yaml declares the property with `KEY: ""` (empty string).

**Why:** Any empty placeholder in dev/qa/prod.mtaext stops cf deploy at the descriptor-merge step.

**How to apply:** When running a local deploy with no real value for a secret-bearing var, **strip the empty placeholder lines** from the resolved mtaext rather than letting them write a YAML-null override. One-liner:

```bash
GITHUB_DISPATCH_TOKEN="$YOUR_PAT" \
CONTENT_API_KEY="$YOUR_CONTENT_KEY" \
APPROUTER_URL="$YOUR_APPROUTER_URL" \
envsubst '$GITHUB_DISPATCH_TOKEN $CONTENT_API_KEY $APPROUTER_URL' \
  < deploy/dev.mtaext > deploy/dev.resolved.mtaext
sed -E -i '/^[[:space:]]+[A-Z_]+:[[:space:]]*$/d' deploy/dev.resolved.mtaext
```

> **Note (2026-07-02):** `REBUILD_API_KEY` formerly rode through `envsubst`
> here. Removed in PR #903 (finishes #871 rollout): approuter reads it
> exclusively from BTP Credential Store via
> [approuter/lib/credstore-secret.js](../../../approuter/lib/credstore-secret.js).
> Rotation is done through the admin UI at `/admin-ui/#secrets-display`.
>
> **Note (2026-06-26):** SMTP transport config (`SMTP_HOST/PORT/USER/FROM/PASS`)
> and `REBUILD_TARGET_ENV` formerly rode through `envsubst` here. They now live
> in BTP Credential Store / `TenantSettings` respectively and are managed via
> the admin UI (`/admin-ui/#secrets-display`, `/#tenantsettings-display`). The
> envsubst allowlist above is the complete remaining set.

After the strip, the base mta.yaml's `KEY: ""` default takes effect. This matches the actual deploy intent ("don't override").

### mtaext cannot introduce new properties — base mta.yaml must declare them first

MTA spec requires the base `mta.yaml` to **declare** every property before a `.mtaext` extension descriptor can **override** it. An mtaext that adds a property not present on the base module fails with:

```text
Error merging descriptors: The property "tutorials-srv#X" is not optional and has no value.
```

**Caught 2026-06-23 DEV deploy:** `deploy/dev.mtaext` declared `CONTENT_API_KEY`, `EXPOSE_CAP_UI`, `GITHUB_DISPATCH_TOKEN` (and previously `REBUILD_TARGET_ENV`, removed in the credstore-runtime-config follow-up) on tutorials-srv, but `.deploy/mta.yaml`'s tutorials-srv module declared NONE of them. CI's Build & Deploy workflow had been failing at cf login (UAA/OTP cutover since 2026-06-21) before ever reaching descriptor-merge, so this bug had been hiding for days. Fixed in PR #584.

**How to apply:** Before adding a new env var to any `deploy/<env>.mtaext`, **first** add it (with a safe default like `""`, `false`, or a benign string) to the matching module in `.deploy/mta.yaml` and source `mta.yaml`. Empty string for secrets, `false`/dormant defaults for flags, `"dev"` placeholder for env strings.

### `cf set-env` doesn't survive MTA redeploys — use mtaext

CF env vars set via `cf set-env tutorials-srv FOO bar` are dropped by every MTA redeploy. Symptom: a manually-set var works for a while, then a deploy ships and the runtime quietly loses it (#435: `GITHUB_DISPATCH_TOKEN` unset → admin-write rebuild dispatch silently no-ops; surfaced via #382 phase F1 manually-fired runs).

**Why:** `cf deploy` materializes `tutorials-srv` env from the mtaext `properties:` block + the resource bindings. Anything set out-of-band via `cf set-env` is invisible to MTA and gets clobbered.

**How to apply:** When asked "put X in env so it survives," default to the mtaext path:

1. Add `FOO: ${foo}` to `deploy/<env>.mtaext` `tutorials-srv` properties for each env.
2. If the value is the same across envs, use one placeholder + one CI secret.
3. If per-env literal, put the literal in each mtaext. (Until 2026-06, `REBUILD_TARGET_ENV: dev`/`qa`/`prod` followed this pattern; it now lives in `TenantSettings` via the admin UI instead.)
4. Add `--var foo="${{ secrets.FOO }}"` to the `cf deploy` invocation in `.github/workflows/deploy.yml`.
5. Document in [GitHub Dispatch PAT Rotation](github-dispatch-pat-rotation.md)-style runbook + add a CLAUDE.md gotcha for local manual deploys (`--var foo=...` on `cd .deploy && cf deploy ... -e ../deploy/dev.mtaext`).

The existing pattern (`${content-api-key}`, `${rebuild-api-key}`, `${approuter-url}`) is the canonical reference — don't invent a new pattern unless ≥3 such tokens exist.

**Safe failure mode:** if the GH Actions secret is missing at deploy, `cf deploy` passes empty `--var`, the property resolves to empty string, runtime falls back to existing graceful-degraded behavior. No outage.

PR: #438. Spec: `docs/superpowers/specs/2026-06-19-github-dispatch-token-mtaext-design.md`.

### `cf deploy` buffers stdout for 5+ minutes during stage transitions

`cf deploy` (the MTA deployer plugin) does NOT stream stdout reliably. During heavy stage transitions (staging, binding, async upload), the output file can stay 0-bytes for 5+ minutes while the deploy is making real progress on the cluster. The CLI flushes its buffer only at major stage boundaries. Caught 2026-06-18 when `tail` of the task output file showed 0 bytes for 4+ minutes — but `cf apps` showed `tutorials-srv` had been started 5 minutes earlier.

**Why:** The `cf deploy` plugin uses the CF API to trigger async build/staging tasks on the cluster. Those tasks run independently of the local CLI session. The CLI polls and prints status updates only when the cluster reports a stage transition (e.g., "Application X staged" → "Starting application X"). If the cluster spends 5 minutes binding services or running buildpack stages, the local CLI sits silent. There's no `--verbose` or `--stream-output` flag that fixes this — it's how the plugin works.

**How to apply:**

1. **NEVER trust an empty `cf deploy` task output file as evidence the deploy is hung.** It's almost certainly progressing on the cluster.
2. **Before assuming a deploy is hung, probe live app state directly:**

   ```bash
   cf apps  # see which apps are started/stopped
   curl -s -o /dev/null -w '%{http_code}\n' https://<app>.cfapps.<region>.hana.ondemand.com/health
   cf events <app-name> | head -10  # recent stage events
   ```

   If `cf apps` shows `web:1/1` and `/health` returns 200, the deploy is effectively done — even if the local cf CLI is still spinning.
3. **The deploy is only TRULY hung if:**
   - `cf apps` shows the app is `stopped` 10+ minutes after `audit.app.start` event
   - No events at all in `cf events <app>` for the last 10 minutes
   - `cf logs <app> --recent` shows no activity
4. **For agent workflows:** Don't `sleep N && tail` the task output. Probe the actual cluster state every 60s during a deploy.

### `mbt build`'s `cp -r` adds files but never deletes — renames leave ghosts

The `before-all` build hook in `.deploy/mta.yaml` copies app builds into the approuter's static directory:

```yaml
- npm --prefix ../app/admin-shell install
- npm --prefix ../app/admin-shell run build
- mkdir -p static/admin-ui
- cp -r ../app/admin-shell/dist/. static/admin-ui/
```

`cp -r` is a UNION operation, not a sync. It ADDS files but never DELETES them. So when a source file is **renamed** (e.g. `AdvocatePhotoController.controller.js` → `AdvocatePhotoController.js` in PR #405), the OLD file persists in `approuter/static/admin-ui/` forever, and ships with every subsequent deploy alongside the new one. Diagnostic symptom: after a rename PR deploys cleanly, the OLD module still loads at runtime (browser caches lie too, but this is a real ghost). Caught 2026-06-18 by `unzip -l mta_archives/*.mtar | grep <name>` showing both files.

**Why:** `mbt build` only ever invokes the hooks declared in `mta.yaml`. There's no implicit cleanup of the destination directory between builds — by design (some modules want manual additions to survive). Combined with the `.controller.js` / `.js` suffix collision in UI5 (FE V4 `press` bindings load plain `.js`; controller extensions load `.controller.js`), you get a deploy that LOOKS successful but ships TWO files for the same logical module.

**How to apply:**

1. After ANY rename of a file under `app/<X>/`, manually `rm` the old name from `approuter/static/<X>/` BEFORE running `mbt build`. There is no automated guard.
2. Always verify the mtar contents before deploy on rename PRs:

   ```bash
   cd .deploy && mkdir -p ..deploy_mta_inspect && cd ..deploy_mta_inspect
   unzip -p ../mta_archives/tutorials-ims_1.0.0.mtar tutorials-approuter/data.zip > approuter.zip
   unzip -l approuter.zip | grep <renamed-file>
   ```

   Should show ONE file. Two = ghost.
3. Long-term fix worth proposing: prepend the static-dir copy with `rm -rf static/admin-ui` (or per-component `rm -rf static/admin-ui/components/<X>`). Adds ~100ms to build, eliminates the ghost-file class of bug entirely. Same hazard exists for analytics-ui, scanner-ui, display-app cp lines.
