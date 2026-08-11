# Design: Workstream B — serve remaining Hugo content pages from HANA/CAP

**Date:** 2026-08-11
**Status:** spec — for review
**Issue:** [#1659](https://github.com/sap-tutorials/tutorials-ims/issues/1659)
**Related:** parent spec [2026-08-11-approuter-content-serving-and-asset-retention-design.md](./2026-08-11-approuter-content-serving-and-asset-retention-design.md) (#1645) · design/options [approuter-static-serving.md](../../developers/architecture/approuter-static-serving.md) (#1642) · Workstream A shipped #1658 · concepts→CAP precedent #1327 · rebuild manifest fix #1628 · island guard #1641 · [cdn-caching.md](../../developers/architecture/cdn-caching.md)

## Summary

Eliminate the multi-instance-divergence + runtime-static-clobber failure class (root of the 2026-08-10/11 PROD incidents) by removing the approuter's mutable, per-instance `static/` tree as the source of truth for the remaining Hugo **content pages**. Those pages move to dynamic CAP serving from one HANA source — the proven #1327 `/concepts/` pattern — and the `POST /admin/rebuild` static-page push (plus `deploy-self-heal`'s auto-rebuild that exists only to refresh it) is retired.

**Pages in scope:** homepage `/`, `/browse/`, `/topics/`, `/devtoberfest/`, `/tutorial-navigator/`, `/developer-advocates/`, verb/landing pages, and sitemaps (`sitemap.xml`, `index.xml`, `llms-full.txt`). Tutorials and concepts are already served this way.

**Invariant assets stay on the droplet** (`js/`, `css/`, `images/`, `vendor/`, `admin-ui/`, `analytics-ui/`, `scanner-ui/`) — shipped by MTA deploy only.

### The pivotal framing (differs from the parent spec's wording)

The parent spec says "mirror `renderConceptsHandler`." Concepts are **server-rendered from the DB at publish time** (EJS → `composeShell` → BLOB) because there are ~4,394 of them and they are DB-driven. The in-scope pages are **Hugo-built HTML** — mechanically identical to how tutorial pages already work: a static-per-build SSR shell whose volatile regions hydrate at runtime via island scripts hitting `/build/*` and `/homepage/*`.

**Therefore pages are published and served exactly like tutorials — Hugo-built HTML BLOBs pushed through the existing `begin/append/commit` delta path and served by the existing `serveHandler` — under a new `page:` key namespace.** No concept-style EJS render, no new `/content/publish/render-*` route, and no on-demand render (the concepts-**index** on-demand pattern in `concept-list-page.js` is *not* used: these pages carry no live-DB body that a republish wouldn't already refresh). This de-risks Phase 1 to "reuse the tutorial pipeline with a different key."

### Why this satisfies "change on demand, see updates fast, no perf loss"

- **On-demand change:** a single page re-publishes via the existing single-slug delta path (~2 min, no full rebuild).
- **Fast, fleet-wide, restart-durable propagation:** `commit` flips the `ContentManifest` + bumps the shared `content-cache-generation`; every approuter instance drops its local cache on next read and serves the new BLOB from the one HANA source. Strictly better than today's `/admin/rebuild`, which reaches one instance and reverts on `cf restart`.
- **Serve stays fast:** 50 MB LRU + long `s-maxage`; volatile regions (homepage shelves, featured topics, events, alerts) already hydrate live at runtime and stay instant.
- **Edge freshness on-demand:** wire the already-designed publish-time **purge-by-tag** (Fast-Purge) so an edge-visible update lands in seconds instead of at the 24h `s-maxage` ceiling — while keeping the long `s-maxage` for performance between publishes.

### Goals

- No runtime mutation of approuter static for content pages → all instances serve identical content from one HANA source.
- Per-page publish visible fleet-wide within the publish window (~2 min) and at the edge within seconds (purge-by-tag).
- Serve latency unchanged (LRU + edge cache; live regions still island-hydrated).

### Non-goals

- Moving invariant assets off the droplet (they ship via MTA deploy — parent-spec non-goal, unchanged).
- Workstream A asset-hash retention (shipped in #1658; this spec depends on it but does not re-do it).
- Reworking the concepts detail/index serving (already done in #1327; only extended, not changed).

## Key decisions (resolved)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Scope of this issue | **All three phases**, landed as **separate PRs** (dark-launch, per-route flips, retirements) | Rollback safety per phase; mirrors #1327 tasks 1→5. |
| 2 | Page store schema | **Reuse `ContentFiles`/`ContentManifest`** with a `page:` key namespace | Zero migration; identical to how concepts (`concept-<slug>`) and tutorials (bare slug) already coexist in these tables. |
| 3 | Page render model | **Hugo-built HTML BLOBs** (like tutorials), not server-rendered | Source is Hugo markdown/data; live regions hydrate at runtime. On-demand render would add per-request cost for zero freshness gain. |
| 4 | Sitemaps | **Serve from HANA** like pages (`mimeType` per row) | A content-only publish then refreshes them without a deploy; consistent with "one HANA source." |
| 5 | QA channel | **Build QA page channel too** (via the existing `srv-qa` app + `/…-qa/` paths) | Requested. Biggest scope-adder; see "QA channel" and Risks. |
| 6 | Edge purge | **Wire purge-by-tag on publish now** (checklist step 6 of `cdn-caching.md`) | The only lever that makes edge-visible updates instant; headers already emitted, only the Fast-Purge call is missing. |
| 7 | HTML↔asset invariant (Phase 3) | Content rebuilds **stop building JS/CSS** and bake the **currently-deployed** `island_manifest` read from **HANA** | Prevents the #1628 bare-`/js/name.js` fallback once asset builds are removed; keeps "one HANA source." |

## Architecture

### Page store (schema — decision 2)

Reuse `ContentFiles` (`slug`, `version`, gzip `content` BLOB, `contentHash`, `mimeType`, sizes, `sourceContent`/`sourceHash`) and `ContentManifest` (versioned, `status='ACTIVE'`). Pages are rows keyed in a new namespace so they coexist with tutorial (bare slug) and concept (`concept-<slug>`) rows and inherit carry-forward, versioning, and delta publish.

**Key scheme (`page:` namespace).** A deterministic, bijective map between the public route and the stored key, owned by one small module (`srv/lib/page-key-map.js`, new) shared by the serve path and the publish script:

| Public route | Store key | `mimeType` |
|---|---|---|
| `/` | `page:index` | `text/html` |
| `/browse/` | `page:browse` | `text/html` |
| `/topics/` | `page:topics` | `text/html` |
| `/tutorial-navigator/` | `page:tutorial-navigator` | `text/html` |
| `/developer-advocates/` | `page:developer-advocates` | `text/html` |
| `/devtoberfest/` | `page:devtoberfest` | `text/html` |
| verb/landing `/<name>/` | `page:<name>` | `text/html` |
| `/sitemap.xml` | `page:sitemap.xml` | `application/xml` |
| `/index.xml` | `page:index.xml` | `application/xml` |
| `/llms-full.txt` | `page:llms-full.txt` | `text/plain` |

Path segments are flattened (slashes → the key form) and lowercased; the map validates against a fixed allow-list of in-scope routes so an arbitrary path can never mint a page key. `serveHandler`'s existing `VALID_SLUG` check is extended (or bypassed for the `page:` branch via the map, which is itself the validator).

### Serve path

A thin `pageServeHandler` (in `srv/lib/content-store.js` or a small sibling) mounted at **`/content/pages/*`**:

1. Map the inbound path → `page:` key via `page-key-map.js`; unknown path → `404` (fail-open, `max-age=60`).
2. Delegate to the existing `serveHandler` ContentFiles branch (raw-SQL BLOB read on HANA, gunzip, LRU cache, `content-cache-generation` coherence, `ETag`/`304`).
3. Emit edge headers via `setContentCacheHeaders` with the extended tag set (below).

**Caching (align to reality — corrects the parent spec's "cds-caching deleteByTag" wording).** The serve path uses the 50 MB LRU `ContentCache` + the shared `content-cache-generation` token (`content-cache-coherence.js`) for cross-instance coherence, and `edge-cache-headers.js` for `Cache-Control`/`Vary`/`Edge-Cache-Tag`. A publish already bumps the generation via `commitHandler` → `cache.invalidate()`. Extend `cacheTagsFor(slug)` so page slugs emit `content, page, page-<name>` (sitemaps: `content, page, sitemaps`).

**Fail-open (mandatory, especially `/`).** `pageServeHandler` wraps the lookup in try/catch and serves, in order:
1. last-good decompressed buffer from the LRU (if present),
2. a small **deploy-baked fallback snapshot** of the in-scope pages shipped inside `srv` (HTML only; regenerated at build),
3. `503` with `max-age=60` — never a naked `500`.

The baked fallback for `/` is a release gate: a cold cache or HANA hiccup on the homepage must not be an outage.

### Publish path

`scripts/publish-content.ts` gains page discovery alongside tutorial discovery:
- Discover the in-scope Hugo output files under `hugo/public/` (homepage `index.html`, `browse/index.html`, `topics/index.html`, `tutorial-navigator/index.html`, `developer-advocates/index.html`, `devtoberfest/index.html`, verb/landing pages, `sitemap.xml`, `index.xml`, `llms-full.txt`).
- Map each file → `page:` key via `page-key-map.js`; hash, delta against `/content/hashes`, and `appendBatch` into the **same** open session as tutorials (no new route). Runs for both prod and QA channels.
- No render phase; no `__shell__` composition (pages are already complete documents from Hugo).

### Edge purge on publish (decision 6)

Implement checklist step 6 of `cdn-caching.md`: a fire-and-forget Fast-Purge in `commitHandler` (after `cache.invalidate()`, ~content-store.js:1609) and `rollbackHandler` (~:1452), keyed off `commitSession`'s `freshSlugs`, mapping each fresh slug to its `Edge-Cache-Tag` (`item-<slug>` for tutorials/concepts; `page-<name>` for pages). Fail-open and off the critical path (model on the existing `void alerting.raise(...)` fire-and-forget). A CDN outage must never fail a commit; on purge failure the edge simply falls back to today's `s-maxage` behavior — no regression.

New: a `srv/lib/cdn-purge.js` module encapsulating the Fast-Purge client, credentials from the Credential Store (never hardcoded), and a no-op when creds are absent (local/dev). See Prerequisites.

### QA channel (decision 5)

QA is **not host-based** — it is the separate `srv-qa` CAP app (namespace `com.sap.developers.ims.qa`, container `tutorials-hana-qa`, key `CONTENT_API_KEY_QA`, `skipMetadataUpsert:true`) reached via approuter `/…-qa/` paths → `srv-qa-api`. To give pages a QA channel:
- Register `pageServeHandler` (and the `page-key-map`) on `srv-qa/server.js`, mounted at the QA content path.
- `publish-content.ts` publishes pages into the QA namespace on the QA channel run (it already runs per-channel).
- Add approuter routes `^/…-qa/…$` for the migrated pages → `srv-qa-api` (scope `Tutorial.Author`), mirroring the `/tutorials-qa/*` routes.

This is the largest scope-adder and QA pages have no author-preview workflow today (unlike QA tutorials). It is the first candidate to cut if scope pressure arises; flagged for the spec review.

### The HTML↔asset invariant (Phase 3, decision 7)

Once content rebuilds stop building JS/CSS, Hugo must still bake the **currently-deployed** hashed island paths — otherwise `island-src.html` falls back to bare `/js/<name>.js` (the #1628 outage). Mechanism:
- **At deploy time**, persist `island_manifest.json` to HANA (a tiny JSON row in a dedicated single-row entity, e.g. `DeployedIslandManifest`, or a reserved `ContentFiles` key `page:__island_manifest__`).
- **In `rebuild-content.yml`**, replace the island/vendor/manifest build steps with a step that reads the deployed manifest from HANA and writes it to `hugo/data/island_manifest.json` before the Hugo build, so Hugo bakes deployed hashes.
- Combined with Workstream A's asset retention (#1658), the HTML↔asset window is closed on both sides: content HTML references only hashes that exist on the droplet, and the droplet retains recent hashes across deploys.

## Phased delivery (separate PRs)

### Phase 1 — page store + serve + publish, dark-launched (additive; PR 1)
1. `srv/lib/page-key-map.js` — route↔key map + allow-list validator (unit-tested bijection).
2. `pageServeHandler` at `/content/pages/*` (delegates to `serveHandler`), fail-open ladder, baked-fallback snapshot build step for `srv`.
3. Extend `cacheTagsFor` with `page`/`page-<name>`/`sitemaps` tags.
4. `publish-content.ts` page discovery + delta append (prod + QA).
5. Register the route on `srv` **and** `srv-qa`. **No approuter route flips.** Dark launch: pages are reachable at internal `/content/pages/...` only.
6. Tests: unit (map, handler-from-fixture, fail-open), hybrid (publish→serve round-trip per kind incl. sitemap mimetype).

### Phase 2 — flip approuter routes, homepage last (PR(s) 2..n)
1. Insert explicit `srv-api` routes (path → `/content/pages/...`) **before** the `^(.*)$` catch-all, one page at a time; `/devtoberfest/` replaces its current explicit static route.
2. Add the `/…-qa/` page routes → `srv-qa-api` (scope `Tutorial.Author`).
3. Flip `^/$` (homepage) **last**, after caching + fail-open are proven under load on the lower-traffic pages.
4. Keep the static bake of these pages until each route flips (rollback = revert the flip → catch-all serves the still-baked droplet copy).
5. Smoke per flipped route: 200 + expected page markers + **hashed** (not bare) island refs. E2E: homepage from CAP mounts its islands.

### Phase 3 — retirements + close the invariant (PR final)
1. Wire the deployed-`island_manifest`-to-HANA persistence + the `rebuild-content.yml` fetch step; **remove** the island/vendor/manifest build steps, the `Assemble static content` + `Create content tarball` + `Push content to AppRouter` steps.
2. Retire `POST /admin/rebuild` (`approuter/server.js` `rebuildHandler` + its mount).
3. Retire `deploy-self-heal.js`'s catalog-only dispatch (`srv/server.js` ~:1062) — its only purpose was refreshing ephemeral static.
4. The #1628 manifest step + #1641 guard on the push path become moot; remove with the push.
5. Verify: a content-only publish refreshes pages fleet-wide with correct deployed island hashes and no static push.

## Prerequisites / dependencies

- **Akamai Fast-Purge credentials + endpoint** (decision 6). CDN config is infra-owned (`aem-gap-analysis.md:105`); the purge *call* is ours, but it needs credentials provisioned in the Credential Store and the tag-purge API reachable from `srv`. Until provisioned, `cdn-purge.js` is a logged no-op — Phase 1/2 do not block on it, but the "edge updates in seconds" goal is unmet until it lands. **Named blocker to raise with infra.**
- **Workstream A (#1658)** shipped — asset-hash retention is assumed present for the Phase 3 invariant.

## Testing

- **Unit:** `page-key-map` bijection + allow-list rejection; `pageServeHandler` serves from a `ContentFiles` fixture; fail-open ladder (LRU → baked snapshot → 503); `cdn-purge` tag mapping; extended `cacheTagsFor`.
- **Hybrid:** publish→serve round-trip vs real HANA for each page kind (HTML + sitemap mimetype); QA-namespace publish→serve via `srv-qa`.
- **Smoke (post-deploy):** each flipped route 200 + page markers + hashed island refs; after a slug-targeted publish, the edge serves the new `contentHash` within seconds (purge verification, `cdn-caching.md` step 7).
- **E2E:** homepage served from CAP mounts its islands (asset refs resolve).

## Risks & rollback

- **Homepage HANA load** — mitigated by LRU + long `s-maxage` + fail-open; flip `/` last.
- **QA-pages scope** — largest add, no existing author-preview need; cut first if scope bites (decision 5).
- **Fail-open correctness** — the baked `/` fallback must always be present in `srv`; gated by a build check.
- **Purge infra dependency** — edge freshness goal blocked on Akamai creds; degrades gracefully to `s-maxage` (no regression) until wired.
- **Phase 3 invariant** — if the deployed-manifest fetch fails, the rebuild must fail loudly (not fall back to bare `/js/` paths); guard mirrors #1641.
- **Rollback** — every phase is additive/revertable: Phase 1 dark-launch is invisible; Phase 2 route flips revert to baked static; Phase 3 retirements are the only irreversible-ish step and land only after all flips are proven in PROD.

## Open questions

None blocking. Two implementation-detail choices deferred to the plan:
1. Deployed-manifest storage: dedicated `DeployedIslandManifest` single-row entity vs. a reserved `ContentFiles` key. (Recommend a dedicated tiny entity for clarity.)
2. Baked fallback snapshot: which exact page set to bundle into `srv` for fail-open (at minimum `/`; likely all in-scope HTML pages, excluding sitemaps).
