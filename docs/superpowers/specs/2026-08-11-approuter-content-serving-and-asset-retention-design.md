# Design: HANA/CAP content-page serving + asset-hash retention

**Date:** 2026-08-11
**Status:** spec — for review
**Related:** #1604 (JS island content-hashing), #1628 (rebuild manifest fix), #1641 (rebuild island guard), #1327 (`/concepts/` → CAP), [approuter-static-serving.md](../../developers/architecture/approuter-static-serving.md) (option analysis), [build.md](../../developers/architecture/build.md)

## Summary

Eliminate the two failure classes exposed by the 2026-08-10/11 PROD incidents by removing the approuter's mutable, per-instance static tree as the source of truth for *content*, and by making content-hashed *assets* survive across deploys.

Two decoupled workstreams:

- **A — Asset-hash retention (ship first, standalone).** Retain prior content-hashed JS/CSS bundles across deploys for at least the HTML edge-cache TTL, so edge-cached HTML never references a deleted hash. Fixes the *stale-HTML → deleted-hash → 404* class that currently affects live tutorial/concept pages (islands 404 for up to the ~24h Akamai TTL after any bundle-hash change).
- **B — Serve all content pages from HANA/CAP.** Migrate the remaining Hugo-generated pages (homepage, browse, topics, devtoberfest, tutorial-navigator, developer-advocates, verb/landing pages, sitemaps) to dynamic CAP serving from HANA — the proven #1327 `/concepts/` pattern — and retire the `POST /admin/rebuild` static-page push. Fixes the *multi-instance divergence* + *runtime-static-clobber* class.

### Goals
- No runtime mutation of approuter static → all instances serve identical content from one HANA source.
- Edge-cached HTML always resolves the asset hashes it references.
- Content refresh stays fast (no full MTA deploy per tutorial/homepage edit).

### Non-goals
- Moving invariant assets (`js/`, `css/`, `images/`, `vendor/`, `admin-ui/`, `analytics-ui/`, `scanner-ui/`) off the droplet. They continue to ship via MTA deploy.
- QA-preview island correctness (deferred; not an outage vector).

## Background

The approuter serves a ~400 MB local `static/` tree (`vendor` 128M, `images` 59M, `js` 49M, HTML ~11M, etc.). Two mechanisms populate it: (1) the MTA droplet at deploy time; (2) `POST /admin/rebuild` (`approuter/server.js:373-374`) which gunzips an uploaded tarball and **atomically renames it over live `static/`** — mutating one instance's ephemeral disk. Tutorials and concepts (#1327) are already served dynamically from HANA via CAP and are **not** in the static tree.

Two 404 classes result:

