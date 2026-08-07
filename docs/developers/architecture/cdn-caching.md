# CDN / edge caching

> **Status:** design analysis + proposal. As of this writing the platform runs
> **without** a project-owned CDN configuration and **without** any external
> cache-purge signal on publish. `developers.sap.com` almost certainly already
> fronts with Akamai at the SAP-domain level, so in practice this is less
> "should we adopt a CDN" and more "what edge caching rules are safe for *this*
> origin, and how do we invalidate them on publish." Confirm the existing edge
> before treating this as greenfield.

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
| Static assets (Hugo CSS, Vue-island JS, images, fonts) | **Yes** | Classic CDN offload; fingerprinted → long TTL. |
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

## The origin is already CDN-shaped

The content handler (`serveHandler` in `srv/lib/content-store.js`) already emits
correct validators and TTLs — no origin changes are required to put an edge in
front:

```js
// srv/lib/content-store.js — DB-served tutorial (~line 1073)
res.setHeader('ETag', `"${meta.contentHash}"`);        // SHA-256 of the HTML
res.setHeader('Cache-Control', 'public, max-age=300');
res.setHeader('X-Content-Source', 'db');
```

- **ETag = `contentHash`** (SHA-256 of the served HTML). The handler honors
  `If-None-Match` and returns `304` on a match, so a CDN gets cheap
  revalidation.
- **`Cache-Control: public, max-age=300`** on the DB-served path, the in-process
  cache-hit path (~line 1024), and the rendered/render-cache catalog paths
  (~lines 923, 967). `serveNotFound` → `max-age=60`; 301 redirects →
  `max-age=3600` (~lines 841, 860).
- **No `Last-Modified`** anywhere — ETag is the only validator (fine; don't rely
  on `Last-Modified` at the edge).
- The delta/drift probes (`/content/hashes`, `/content/source-hashes`) set
  `Cache-Control: no-cache` (~lines 1105, 1173) — correct, they must never be
  cached.

So an edge keying on ETag + a short TTL is viable **today**. The only thing
missing is **push invalidation on publish**: with a pure 300s TTL, worst-case
edge staleness after a publish is 5 minutes. That is the one gap that would turn
a CDN from an upgrade into a regression relative to the "serve live from HANA to
avoid staleness" design intent.

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
| Hugo static assets (CSS/JS/img/fonts) + the `^(.*)$` catch-all → `localDir: static` | AppRouter static dir | long (fingerprinted) |

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

1. **Confirm the edge** — determine whether `developers.sap.com` already fronts
   with Akamai and whether this project owns any of its caching rules. Adjust
   scope accordingly (configure vs. adopt).
2. **Edge config = cache-on-allow-list, not cache-by-default** — apply the
   allow-list above; hard-bypass every `xsuaa` route plus the three deceptive
   `none`-but-personalized routes.
3. **Honor origin headers** — respect the origin `Cache-Control` / `ETag`;
   forward `If-None-Match` for cheap 304 revalidation; never cache a response
   carrying `Set-Cookie`.
4. **Wire the purge** — add the fire-and-forget Fast-Purge in `commitHandler` +
   `rollbackHandler` keyed off `freshSlugs`; keep it fail-open.
5. **Verify** — after a slug-targeted publish, confirm the edge serves the new
   `contentHash` (compare the `ETag` / `X-Content-Source` header) within seconds,
   not on the 300s TTL.

Skip step 4 and you trade a solved staleness problem (live-from-HANA) for an
unsolved one (5-min edge staleness after every publish) — the one outcome that
makes a CDN a regression here rather than an upgrade.
