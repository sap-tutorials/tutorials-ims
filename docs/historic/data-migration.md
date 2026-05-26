---
title: Data Migration (Historic)
description: Cutover-era data migration from Java IMS to the CAP backend. Migration is complete; kept for reference.
---

# Data Migration (Historic)

> **Status:** complete. This document describes the one-time data migration from Java IMS to the CAP backend during the 2026 cutover. Kept for historical reference.

> Source: extracted from project README, 2026-05-25.

Migration scripts in `scripts/` support parallel operation during cutover from the Java IMS. Three migration paths cover the matrix of source-system access (REST API vs. direct HANA):

| Script | npm alias | Source → Target | Purpose |
| --- | --- | --- | --- |
| `migrate-reference-data.js export` | `npm run migrate:reference` | IMS REST → JSON file | Export tutorials, missions, groups, events, tags, accomplishments, prizes |
| `migrate-reference-data.js import` | `npm run migrate:reference` | JSON file → CAP | Import reference data into CAP HDI (idempotent on `legacyId`) |
| `migrate-reference-data.js populate-slugs` | — | `.migration-data/slug-mapping.json` → CAP | Backfill `Missions.slug` + `CompletionPaths.slug` after import (87 missions, 66 groups) |
| `migrate-user-progress.js export` | `npm run migrate:users` | IMS REST → JSON file | Paged + resumable export of users + task records |
| `migrate-user-progress.js import` | `npm run migrate:users` | JSON file → CAP | Idempotent re-import (uses `uuid`/`legacyId` for upsert) |
| `migrate-from-hana.js` | `npm run migrate:hana` | IMS HANA → CAP HANA | Direct HDI-to-HDI migration; bypasses the REST API for bulk + cross-instance moves |
| `compare-systems.js` | `npm run compare` | IMS vs. CAP REST | Endpoint-by-endpoint diff for cutover sign-off |

#### `migrate-from-hana.js` source-credentials resolution (first match wins)

1. `IMS_HANA_CREDENTIALS` env var (full JSON: `host`, `port`, `user`, `password`, `schema`)
2. `IMS_DB_URL` + `IMS_DB_USERNAME` + `IMS_DB_PASSWORD` env vars (the shape returned by `cf env imsdev`)
3. `--source-instance=<name> --source-key=<name>` (resolved via `cf service-key`)

Useful flags: `--discover` (list source-schema tables, no writes), `--dry-run`, `--source-only`, `--entity=tutorials,users,…`.

#### Environment

`IMS_BASE_URL`, `CAP_BASE_URL`, `IMS_AUTH_TOKEN` for the REST-based scripts; HANA env vars (above) for `migrate-from-hana.js`. Java IMS uses the `IMSDBUSER` schema (not the HDI schema) — see `cf env imsdev` for prod creds.

Export artifacts land in `.migration-data/` (gitignored). The same directory holds `slug-mapping.json`, which is **the canonical slug source for fresh DB deploys** — `scripts/setup-dev-data.cjs` consumes it via `npx cds bind --exec` to assign slugs to records that lack them. Per [CLAUDE.md](https://github.com/sap-tutorials/tutorials-poc/blob/main/CLAUDE.md), the legacyId match is best-effort; a slug just needs to exist for `/build/catalog` to surface text slugs instead of numeric IDs.