1. **Runtime clobber / multi-instance divergence.** `/admin/rebuild` reaches only the one instance the CF router hits; other/autoscaled instances keep old static; a restart reverts to droplet. (The 2026-08-10/11 outage: a bad tarball with bare `/js/*.js` paths — root-caused/fixed in #1628, guarded in #1641 — plus this divergence.)
2. **Stale-HTML → deleted-hash.** #1604 content-hashes island bundles (`/js/validation-K8FRraal.js`) and ships only the current hashes. HTML is edge-cached (`s-maxage` up to ~24h). When a deploy changes a bundle hash and wipes the old file, any still-cached HTML referencing the old hash 404s for the cache-TTL window. Confirmed live on tutorial pages (`validation.js`, `navigator.js`, etc.).

## Workstream A — Asset-hash retention (ship first)

### Problem
Content-hashed filenames are immutable, but each build produces a fresh set and the deploy replaces the droplet, deleting prior hashes. Edge-cached HTML outlives the deploy and references now-missing hashes → 404 until the HTML cache expires.

### Approach
Make each new droplet's `static/js` + `static/css` a **union of the current build's bundles and the bundles from recent prior deploys**, bounded by a retention window ≥ the maximum HTML edge-cache TTL.

- **Retention window:** ≥ `max(s-maxage)` across HTML responses. Current tutorial/concept `s-maxage` is ~86400 (24h); retain **≥ 48h** of prior bundles to cover overlapping deploys and clock skew.
- **Source of prior bundles:** a persisted **recent-bundles manifest** (filenames + first-seen timestamp) stored in HANA (small — names only). At deploy build time, after `npm run postbuild:apps` produces the new hashed bundles, the build:
  1. Reads the recent-bundles manifest.
  2. Downloads any listed bundle not present in the new build (from the currently-deployed approuter, which still serves them) into `hugo/static/js` / `static/css`.
  3. Writes the union back to the manifest, pruning entries whose first-seen is older than the retention window **and** not referenced by the current build.
- **Injection point:** between `postbuild:apps` (deploy.yml `:231`) / the mta before-all hugo-apps build, and the Hugo build that copies `static/js` into `public`. Same slot in `rebuild-content.yml` is unaffected (Workstream B removes asset builds from content rebuilds).
- **Immutability guarantee:** unioning is always safe — a given hashed filename maps to identical bytes forever.

### Alternative considered
Serve `/js` + `/css` from a shared store (HANA BLOB or object store) with accumulation + prune, so old hashes persist and all instances converge on assets too. Rejected as primary: adds per-request origin cost for 49 MB of JS and new storage; carry-forward keeps assets fast on the droplet + CDN. Revisit if deploy-time carry-forward proves operationally awkward.

### Testing (A)
- Unit: manifest union/prune logic (window boundary, referenced-but-old kept, unreferenced-and-old pruned).
- Integration: build N+1 after N leaves N's hashes present in the droplet.
- Smoke (post-deploy): the previous deploy's referenced island hashes still 200.

## Workstream B — Serve all content pages from HANA/CAP

### Page inventory (moves to HANA/CAP)
Homepage `/`, `/browse/`, `/topics/`, `/devtoberfest/`, `/tutorial-navigator/`, `/developer-advocates/`, verb/landing pages, `sitemap.xml` / `index.xml` / `llms-full.txt`. (Tutorials + concepts already done.)

### Serving model
Generalize the content-store from "tutorials + concepts" to a **generic page store** keyed by path. Add a CAP handler that serves a published page's SSR HTML from HANA (mirroring `renderConceptsHandler` / the tutorial content route), host-aware for prod vs QA channel. Flip the corresponding approuter routes from `localDir: static` to `destination: srv-api` (the #1327 Task 5 flip). Invariant assets keep their `localDir: static` routes.

### The load-bearing invariant: HTML ↔ asset-hash sync
Published pages reference content-hashed island bundles that live on the droplet. Therefore:
- The content rebuild renders pages against the **currently-deployed** `island_manifest` (the hashes actually on the droplet), never a locally-regenerated one.
- Content rebuilds **stop building JS/CSS** — assets change only via deploy. This removes the content-rebuild hash-churn entirely; combined with Workstream A retention, the HTML↔asset window is closed on both sides.

### Caching
Serve pages with the concepts cache posture: `Cache-Control` `s-maxage` for the edge + `max-age` for the browser, `cds-caching` in front of HANA, and a `deleteByTag` bust on publish. The homepage is the highest-traffic path — caching must be verified before its route flips.

### Fail-open
The CAP page handler must fail-open: on HANA error / cache miss storm, serve a minimal baked fallback (or the last-good cached copy) rather than 500. A cold-cache or HANA hiccup on `/` would otherwise be a homepage outage.

### Retirements
- **`POST /admin/rebuild`** static-page push: removed (handler gated off / deleted).
- **`rebuild-content.yml`**: drop the Assemble-static + tarball-push steps and the JS/CSS build steps; publish pages to HANA instead. The #1628 manifest step + #1641 guard become moot on the retired path (keep them until the push is fully removed).
- **`deploy-self-heal.js`**: retire the auto `catalog-only` rebuild (it exists only to refresh ephemeral static).

### Migration / rollout
Dark-launch per the #1327 sequence: CAP serves each page at an internal path first (no approuter route), verify SSR + hashed asset refs + cache headers, then flip the approuter route in a later step. Flip highest-traffic (`/`) last, after caching is proven. Keep the static bake of these pages until their routes are flipped (rollback safety).

### Rollback
Revert a route flip → approuter falls back to the still-baked droplet static for that page. Fully additive until the retirements land.

### Testing (B)
- Unit: page handler renders from a HANA fixture; host→channel routing.
- Hybrid: publish→serve round-trip against real HANA per page type.
- Smoke: each flipped route returns 200 + expected page markers + hashed (not bare) island refs.
- E2E: homepage served from CAP mounts its islands (asset refs resolve).

## Risks
- **Homepage HANA load** — mitigated by caching + fail-open; flip last.
- **HTML↔asset skew during a deploy** — closed by A (retention) + B (no content-rebuild asset churn).
- **Route-flip regressions** — dark-launch + per-route flip + revertable.
- **Retention manifest drift** — prune must never drop a hash referenced by the current build; unit-tested.

## Open questions (resolve in the plan)
1. Exact source for prior-bundle download at build time: live approuter fetch vs. an artifact store. (Recommended: fetch from the currently-deployed approuter, gated by the persisted manifest.)
2. Generic page store schema — reuse the tutorial/concept content-store tables with a `kind='page'` discriminator, or a dedicated `Pages` entity.
3. Sitemap/`index.xml`/`llms-full.txt`: serve from HANA like pages, or keep as deploy-time static (they're generated, low-churn)?
