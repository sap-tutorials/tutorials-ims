---
title: cds-caching CDS-Database store + metrics (multi-instance CF)
description: Why the shared caching service uses the CDS-Database store in hybrid/production, how the CacheStore + metrics tables reach HANA, and how to read hit-rate/latency metrics.
---

# `cds-caching` CDS-Database store + metrics

> Issue #1179. Builds on the #1177 prototype ([kg-neighborhood cache](../../../srv/lib/kg-neighborhood-cache.js), PR #1178) and the #1181 [on-read fetch caching](./on-read-fetch-caching.md). Unblocked once #1178 landed.

## What this covers

The shared `caching` service (the `cds-caching` plugin, `cds.requires.caching` in
`package.json`) backs the KG neighborhood cache (#1177/#1180) and the on-read
external fetchers (#1181). The #1178 prototype configured it with the **in-memory**
store — correct for a single-process pilot, but incoherent across our multi-instance
Cloud Foundry deployment: each app instance holds its own `Map`, so a `deleteByTag`
bust on one instance leaves the other instances serving stale entries, and hit rates
are diluted because instances don't share a warm cache.

This change switches the store to the **CDS-Database store** (`"store": "cds"`) in the
`[hybrid]` and `[production]` profiles, and enables **metrics persistence** so we can
observe hit rates / latencies and judge whether broader `@cache` adoption is worth it.

## Configuration

`package.json` → `cds.requires.caching`:

```jsonc
"caching": {
  "impl": "cds-caching",
  "namespace": "kg",
  "store": "memory",          // base: local `cds watch` + unit tests
  "[hybrid]":     { "store": "cds", "metrics": { "enabled": true } },
  "[production]": { "store": "cds", "metrics": { "enabled": true } }
}
```

- **Base stays `memory`.** Local `cds watch` (in-memory SQLite) and the vitest `unit`
  project never touch HANA, so they keep the zero-setup memory store. The profile
  overrides inherit `impl` and `namespace` from the base entry (verified with
  `cds env requires.caching --profile hybrid`).
- **`store: "cds"`** reuses the app's managed DB connection (the same HANA HDI
  container as everything else). No new BTP entitlement, no service binding, and
  automatically tenant-isolated in MTX. This is the store cds-caching recommends for
  HANA/CAP.
- **`metrics.enabled: true`** turns on read-through hit/miss + latency collection,
  persisted hourly (default `persistenceInterval` 60 s) to the `Metrics` / `KeyMetrics`
  tables. We deliberately did **not** register the OData management API
  (`CachingApiService` at `/odata/v4/caching-api/`): it exposes write actions
  (`clear`, `deleteEntry`, `setEntry`, `setMetricsEnabled`) that we don't need for a
  read-only "is the pilot working" judgement. Metrics are read via SQL / the analytics
  explorer instead. The API can be added later behind `@requires:'Admin'` if broader
  adoption warrants a dashboard.

## Multi-instance coherence

With `store: "cds"` all CF instances read and write the **same** `CacheStore` rows in
HANA:

- A `setCachedNeighborhood(...)` on instance A is immediately visible to instance B's
  next `get`.
- `bustNeighborhoodCache()` (a single `deleteByTag('kg-neighborhood')`) deletes the
  shared rows, so a graph rebuild on any one instance invalidates the cache for **all**
  instances — the coherence property the in-memory store could not provide.
- TTL is enforced by `expiresAt` on each row, not per-process timers.

## HANA / HDI artifacts — the `.cdsrc.json` build tasks

`store: "cds"` ships a `CacheStore` entity, and `metrics.enabled` uses the plugin's
`Caches` / `Metrics` / `KeyMetrics` entities. All four must exist as tables in the
HANA HDI container. **This project declares an explicit `build.tasks` list in
`.cdsrc.json`, which suppresses cds's auto-registration of the plugin's build task** —
so with the default task list, none of these tables were emitted (`cds build` produced
zero `plugin.cds_caching.*` artifacts). Two tasks were added to fix that:

```jsonc
"build": {
  "tasks": [
    { "for": "hana", "src": "db", "dest": "db" },
    // …existing srv / db-qa / srv-qa tasks…
    { "for": "cds-caching" },                                             // → CacheStore.hdbtable
    { "for": "hana", "src": "db", "dest": "db",
      "options": { "model": ["cds-caching/db/statistics"] } }            // → Caches / Metrics / KeyMetrics
  ]
}
```

- `{ "for": "cds-caching" }` is the plugin's own build task. It emits
  `plugin.cds_caching.CacheStore.hdbtable` into `gen/db/src/gen/` (only when
  `store: "cds"` + a HANA DB, so the base/sqlite profile skips it).
- The second task compiles **only** the plugin's `statistics` model into the main `db`
  container, emitting the three metrics tables. It must NOT list `db` in its model —
  passing `options.model` to a `db`-dest task overrides cds's default model resolution
  and would drop all ~247 service `.hdbview` artifacts (verified: 535 → 288 files). A
  `statistics`-only model is additive and safe (535 → 539 with the CacheStore + 3
  metrics tables).
- **QA container is intentionally untouched.** `tutorials-srv-qa` does not wire the
  caching service (its `cds.requires` is `db` + `auth` only) and never imports the
  cache module, so `tutorials-hana-qa` gets **no** `cds_caching` tables — verified in
  the production build (`gen/db-qa` has zero `plugin.cds_caching.*` artifacts).

No `srv/lib/` transitive deps changed (this is a config-only change), so the MTA
`srv-qa` `cp` list needs no edit — `kg-neighborhood-cache.js` is already listed.

## Deploy ordering — tables must exist before the srv app boots

With `metrics.enabled`, cds-caching reads its `Caches` config table **at service
connect time** (and on the first cache op). If those tables do not yet exist in the
HANA container, that read fails with a HANA `SqlError` that **invalidates the
request-scoped DB connection** — and because cds-caching's internal config/metric
reads are not fully fail-open, a subsequent unrelated query in the same request can
then fail with `Database connection is disconnected`, surfacing as a **500 on
otherwise-healthy KG endpoints** (e.g. `/graph/neighborhood`). Our own cache wrappers
(`getCachedNeighborhood` / `setCachedNeighborhood` in `kg-neighborhood-cache.js`) *are*
fail-open and return a miss, but they cannot protect against cds-caching's own
config-table reads.

**This is a non-issue in a normal MTA deploy:** the `tutorials-db-deployer` (`type:
hdb`) creates the schema (including the four `plugin_cds_caching_*` tables) before
`tutorials-srv` starts, so the tables always exist by the time the caching service
connects. The failure mode only appears if you point new `store: "cds"` config at a
container that predates this change — which is exactly why the hybrid neighborhood
tests (`test/hybrid/kg-neighborhood-*.test.js`) fail until the container is redeployed
with the new build artifacts. **Deploy the db module before (or with) the srv module;
do not run these hybrid tests against a container that hasn't received the new tables.**
Once the container is redeployed, re-run:

```bash
npm run test:hybrid -- test/hybrid/kg-neighborhood-anonymous.test.js \
                        test/hybrid/kg-neighborhood-full.test.js
```

## Reading the metrics

Metrics persist to the main HDI container. Query them via the analytics explorer or
`hana-cli` / `hdbsql`:

```sql
-- hourly hit ratio / latency for the shared cache
SELECT "cache", "period", "timestamp", "hits", "misses", "hitRatio",
       "avgHitLatency", "avgMissLatency", "throughput"
  FROM "PLUGIN_CDS_CACHING_METRICS"
 WHERE "period" = 'hourly'
 ORDER BY "timestamp" DESC;

-- per-key breakdown (which slugs are hot)
SELECT "keyName", "hits", "misses", "hitRatio", "lastAccess"
  FROM "PLUGIN_CDS_CACHING_KEYMETRICS"
 ORDER BY "hits" DESC;
```

The `Caches` table holds one row per configured cache service (`name = 'caching'`) with
its serialized config.

## Test-harness note (fork-pool boot race)

The #1177 prototype observed a flaky fork-pool race: unit files each set
`cds.env.requires.caching = {…}` in their own `beforeAll`, but a dynamically-imported
SUT could call `cds.connect.to('caching')` before that ran — leaving a window with no
caching config, which under fork-pool load raced two concurrent boots or stalled
(~110 s once). Fixed with a per-worker vitest `setupFiles` entry
([test/unit/_caching-setup.js](../../../test/unit/_caching-setup.js)) that stamps a
stable in-memory caching config into `cds.env.requires` before any test module imports
its SUT. Per-file `beforeAll` overrides (namespace isolation) still work — they narrow
an already-valid config instead of creating it from nothing.

Unit tests always use the **memory** store (base profile); the CDS-DB store is
exercised only under the `[hybrid]`/`[production]` profiles via the hybrid test project.
