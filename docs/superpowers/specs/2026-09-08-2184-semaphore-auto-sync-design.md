# Semaphore Taxonomy Auto-Sync (#2184)

**Date:** 2026-09-08
**Issue:** [sap-tutorials/tutorials-ims#2184](https://github.com/sap-tutorials/tutorials-ims/issues/2184) — "Automate Loading Data from Semaphore"
**Status:** implemented behind a default-OFF DB feature flag (`SEMAPHORE_SYNC_ENABLED`); ships dark, awaits a Service Account + `semaphore-destination`.

## Problem

Tag taxonomy is currently loaded from Progress/Smartlogic **Semaphore** by a manual,
one-off batch. Terms drift (renames, new industry clusters, retired products) and the
`Tags` table goes stale until someone re-runs the load by hand. The issue asks: can this
be automated?

## Answer

Yes. Semaphore's **SES (Semantic Enhancement Server)** exposes a read-only REST API. The
`allterms` command returns every term of a model as JSON, filterable by class:

```
GET {base}/{model}/{lang}/allterms.json[?FILTER=CL=<class>]
e.g. https://sap.data.progress.cloud/semantic/prodses/SAPCore/en/allterms.json
```

Auth needs a Semaphore **Service Account** + API User role + token (requested by email in
parallel — see the issue comment). Productive/unattended use requires a Service Account
rather than a personal user.

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
| `srv/lib/semaphore-sync/client.js` | SES REST client. Resolves `semaphore-destination` (auth token / basic), builds the allterms URL, GETs with a 20s timeout, **fails shut** (throws) on any HTTP/parse/shape error. |
| `srv/lib/semaphore-sync/mapper.js` | Pure transform SES term → tag row. Derives `titlePath` (human "A : B") and `name` (normalized). Class→flag mapping is **config-driven** (`actualTagClasses` / `interestItemClasses`). |
| `srv/lib/semaphore-sync/applier.js` | Upsert engine keyed on `semaphoreId` (distinct from the CSV importer which keys on `name`). Adopts a legacy row by name when it has no `semaphoreId` yet. Idempotent; supports `dryRun`. |
| `srv/jobs/semaphore-tag-sync-job.js` | Orchestrator. Flag-gated, config-driven, fail-shut. |

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

### Destination

`cds.requires.semaphore` (kind `rest`) → BTP destination `semaphore-destination`
(`hybrid` + `production`). Base/dev/unit profiles use a mock URL in `.cdsrc.json`. The
Service Account token lives in the destination / BTP Credential Store — **never** in source.

### Safety

- **DEV-first, not prod-only** (unlike NGDS/feedback) — the mapping must be validated on DEV
  before PROD; `dryRun` defaults ON so the *first* enabled runs only report the plan.
- **Fail-shut fetch:** a transient SES outage or garbled payload throws before the applier
  is reached, so the taxonomy is never wiped by an empty response. A FAILED run is recorded.
- **Idempotent upsert:** re-running with the same payload reports everything `unchanged`.
- Weekly cadence: **Sunday 04:47 UTC**, 20-min lock (off the existing minute grid).

## Open items (need the Service Account before flipping ON)

1. Confirm the exact `paths` element shape and the class URIs that denote "actual tag" vs
   "interest item" against a live SAPCore payload — the mapper is deliberately config-driven
   and conservative (every term an actual tag, none an interest item) until then.
2. Confirm the destination auth flavour (OAuth2 client-credentials vs. long-lived bearer);
   `client.deriveAuth()` already handles token / basic.
3. Run the job in `dryRun` on DEV, tune the class lists, then flip `dryRun` off, then enable
   the flag on PROD.

## Tests

- `test/unit/semaphore-mapper.test.js` — transform, dedupe, class→flag, malformed input.
- `test/unit/semaphore-client.test.js` — URL builder, auth derivation, HTTP/shape errors.
- `test/unit/semaphore-sync-applier.test.js` — insert/update/adopt/idempotent/dryRun (DB-backed).
- `test/unit/semaphore-tag-sync-job.test.js` — flag gate, dryRun default, write path, fail-shut.
