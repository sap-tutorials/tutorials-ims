# CDN / edge caching

> **Status:** origin + AppRouter changes **implemented** (this doc's §"The
> origin is CDN-shaped" and §"Static assets" describe live behavior); the
> **publish-time purge hook remains proposed** (§"Invalidation on publish").
> `developers.sap.com` is **confirmed** to already front with Akamai — the smoke
> suite (`test/smoke/security-headers.test.js`) asserts the edge applies a
> heuristic TTL to any 200 GET lacking an explicit `Cache-Control`, so the
> header work here takes effect against a real edge immediately. This is less
> "should we adopt a CDN" and more "what edge caching rules are safe for *this*
> origin, and how do we invalidate them on publish."

## Does a CDN even make sense for a data-driven site?

Yes — but not for the reason the "everything comes from HANA" framing suggests.
What decides CDN value is **how many users get the identical response and how
often it changes**, not *where the origin reads the bytes from*. "Dynamic
origin" ≠ "uncacheable response."

Tutorial HTML is served as gzip BLOBs out of HANA rather than static files (see
[build.md](build.md) — there is deliberately **no static file fallback**), but
functionally it is **static-per-publish**: every anonymous visitor gets
byte-identical HTML for a given slug, and it only changes when a publish flips
the `ContentManifest`. That is the textbook edge-cache profile.

Traffic splits cleanly, and the split maps almost 1:1 onto the AppRouter's
`authenticationType`:

| Traffic class | Cache at edge? | Notes |
|---|---|---|
| `/tutorials/*`, `/concepts/*`, missions/groups, homepage, catalog feeds | **Yes — high value** | Same for everyone; changes only on publish. Likely the bulk of read volume. |
| Static assets (Hugo CSS, Vue-island JS, images, fonts) | **Yes** | Classic CDN offload. See §"Static assets" — currently a modest 1 h TTL because assets are **not** fingerprinted. |
| Progress (`/homepage/personalized`), admin UI, Joule chat, gameboard-per-user, QA channel | **No — bypass** | Per-user / JWT-bearing. Caching these is a data-leak bug, not a perf win. |
| XSUAA login redirects / anything with `Set-Cookie` | **No — never cache** | Auth-flow correctness. |

The genuinely per-request database work (personalized progress, admin, chat) is
a minority of requests; the anonymous content that dominates a developer-docs
audience is effectively immutable between publishes. That is exactly the shape a
CDN rewards.

Even if read traffic were mostly authenticated, a CDN still earns its place for
**edge TLS termination, WAF / DDoS protection, origin shielding, and global POP
latency** — the audience is worldwide, the CF org is single-region
(`eu10-005`). Those benefits do not depend on cacheability at all.

## The origin is CDN-shaped

The content handler (`serveHandler` in `srv/lib/content-store.js`) and the
concepts-index handler (`srv/lib/concept-list-page.js`) emit CDN-tuned headers
via a shared helper, `srv/lib/edge-cache-headers.js` (`setContentCacheHeaders`),
applied to every cacheable 200 content response:

```js
// srv/lib/content-store.js — DB-served tutorial (~line 1073)
res.setHeader('ETag', `"${meta.contentHash}"`);   // SHA-256 of the HTML
setContentCacheHeaders(res, { slug });            // Cache-Control + Vary + Edge-Cache-Tag
res.setHeader('X-Content-Source', 'db');
```

`setContentCacheHeaders` sets three headers:

- **`Cache-Control: public, max-age=60, s-maxage=86400, stale-while-revalidate=600`**
  — a deliberately **split browser/edge TTL**:
  - `max-age=60` (browser) — a hard refresh picks up a new publish within a
    minute.
  - `s-maxage=86400` (shared edge) — the edge may hold content for a day,
    because a publish is expected to issue a **targeted purge-by-tag** (see
    §"Invalidation on publish"); without the purge this is the staleness ceiling.
  - `stale-while-revalidate=600` — the edge serves the stale copy instantly
    while revalidating in the background.
- **`Vary: Accept-Encoding`** — so the edge keys gzip/br/identity variants
  correctly (the concepts-index path serves pre-gzipped bytes with an explicit
  `Content-Encoding: gzip`).
- **`Edge-Cache-Tag`** — a per-response tag set for purge-by-tag (Akamai
  `Edge-Cache-Tag`; the equivalent Fastly header is `Surrogate-Key`). See
  §"Purge-by-tag scheme" below.

- **ETag = `contentHash`** (SHA-256 of the served HTML). The handler honors
  `If-None-Match` and returns `304` on a match, so a CDN gets cheap
  revalidation.
- **No `Last-Modified`** anywhere — ETag is the only validator (fine; don't rely
  on `Last-Modified` at the edge).
- **Unchanged, deliberately not run through the helper:** `serveNotFound` →
  `max-age=60`; 301 redirects → `max-age=3600`/`300` (~lines 841, 860, 1007);
  the `/content/nav` handler → `max-age=60`; the delta/drift probes
  (`/content/hashes`, `/content/source-hashes`) → `no-cache` (~lines 1105, 1173);
  the concepts-index stale error-fallback branch keeps `max-age=60`. These must
  not inherit the long shared-edge TTL.

## Purge-by-tag scheme

`cacheTagsFor(slug)` in `srv/lib/edge-cache-headers.js` builds the
`Edge-Cache-Tag` set so a publish can purge by tag instead of enumerating URLs.
Every cacheable content response carries the coarse `content` tag (enables a
full-corpus purge); slugs additionally get finer tags:

| Served slug | Edge-Cache-Tag value |
|---|---|
| tutorial `abap-basics` | `content, item-abap-basics` |
| group page `group-getting-started` | `content, group, item-group-getting-started` |
| mission page `mission-cap-intro` | `content, mission, item-mission-cap-intro` |
| concepts index (`concepts`) | `content, concepts-index` |
| concept detail `concept-oauth` | `content, concepts, concept-oauth` |

Slug tokens are sanitized to `[A-Za-z0-9_-]` and length-capped, so an exotic
slug can never produce a malformed header. The helper is **fail-open** — a
header-write fault warn-logs and never breaks content serving. When the
publish-time purge hook lands (§"Invalidation on publish"), it maps each fresh
slug to its `item-<slug>` tag and issues a Fast-Purge by tag.

So an edge keying on ETag + these headers is viable **today**. The one remaining
gap is **push invalidation on publish**: until the purge hook lands, worst-case
edge staleness after a publish is bounded by `s-maxage` (currently a day) rather
than seconds. That is the single change still outstanding that keeps a CDN from
being a regression relative to the "serve live from HANA to avoid staleness"
design intent — see the checklist.

## Cacheable allow-list (default-deny)

Given ~50 routes with mixed-auth siblings, the safe posture is **cache only the
allow-list below and bypass everything else** — never default-cache. Route
sources are from `approuter/xs-app.json`; see [runtime.md](runtime.md) and
[authentication.md](authentication.md) for the full routing/auth picture.

### ✅ Cache (all `authenticationType: none`, response identical for all users)

| Path pattern | AppRouter target | Suggested edge TTL |
|---|---|---|
| `/tutorials/*` | `srv → /content/tutorials/:slug` | long + purge-on-publish (has ETag) |
| `/concepts/` and `/concepts/*` | `srv → /content/concepts*` | long + purge-on-publish |
| `/tutorials/_nav.json` | `srv → /content/nav` | long + purge-on-publish |
| `/build/(catalog\|concepts\|homepage-shelves\|mission\|navigator\|repo-catalog\|slug-mapping\|tag-labels\|kg-stats\|co-completions\|breadcrumb-context)` | `srv → /build/*` | short (5–15 min) |
| `/homepage/*` **except** `/homepage/personalized` | `srv → /homepage/*` | short |
| `/api/advocates` | `srv` | short |
| `/api/devtoberfest/(status\|terms\|banner\|faq\|schedule\|transcript)` | `srv` | short |
| `/graph/(neighborhood(Full)?\|Concepts\|ConceptEdges\|TutorialConceptLinks\|pathBetween\|conceptsForUser\|explore-data\|path\|searchKG\|PublishedConcepts)` | `srv` (public KG read arm) | short |
| Hugo static assets (CSS/JS/img/fonts) | dedicated `cacheControl` asset route → `localDir: static` | 1 h (see §"Static assets") |

### Static assets

`approuter/xs-app.json` carries an explicit static-asset route **ahead of the
`^(.*)$` catch-all**:

```json
{
  "source": "^/((?:css|js|img|fonts|vendor)/.*)$",
  "target": "/$1",
  "localDir": "static",
  "authenticationType": "none",
  "cacheControl": "public, max-age=3600"
}
```

`cacheControl` is an AppRouter route property that **only applies to
`localDir`-served static resources** — it cannot be set on `destination`-backed
routes (that is why the content TTLs are set at the CAP origin, not here).

The TTL is a **deliberately modest 1 hour**, not `immutable`/1-year, because the
Hugo assets are **only partially** content-fingerprinted. The page-referenced
stylesheets (`sap-fundamental.css`, `joule.css`, and the #1601/#1603 set) now emit
content-hashed URLs (dual-emitted alongside a bare copy for static/runtime
consumers — see #1605), but many JS islands (`/js/joule.js`, etc.) and the
theme-var CSS still reference stable paths (some carry a `?v=` query, many do not).
A long/immutable TTL would strand a stale un-fingerprinted asset across a redeploy.
Raising this to `immutable` + a 1-year TTL is gated on fingerprinting the remaining
`/js/*` assets; until then 1 h keeps redeploys safe while still offloading the bulk
of asset requests.

### ⛔ Never cache — explicit bypass

- **Everything `authenticationType: xsuaa`:** `/admin/*`, `/admin-ui/*`,
  `/author/*`, `/analytics-ui/*`, `/data-inspector-ui/*`, `/display*`,
  `/scanner*`, `/pats/*`, `/tutorials-qa/*`, `/qa-search/*`, `/api/v1/*`,
  `/graphql` (non-`/graphql/public`), `/mcp-auth`, `/mcp-admin`, `/a2a`,
  `/_dev/*`.
- **Deceptive `none`-at-router-but-personalized (easy to miss — they sit next to
  cacheable siblings):**
  - `/homepage/personalized` — personalized shelf; bypass even though
    `/homepage/*` is cacheable.
  - `/api/devtoberfest/(join\|me\|my-completions)` — per-user; bypass even though
    sibling `/api/devtoberfest/(status\|…)` is cacheable.
  - `/gameboard/getMyGameboard` — per-user JWT read; bypass even though the
    generic `/gameboard/*` arm is `none`.
- **Auth flow / sessions:** `/login*`, `/logout`, `/login/callback`, anything
  emitting `Set-Cookie`.
- **Real-time / streaming:** `/socket.io/*`, `/ws/*` (WebSocket upgrade),
  `/chat/*` (Joule — per-user + streamed).
- **Mutating / freshness-sensitive:** `/content/publish/*`, `/content/rollback`,
  `/content/hashes`, `/content/source-hashes`, `/admin/rebuild`, `/feedback/*`,
  `/api/ui-event`, `/puzzle-api/check`, `/petoberfest-api/*/upload`.
- **Runtime-served, intentionally near-real-time:** `/api/alerts` — alerts are
  cache-bust-on-save with an intended up-to-60s admin→visitor delay (see
  [tutorials-ims-gotchas.md](../reference/tutorials-ims-gotchas.md)). Do **not**
  let the edge extend that window.

> **The single biggest correctness risk is the cache key on authenticated
> routes, not perf.** Get the key wrong on a per-user route and you serve one
> user's progress/gameboard/admin view to another. Default-deny + the explicit
> bypass list above is what prevents that.

## Invalidation on publish

Today there is **no external purge signal** — the only cache invalidation on a
content change is the in-process bounded LRU (`ContentCache` in
`srv/lib/content-store.js`), cleared via `cache.invalidate()`. It is called in
exactly three places:

- `publishHandler` (deprecated legacy path) — ~line 489
- `rollbackHandler` — ~line 1452
- `commitHandler` (the live chunked-publish commit) — ~line 1609

A successful publish emits **no HTTP webhook, no event-bus message, no CDN
call.** The closest existing "invalidate on content change" precedent is the
admin-write hook in `srv/server.js` (`.after(['CREATE','UPDATE','DELETE'])` →
`invalidateNavigatorCache()` / `invalidateRenderCache()`).

### Where a purge hook goes

**Primary — server-side, covers every publish path (GitHub workflow *and* the
emergency workstation path):** add a fire-and-forget CDN Fast-Purge call in
`commitHandler` (`srv/lib/content-store.js`), immediately after the existing
`cache.invalidate()` at ~line 1609. Scope it to the changed slugs: `commitSession`
(`srv/lib/content-publish-session.js`) already computes `freshSlugs`
(~line 386, filtered for rejected reverts at ~line 404) — return it from
`commitSession` so the purge can target `/tutorials/<slug>` (+ the affected
`/concepts/*` and `_nav.json`) rather than a full-zone purge. **Mirror it in
`rollbackHandler`** (~line 1452) so a rollback also purges the edge.

**Make it fail-open and off the critical path** — model it on the existing
fire-and-forget `alerting.raise(...)` at `content-publish-session.js` ~line 519
(`void`, no `await` blocking the commit response, swallow errors). A CDN outage
must never fail a content commit.

**Secondary (supplement, not the mechanism):** a purge step in
`rebuild-content.yml` after the publish step succeeds — it has the slug list and
target env in scope. But it **misses the emergency workstation publish path**
(`scripts/publish-content.ts` run by hand), so the server-side hook is the robust
choice and the workflow step is only belt-and-suspenders. See
[rebuild-content-workflow.md](../operations/rebuild-content-workflow.md).

### On-publish flow (with the proposed hook)

```text
publish-content.ts  --(chunked session)-->  POST /content/publish/commit
                                               → commitHandler (content-store.js:1604)
                                                   → commitSession()  [manifest flip, freshSlugs]
                                                   → cache.invalidate()            (:1609, in-process LRU)
                                                   → void cdnPurge(freshSlugs)     ← PROPOSED (fail-open)
rollback  ---------->  POST /content/rollback
                                               → rollbackHandler (:1414)
                                                   → cache.invalidate()            (:1452)
                                                   → void cdnPurge(revertedSlugs)  ← PROPOSED
```

## Adoption checklist

1. **Edge confirmed** — ✅ `developers.sap.com` already fronts with Akamai
   (asserted by `test/smoke/security-headers.test.js`). Treat this as adopt, not
   greenfield: origin headers land against a live edge.
2. **Origin headers** — ✅ **done.** `setContentCacheHeaders`
   (`srv/lib/edge-cache-headers.js`) emits the split `max-age`/`s-maxage` +
   `stale-while-revalidate` `Cache-Control`, `Vary: Accept-Encoding`, and a
   per-response `Edge-Cache-Tag` on every cacheable 200 content response in
   `content-store.js` and `concept-list-page.js`. Guarded by
   `test/unit/edge-cache-headers.test.js`.
3. **Static-asset TTL** — ✅ **done.** The `cacheControl` asset route in
   `approuter/xs-app.json` sets a redeploy-safe 1 h TTL (§"Static assets").
4. **Edge config = cache-on-allow-list, not cache-by-default** — apply the
   allow-list above at the Akamai config; hard-bypass every `xsuaa` route plus
   the three deceptive `none`-but-personalized routes. (Edge-side config, not in
   this repo.)
5. **Honor origin headers** — respect the origin `Cache-Control` / `ETag` /
   `Vary`; forward `If-None-Match` for cheap 304 revalidation; never cache a
   response carrying `Set-Cookie`. (Edge-side config.)
6. **Wire the purge** — ⏳ **remaining.** Add the fire-and-forget Fast-Purge in
   `commitHandler` + `rollbackHandler` keyed off `freshSlugs`, mapping each slug
   to its `item-<slug>` `Edge-Cache-Tag`; keep it fail-open. This is the one code
   change still outstanding.
7. **Verify** — after a slug-targeted publish, confirm the edge serves the new
   `contentHash` (compare the `ETag` / `X-Content-Source` header) within seconds,
   not on the `s-maxage` ceiling.

Skip step 6 and you trade a solved staleness problem (live-from-HANA) for an
unsolved one (edge staleness bounded by `s-maxage` after every publish) — the
one outcome that makes a CDN a regression here rather than an upgrade.
