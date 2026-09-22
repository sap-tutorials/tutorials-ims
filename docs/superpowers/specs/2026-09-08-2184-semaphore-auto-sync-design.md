# Semaphore Taxonomy Auto-Sync (#2184)

**Date:** 2026-09-08
**Issue:** [sap-tutorials/tutorials-ims#2184](https://github.com/sap-tutorials/tutorials-ims/issues/2184) — "Automate Loading Data from Semaphore"
**Status:** implemented behind a default-OFF DB feature flag (`SEMAPHORE_SYNC_ENABLED`).
Auth contract confirmed live against PDC 2026-09-22 (Service Account issued); PDC
two-step token exchange + self-rotation now implemented. Awaits the DEV dry-run
class-tuning pass before flipping `dryRun` off, then PROD enable.

## Problem

Tag taxonomy is currently loaded from Progress/Smartlogic **Semaphore** by a manual,
one-off batch. Terms drift (renames, new industry clusters, retired products) and the
`Tags` table goes stale until someone re-runs the load by hand. The issue asks: can this
be automated?

## Answer

Yes. Semaphore's **SES (Semantic Enhancement Server)**, hosted on the Progress
Data Cloud (PDC), exposes a read-only REST API. The `allterms` command returns
every term of a model as JSON, filterable by class:

```
GET {base}/{model}/{lang}/allterms.json[?FILTER=CL=<class>]
e.g. https://sap.data.progress.cloud/semantic/prodses/SAPCore/en/allterms.json
```

### Auth — PDC two-step token exchange (confirmed live 2026-09-22)

`allterms` is Bearer-protected; the bearer token is minted from the Service
Account **API key** via a token endpoint at the PDC host root:

```
POST {host}/token/
  Content-Type: application/x-www-form-urlencoded
  body: key=<apiKey>                 ← field name is "key" (NOT "apikey")
→ 200 { access_token, token_type:"bearer", expires_in:180, ".expires", userName }
```

The access token lives **~180 seconds**, so the job mints a fresh one per run
immediately before the `allterms` call — no cross-run token cache.

### Key self-rotation (confirmed live 2026-09-22)

The API key itself is long-lived but expires (issued key: 2026-12-20). PDC
exposes rotation, folded into the weekly job (each run checks, rotates if within
7 days of expiry):

```
GET {host}/api/account/apikey  (Bearer)  → { apikey, expiryDate }
PUT {host}/api/account/apikey  (Bearer)  → { apikey:"<NEW>", ... }
   ⚠️ the PUT disconnects the current session; the new key is persisted to the
      Credential Store and used on the next run.
```

The API key is resolved via `secret-resolver` (`SEMAPHORE_API_KEY` env in dev →
BTP Credential Store alias in hybrid/prod) and written back on rotation via
`credstore.writeSecret`. Rotation is **fail-soft** — a rotation error is logged
and never blocks the taxonomy sync (the current key is valid until `expiryDate`).

## Design

Pipeline (weekly cron, all pure/injectable for test):

```
client.fetchAllTerms(SAPCore)   → SES allterms JSON
  → mapper.mapAllTerms(data)    → [{ semaphoreId, label, name, titlePath, isActualTag, isInterestItem }]
    → applier.applyTerms(rows)  → upsert into Tags, keyed on semaphoreId
```

### Components

| File | Role |
|---|---|
| `srv/lib/semaphore-sync/client.js` | PDC client. Resolves base URL from `semaphore-destination` + API key from `secret-resolver`, does the two-step token exchange (`POST /token/` → Bearer), builds the allterms URL, GETs with a 120s timeout, **fails shut** (throws) on any HTTP/parse/shape error. `resolveConnection()` mints one token shared by rotation + fetch. |
| `srv/lib/semaphore-sync/rotation.js` | Key self-rotation. `GET /api/account/apikey` for `expiryDate`; if within 7 days, `PUT` to rotate, persist via `credstore.writeSecret`, flush the resolver cache. **Fail-soft** — never blocks the sync. |
| `srv/lib/semaphore-sync/mapper.js` | Pure transform SES term → tag row. Derives `titlePath` (unwraps the live `paths[].path[].field.name` shape, drops Concept-Scheme/SCHEMA scaffold nodes) and `name` (normalized). Class→flag mapping is **config-driven** (`actualTagClasses` / `interestItemClasses`). |
| `srv/lib/semaphore-sync/applier.js` | Upsert engine keyed on `semaphoreId` (distinct from the CSV importer which keys on `name`). Adopts a legacy row by name when it has no `semaphoreId` yet. Idempotent; supports `dryRun`. |
| `srv/jobs/semaphore-tag-sync-job.js` | Orchestrator: resolve connection → rotate (fail-soft) → fetch (fail-shut) → map → upsert. Flag-gated, config-driven. |

### No schema change

`Tags` already carries `semaphoreId`, `isActualTag`, `isInterestItem` (PR-1 of #385). The
manual load and the one-time migration are the only current sources of `semaphoreId`; this
job keeps it fresh.

### Configuration (DB-driven — no env vars)

Feature flag (registry `kind:'db'`, ImsConfig `flag.semaphore.sync`, default **OFF**, `dev-only`):

- `SEMAPHORE_SYNC_ENABLED` — master switch. Off → job no-ops (`reason:'flag-off'`).

ImsConfig string keys tune a run without redeploy:

| Key | Default | Purpose |
|---|---|---|
| `semaphore.sync.model` | `SAPCore` | SES model name |
| `semaphore.sync.lang` | `en` | language |
| `semaphore.sync.filter` | — | optional SES `FILTER` clause |
| `semaphore.sync.actualTagClasses` | — | comma-sep classes → `isActualTag=true` |
| `semaphore.sync.interestItemClasses` | — | comma-sep classes → `isInterestItem=true` |
| `semaphore.sync.dryRun` | `true` | **report-only** until validated against real data |

### Destination + secret

`cds.requires.semaphore` (kind `rest`) → BTP destination `semaphore-destination`
(`hybrid` + `production`), which supplies only the **base URL** (path
`/semantic/prodses`). Base/dev/unit profiles use a mock URL in `.cdsrc.json`.

The API **key** is NOT a destination credential — it is a `secret-resolver`
secret under alias `SEMAPHORE_API_KEY` (`process.env` in dev → BTP Credential
Store in hybrid/prod). Set/rotate it via `/admin-ui/#secrets`. To surface it in
the Secrets UI and the daily expiry-check job, insert a `Secrets` row
(`key='SEMAPHORE_API_KEY'`, `expiresAt=<key expiryDate>`); rotation updates the
credstore value in place (the `Secrets.expiresAt` row can be refreshed from the
rotation summary).

### Open items (before flipping `dryRun` off, then the flag on PROD)

1. Run the job in `dryRun` on DEV against the live SAPCore payload (~21k terms,
   60 classes) and tune `semaphore.sync.filter` + `actualTagClasses` /
   `interestItemClasses`. Only `TOPIC` (~102 terms) looks tag-shaped; the bulk
   is `PRODUCT_VERSION`/`MATERIAL`/`PRODUCT` — a `FILTER=CL=TOPIC` (or the set of
   classes matching our existing `semaphoreId` tags) is almost certainly wanted
   so we don't ingest 21k product/material rows.
2. Flip `semaphore.sync.dryRun` off on DEV, verify the upsert, then enable
   `SEMAPHORE_SYNC_ENABLED` on PROD.

### Safety

- **DEV-first, not prod-only** (unlike NGDS/feedback) — the mapping must be validated on DEV
  before PROD; `dryRun` defaults ON so the *first* enabled runs only report the plan.
- **Fail-shut fetch:** a transient SES outage or garbled payload throws before the applier
  is reached, so the taxonomy is never wiped by an empty response. A FAILED run is recorded.
- **Idempotent upsert:** re-running with the same payload reports everything `unchanged`.
- Weekly cadence: **Sunday 04:47 UTC**, 20-min lock (off the existing minute grid).

## Tests

- `test/unit/semaphore-mapper.test.js` — transform, dedupe, class→flag, malformed input, **live field-wrapped hierarchy** (scaffold-node drop, leaf de-dup, label trim).
- `test/unit/semaphore-client.test.js` — URL builder, token-base derivation, `POST /token/` exchange (form `key=`), pre-resolved-connection reuse, HTTP/shape errors.
- `test/unit/semaphore-rotation.test.js` — `daysUntil`, no-rotate-when-in-date, rotate+persist+cache-flush, fail-soft on error / missing new key.
- `test/unit/semaphore-sync-applier.test.js` — insert/update/adopt/idempotent/dryRun (DB-backed).
- `test/unit/semaphore-tag-sync-job.test.js` — flag gate, dryRun default, write path, fail-shut, rotation pre-check wiring.

Auth contract + `allterms` shape verified live against PDC 2026-09-22 (see the "Answer" section for the confirmed request/response formats).
