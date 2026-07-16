---
title: cds-caching CDS-Database store + metrics (multi-instance CF)
description: Why the shared caching service uses the CDS-Database store in hybrid/production, how the CacheStore + metrics tables reach HANA, and how to read hit-rate/latency metrics.
---

# `cds-caching` CDS-Database store + metrics

> Issue #1179. Builds on the #1177 prototype ([kg-neighborhood cache](../../../srv/lib/kg-neighborhood-cache.js), PR #1178) and the #1181 [on-read fetch caching](./on-read-fetch-caching.md). Unblocked once #1178 landed.
>
> **⚠️ Read the [CF boot resolve-guard](#cf-boot-the-resolve-guard-crash-1179-revert--1182-fix) section first.** The first srv deploy carrying `store: "cds"` crash-looped on CF (#1179 was reverted in PR #1207). The store is re-enabled by #1182, which pairs the config with a resolve-guard fix. Do not re-enable `store: "cds"` without both halves of that fix in place.

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
  "[hybrid]":     { "store": "cds" },
  "[production]": { "store": "cds" }
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
- **`metrics.enabled` is OFF (#1215).** It was originally `true` in both profiles to
  collect read-through hit/miss + latency counters, but on HANA the plugin's
  stats-accumulation path throws `Wrong input for INT type` on every flush and the
  counters never persist (they stuck at 0 across all hourly rows). Root cause: the
  plugin reads the existing hourly row via a flattened table-name SELECT
  (`SELECT.one.from("plugin_cds_caching_Metrics")`), which returns UPPERCASE column
  keys on HANA (`HITS` not `hits`), so `existingHourly.hits + stats.hits` is
  `undefined + n = NaN` → hdb's INT writer throws (it throws only on `isNaN`). See
  [`metrics.enabled` "Wrong input for INT type"](cds-caching-metrics-int-type-error-on-hana.md).
  Because the counters were already non-functional, disabling loses nothing and stops
  the error-level log noise. The OData management API (`CachingApiService`) was never
  registered. **Re-enable only after the upstream casing bug is fixed** (and update the
  `test/unit/caching-metrics-disabled.test.js` guard in the same change).

  > **Two-part disable (config + persisted flag).** Removing `metrics.enabled` from
  > config is necessary but not sufficient on an environment where metrics were
  > previously on: cds-caching persists the enabled state into
  > `PLUGIN_CDS_CACHING_CACHES.METRICSENABLED`, and `getRuntimeConfiguration()` reads
  > that column back on every boot. Nothing in the plugin ever writes it back to `0`.
  > **After deploying the new config**, reset the persisted flag once per environment:
  >
  > ```sql
  > UPDATE "PLUGIN_CDS_CACHING_CACHES" SET "METRICSENABLED" = 0 WHERE "NAME" = 'caching';
  > ```
  >
  > Do this *after* the new srv is live — resetting while the old (`metrics.enabled:true`)
  > code is still running would let its boot re-persist `1`.


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
    // srv nodejs task — the cds-caching models are appended to its `model` list
    // so the four cds_caching entities bake INTO srv/csn.json (see the CF-boot
    // resolve-guard section below — this is load-bearing, not cosmetic):
    { "for": "nodejs", "src": "srv", "dest": "srv",
      "options": { "model": ["srv", "db", "app", "@cap-js/data-inspector",
                             "cds-caching/db/cache-store", "cds-caching/db/statistics"] } },
    // …existing db-qa / srv-qa tasks…
    { "for": "cds-caching" },                                             // → CacheStore.hdbtable
    { "for": "hana", "src": "db", "dest": "db",
      "options": { "model": ["cds-caching/db/statistics"] } }            // → Caches / Metrics / KeyMetrics
  ]
}
```

- `{ "for": "cds-caching" }` is the plugin's own build task. It emits
  `plugin.cds_caching.CacheStore.hdbtable` into `gen/db/src/gen/` (only when
  `store: "cds"` + a HANA DB, so the base/sqlite profile skips it).
- The `db`-dest statistics task compiles **only** the plugin's `statistics` model into
  the main `db` container, emitting the three metrics tables. It must NOT list `db` in
  its model — passing `options.model` to a `db`-dest task overrides cds's default model
  resolution and would drop all ~247 service `.hdbview` artifacts (verified: 535 → 288
  files). A `statistics`-only model is additive and safe (535 → 539 with the CacheStore
  + 3 metrics tables).
- **The srv nodejs task also lists `cds-caching/db/cache-store` +
  `cds-caching/db/statistics` in its `model`.** This is the #1182 half of the fix: it
  bakes all four `plugin.cds_caching.*` entities into `srv/csn.json` (619 → 623 defs,
  zero views dropped) so `KeyvCDS` finds `plugin.cds_caching.CacheStore` in
  `cds.model.definitions` at runtime **without** the plugin's runtime `env.roots` push.
  See the resolve-guard section below.
- **QA container is intentionally untouched.** `tutorials-srv-qa` does not wire the
  caching service (its `cds.requires` is `db` + `auth` only) and never imports the
  cache module, so `tutorials-hana-qa` gets **no** `cds_caching` tables — verified in
  the production build (`gen/db-qa` has zero `plugin.cds_caching.*` artifacts).

No `srv/lib/` transitive deps changed by the store config itself, so the MTA
`srv-qa` `cp` list needs no edit — `kg-neighborhood-cache.js` is already listed, and
srv-qa never wires caching. (The #1182 fix module `srv/lib/strip-precompiled-plugin-roots.js`
is imported only by `srv/server.js`, not by `srv-qa/server.js`, so it is likewise not
in the srv-qa `cp` list.)

## CF boot: the resolve-guard crash (#1179 revert) + #1182 fix

**Symptom.** The first `tutorials-srv` deploy carrying `store: "cds"` (#1179,
commit cf14f8ed) crash-looped on CF (`0/1`) at boot with `ERR_CDS_COMPILATION_FAILURE`
— a cascade of `Duplicate definition of artifact` errors: `sap.changelog.*`
(@cap-js/change-tracking), then `DataInspectorService`, then `cds.outbox.Messages`.
#1179 was reverted to `store: "memory"` in PR #1207 to stop the outage.

**Root cause.** cds-serve resolves the model on CF via `@sap/cds/lib/compile/resolve.js`:

```js
const files = resolve.many(env.roots)                                  // ← the roots
const is_csn_json = files.length === 1 && files[0].endsWith('csn.json')
if (!is_csn_json) files.push(...resolve.many(_required(env)))          // ← re-merge!
```

The `cds-caching` plugin (`cds-plugin.js`) pushes `<plugin>/db/cache-store` and
`<plugin>/db/statistics` into `cds.env.roots` **at plugin-load time**, whenever the
active profile has `store: "cds"` and/or `metrics.enabled`. On CF that makes
`resolve.many(env.roots)` return **three** files (`srv/csn.json` + the two plugin
`.cds`), so `is_csn_json` is `false` and cds-serve re-compiles **every**
`requires[].model` (@cap-js/change-tracking, @cap-js/data-inspector,
`@sap/cds/srv/outbox`, @cap-js/ai, @cap-js/ord) **on top of** the already-complete
precompiled `srv/csn.json` — which already contains those defs → duplicate-definition
crash. Under `store: "memory"` the plugin pushes nothing, so `resolve.many` returns just
`[srv/csn.json]`, the guard holds, and boot is clean. (This is CF-runtime-specific but
**is reproducible locally** — see below.)

**Fix (#1182), two halves — both required:**

1. **Bake the entities into `srv/csn.json`** (build task, above): add
   `cds-caching/db/cache-store` + `cds-caching/db/statistics` to the srv nodejs task's
   `model`. Now `KeyvCDS._resolveEntity()` finds `plugin.cds_caching.CacheStore` in
   `cds.model.definitions` at runtime without needing the plugin's root-push.
2. **Strip the plugin-injected roots at runtime** when a precompiled csn is present:
   [srv/lib/strip-precompiled-plugin-roots.js](../../../srv/lib/strip-precompiled-plugin-roots.js),
   called at the top of `srv/server.js`. server.js is evaluated by cds-serve **after**
   `await cds.plugins` (roots already pushed) but **before** model resolution, so
   removing the two `<plugin>/db/*` entries from `cds.env.roots` there restores
   `resolve.many(env.roots) === [srv/csn.json]` and the guard holds.

The strip is gated on `fs.existsSync(<cds.root>/srv/csn.json)`:

| Context | `cds.root` | `srv/csn.json`? | Behavior |
|---|---|---|---|
| CF production | `gen/srv` | present | strip → guard holds; entities from baked csn |
| Hybrid `cds watch` | project root | absent | **no strip** → roots kept so model compiles from source |
| Dev / unit | project root | absent | `store: "memory"` → plugin pushes nothing → no-op |

Baking alone is **not** sufficient (the plugin still pushes the roots → guard still
breaks); stripping alone is **not** sufficient (runtime can't find `CacheStore`). Both
halves are load-bearing. Verified by an end-to-end CF-boot simulation from `gen/srv`
(guard holds, model compiles to 623 defs with `CacheStore` present) plus a negative
control (baked csn, no strip → still crashes) — see the PR for #1182.

**Local reproduction** (the #1179 revert note said this was not locally reproducible;
it is, with the right setup — run from the precompiled `gen/srv`, not the source tree):

```bash
cds build --production                     # bake csn with store:cds config
cd gen/srv
CDS_ENV=production node -e '
  const cds = require("@sap/cds");
  const resolve = require("@sap/cds/lib/compile/resolve");
  const path = require("path");
  const pd = path.dirname(require.resolve("cds-caching/package.json"));
  cds.env.roots.push(path.join(pd,"db","cache-store"), path.join(pd,"db","statistics"));
  const files = resolve.many(cds.env.roots, resolve.options({env:cds.env})) || [];
  console.log("files:", files.length, "guard holds:", files.length===1);  // → 3, false (crash)
'
```

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

## `@cache` annotation pilot — PublishedConceptsWithAliases (#1182)

First declarative `@cache` on a read surface. Annotates
`KnowledgeGraphService.PublishedConceptsWithAliases` (the anonymous ⌘K
command-palette concept search): `@cache: { ttl: 300000, tags: [{ value:
'kg-published-concepts' }] }`.

- **Auth-safe:** service is `@requires:'any'`, rows are not user-scoped, and the
  caching default key is `{hash}`-only (`isUserAware:false`) — the hash includes
  the full `$search`/`$top`/`$select` query, so different searches get different
  keys and no data crosses users.
- **Invalidation:** `srv/lib/kg-published-concepts-cache.js`
  (`bustPublishedConceptsCache()`, fail-open) is called from the existing KG
  `after`-write handlers in `srv/server.js` — `Concepts` CRUD and the
  `publishConcept`/`unpublishConcept` actions (which flip `publishedAt`, the
  projection's filter). TTL (5 min) is the backstop. `invalidateOnWrite` is NOT
  used — publish state changes via base-`Concepts` actions the plugin auto-hook
  wouldn't catch.
- **Scope:** only the service-layer (OData/HCQL/MCP) read is cached. The
  rebuild-time full-list read in `srv/lib/published-concepts-query.js` uses raw
  `db.run` and is intentionally not cached.
- **Metrics:** persistence is **disabled** (`metrics.enabled` removed from both
  profiles, #1215) — do NOT rely on the metrics tables for hit-rate:
  - It was on originally, but the counters never worked on HANA: the plugin's
    stats-accumulation reads the existing hourly row via a flattened table-name
    SELECT that returns UPPERCASE column keys (`HITS` not `hits`), so
    `existingHourly.hits + stats.hits` is `undefined + n = NaN` → the
    [`metrics.enabled` "Wrong input for INT type"](cds-caching-metrics-int-type-error-on-hana.md)
    hdb bind error fired every flush. `PLUGIN_CDS_CACHING_METRICS` accumulated
    22 hourly rows with every counter stuck at `0`; `PLUGIN_CDS_CACHING_KEYMETRICS`
    was empty (per-key metrics were never wired). Disabling stops the error-level
    log noise and loses nothing that worked.
  - **Measure directly instead:** hit-vs-miss latency by repeating a request,
    and confirm a declarative entry lands in the store (opaque `kg:<hash>` key,
    ~5-min TTL):

    ```sql
    SELECT "ID", LENGTH("VALUE") AS VAL_LEN, "EXPIRESAT"
      FROM "PLUGIN_CDS_CACHING_CACHESTORE"
      WHERE "ID" LIKE 'kg:%'
        AND "ID" NOT LIKE 'kg:default%' AND "ID" NOT LIKE 'kg:full%'
        AND "ID" NOT LIKE 'kg:pat:%'    AND "ID" NOT LIKE 'kg:rss:%'
        AND "ID" NOT LIKE 'kg:yt:%';
    ```


### Decision record

- **Status:** DEV-only pilot, deployed 2026-07-15 (srv last uploaded 22:03 CEST
  / 20:04 UTC, carrying PR #1213 merged 16:22 UTC).
- **Measured behaviour (2026-07-16, direct probe against deployed srv):** the
  persisted metrics tables were unusable (see Metrics above — KEYMETRICS empty,
  METRICS counters stuck at 0 across all 22 hourly snapshots since deploy), so
  the pilot was verified by driving the endpoint directly. Repeated
  `GET /graph/PublishedConceptsWithAliases?$top=3&$select=slug,name` returned
  **276 ms cold (miss) → ~110 ms warm (hit)**, a ~60% latency reduction, and a
  new `kg:<hash>` row (537 B, EXPIRESAT ≈ now + 300 s) appeared in
  `PLUGIN_CDS_CACHING_CACHESTORE` — confirming the `{hash}` cache key, the
  `ttl: 300000` backstop, and CDS-DB store persistence all work end-to-end. No
  organic DEV traffic hit this surface during the soak window (store held only
  the #1177 `kg:neighborhood`/RSS/YT/PAT programmatic entries until the probe),
  so a *natural* hit rate could not be observed.
- **Verdict: HOLD.** The mechanism is proven correct (cache hits, correct TTL,
  auth-safe key, working invalidation path), so there is no reason to revert.
  But do **not expand** to more surfaces yet, for two reasons: (1) we cannot
  measure hit rate until the HANA metrics-counter bug is fixed or per-key
  metrics are enabled — expanding blind risks stale-content regressions with no
  observability; (2) this surface saw zero organic DEV traffic, so its own value
  is unproven. Re-evaluate expansion once (a) the metrics INT-type bug is
  resolved (upstream cds-caching or a config workaround) and (b) PROD traffic
  gives a real hit-rate baseline post-cutover.
