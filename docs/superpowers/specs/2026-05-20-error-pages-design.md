# Error Pages — Design

**Date:** 2026-05-20
**Gap:** AEM Gap #14 — Error Pages (404 / 500) + 503 maintenance
**Status:** Proposed

## Context

AEM served a custom Handlebars 404 with site search and a "popular tutorials" rail, plus a generic 500. After the AEM cutover, Hugo emits a minimal 404 (`hugo/layouts/404.html` — hero with two CTAs, no search, no popular rail) and there is no 500 or 503 page. Worse, AppRouter's `xs-app.json` does not configure the `errorPage` map, so unmatched routes hit AppRouter's default `Cannot GET /foo` HTML — the Hugo 404 sits in `approuter/static/404.html` unreachable.

A 404 is often the user's first impression after a broken link from a search engine. A bare or generic 404 is a bounce. This change closes that gap and adds parity-plus pages for 500 and 503.

## Goals

1. Custom 404 page with site search and a popular-tutorials rail, served at the original URL with status 404 preserved.
2. Custom 500 page with `/health` and `/health/db` links so users (and on-call engineers) can quickly distinguish "site is broken" from "my one request failed."
3. Custom 503 maintenance page for planned-outage use.
4. AppRouter wiring so the right page renders for the right status without per-route changes.
5. The popular-tutorials rail should be authoritative (driven by `FeaturedTasks` admins curate) and degrade gracefully when the API is unavailable.

## Non-goals

- A maintenance toggle UI or env-var-driven 503. The 503 page exists and is wired to the AppRouter; deciding when to serve it is operational, not in scope.
- Replacing CAP's own JSON 404/500 responses. API consumers continue to receive JSON.
- Localized error pages. The site is English-only (per project memory).

## Architecture

### Error flow

```
Browser ─GET /broken-link────▶ AppRouter
                                 │
                                 ├── route match: catch-all ^(.*)$ → static dir
                                 ├── static-resource-handler: file not found
                                 │     └── next(err) with err.status = 404
                                 ├── error-handler.js
                                 │     └── errorPage[404] = "static/404.html"
                                 │           send().pipe(res), statusCode = 404
                                 └── Browser sees: URL unchanged, status 404, our HTML body
```

Verified in `approuter/node_modules/@sap/approuter/lib/middleware/error-handler.js`:
- `errorPage` does an in-place serve via `send().pipe(res)` (URL preserved, status preserved).
- It only fires when middleware calls `next(err)` — proxied destination responses pass through unchanged, so CAP API JSON 404/500 responses are not affected.
- File paths in `errorPage` resolve against `routerConfig.workingDir` (the approuter directory).

### Components

#### `hugo/layouts/404.html` (rewrite)

Extends `_default/baseof.html`. Three sections inside the existing hero shell:

1. **Search form** — plain `<form action="/" method="get">` with `<input name="q">`. Submit lands on `/?q=<term>`.
2. **Popular tutorials rail** — Hugo renders 6 cards from `where .Site.RegularPages "Type" "tutorials"` ordered by `.ByLastmod.Reverse` (mirrors index.html "Recently updated"). Each card uses the existing tutorial card markup so styling is shared.
3. **Optional JS upgrade** — small inline `<script>` fetches `/build/catalog`. If the response includes a `featured` array, replaces the rail; on any failure (network, missing field, parse) the static rail stands. No external module load.

Existing 404 hero copy ("We couldn't find that tutorial") and CSS are kept; new sections are appended below.

#### `hugo/layouts/500.html` (new)

Extends `_default/baseof.html`. Apologetic copy plus:
- Primary action: "Try again" button — `<button onclick="window.location.reload()">`.
- Secondary action: "Browse tutorials" → `/`.
- Status check links: `/health` (alive) and `/health/db` (HANA reachable). Open in new tab. Useful for on-call.

No popular rail (a 500 is not the moment to advertise tutorials).

#### `hugo/layouts/maintenance.html` (new)

Extends `_default/baseof.html`. Brief "scheduled maintenance" copy, link to `/`, no API fetches, no `/health` (which would defeat the purpose of a maintenance page if `/health` is also down).

#### `apps/src/navigator/TutorialNavigator.vue`

Add `?q=` URL parameter seeding. In `onMounted` (or before the existing async fetch), read:

```ts
const q = new URL(window.location.href).searchParams.get('q')
if (q) searchQuery.value = q
```

This is the only change needed for the search-form-redirects-to-home flow. The reactive search effect already fires when `searchQuery` changes.

#### `srv/lib/build-catalog.js`

Add a `featured` array to the catalog response, derived from `FeaturedTasks` joined with task type (mission/group/tutorial) and slug. Top N by `featuredOrder`. Shape:

```jsonc
{
  "missions": [...],
  "groups": [...],
  "tutorials": [...],
  "featured": [
    { "type": "mission",  "slug": "abap-dev-get-started", "title": "...", "description": "..." },
    { "type": "tutorial", "slug": "hana-cloud-getting-started", "title": "...", "description": "..." }
    // ... up to 6
  ]
}
```

Endpoint stays unauthenticated (already is). No DB schema change — `FeaturedTasks` already exists.

#### `approuter/xs-app.json`

Add at top level alongside `routes`, `responseHeaders`, etc.:

```json
"errorPage": [
  { "status": 404, "file": "static/404.html" },
  { "status": 500, "file": "static/500.html" },
  { "status": 503, "file": "static/maintenance.html" }
]
```

No route changes.

### Build / deploy plumbing

Hugo emits site-root files (`hugo/public/404.html`, `500.html`, `maintenance.html`) automatically when layouts of those names exist. The MTA build copies `hugo/public/*` into `approuter/static/`, landing at the paths referenced in `errorPage`. The implementation plan must verify the deploy step does not filter root-level HTML files (a five-minute check on `mta.yaml` and any pre-deploy rsync/cp).

## Data flow

1. **404 path:** Browser → AppRouter → static handler → 404 → error-handler → `static/404.html` served with status 404.
2. **API 404 path:** Browser → AppRouter → API route → CAP returns JSON 404 → AppRouter streams JSON through unchanged. (Verified by code inspection — proxied responses do not pass through `error-handler.js`.)
3. **Tutorial slug 404 (open item — see Edge Cases):** Browser → AppRouter → `/tutorials/<slug>` route → CAP `/content/tutorials/<slug>` returns 404. Behavior depends on whether AppRouter intercepts proxied 404s as errors or streams them. Implementation plan starts with a one-line probe (`curl -i .../tutorials/does-not-exist`); if the response is plain text from CAP, add an explicit error mapping for that route (see [Edge Cases](#edge-cases)).
4. **Popular rail (build):** Hugo build → reads tutorials by lastmod → renders 6 cards into static HTML.
5. **Popular rail (runtime upgrade):** 404 page loads → inline script fetches `/build/catalog` → if `featured` field present, replaces rail HTML in place; on failure, no-op.
6. **Search form:** User types query on 404 page → submits → browser navigates to `/?q=<term>` → home page loads → `TutorialNavigator` mounts → reads `?q=` → seeds `searchQuery` → existing search effect fires.

## Error handling

- **404 page → API down:** Static rail is rendered at Hugo build time, so the page is fully usable without any API. The runtime upgrade is best-effort — failures are silent and logged to the browser console only.
- **404 page → CSS missing:** baseof.html applies; if shared CSS bundles fail, the page degrades to plain semantic HTML, which is still usable. No inline-only fallback needed.
- **500 page → /health links broken:** Open in a new tab. If `/health` itself returns 5xx, AppRouter's error handler will not re-trigger the 500 page (because the request is from the user's click, not the same flow). Worst case the user sees a JSON or plain-text error in the new tab — acceptable for an on-call diagnostic link.
- **errorPage file missing on disk:** `error-handler.js` falls back to a plain-text status code response. The implementation plan includes a smoke test to catch this in CI.

## Testing

### Smoke tests (`test/smoke/error-pages.test.js`, new)

- `GET /this-path-does-not-exist`
  - Status: 404
  - `content-type: text/html`
  - Body contains marker (e.g., `data-error-page="404"` attribute on the root section) and the search input
- `GET /assets/missing.js`
  - Same 404 expectations (catches the case where errorPage somehow only fires for HTML-accept paths)
- 500 and 503 pages: smoke fetches `GET /500.html` and `GET /maintenance.html` directly to confirm the file deployed and is fetchable. Each layout includes a `data-error-page="<status>"` marker so the 404 smoke can also assert the served body matches the right page (closes the loop on `errorPage` being correctly mapped). Triggering a real 500/503 in smoke is not worth the test infrastructure.

### Unit / integration

- None. The Hugo templates are straightforward and the only new code paths are a 3-line Vue change (covered by manual verification — type the URL, see the seeded search) and the catalog `featured` field (covered by a hybrid test if we have one for `/build/catalog`; otherwise hybrid is over-rotation for this).

### Manual verification

1. Local: `npm run build:hugo && cp hugo/public/* approuter/static/` then start approuter, hit `/nonsense`.
2. Deployed: hit `https://<approuter>/nonsense`, see styled 404 with search and popular rail.
3. Submit a search query from 404 → confirm landing on `/?q=cap` shows pre-filtered results.

## Edge cases

### EC1: Proxied 404 from CAP for `/tutorials/<missing-slug>`

The `/tutorials/(.*)` route in `xs-app.json` proxies to CAP's `/content/tutorials/<slug>`. When the slug doesn't exist, CAP returns 404 (currently with a plain-text or short HTML body). AppRouter typically streams proxied responses through unchanged, which would leak CAP's 404 instead of our nice page.

**Plan:** Implementation starts with a one-line probe — `curl -i $APPROUTER/tutorials/does-not-exist` — to observe behavior. If CAP's body leaks through, add `errors: [{ status: 404, file: "static/404.html" }]` to the `/tutorials/(.*)` route in `xs-app.json` (per-route override that intercepts upstream 404s). If AppRouter already serves our 404 for this case, no change needed.

### EC2: Errors during AppRouter login flow

XSUAA login redirects can produce 5xx if XSUAA is down. AppRouter's error-handler will catch them and serve our 500 page. That's the desired behavior — the user sees a friendly page rather than a stack trace.

### EC3: `errorPage` and the static catch-all

The catch-all route `^(.*)$ → localDir: static` is the last route in `xs-app.json`. The error-handler runs after all routes. So `errorPage` fires for any unmatched-file 404, regardless of which earlier route was attempted. No interaction.

### EC4: WebSocket connection failures

WebSocket upgrade failures (e.g., `wss://.../display/websocket`) hit different code paths. They will not show our HTML 500 (a WebSocket client doesn't render HTML anyway). Out of scope for this change.

### EC5: Bots crawling 404s

Search engines treat HTTP 404 as "remove from index." Because `errorPage` preserves the status code (line 46 of `error-handler.js`: `res.statusCode = status`), our pretty page does not accidentally signal "200 OK" to crawlers. This was the AEM behavior too — important to preserve.

### EC6: CSP and inline `<script>` for the runtime upgrade

The 404 page's optional runtime-upgrade script must comply with the existing CSP header (`script-src 'self' 'unsafe-inline' ...`). `'unsafe-inline'` is already permitted, so an inline `<script>` block works. If a future hardening pass removes `'unsafe-inline'`, this becomes an external `/js/popular-rail.js` file — trivial migration.

## Open questions

None blocking. The proxied-404 behavior (EC1) is resolved by a one-line probe during implementation.

## File-by-file summary

| File | Change |
|---|---|
| `hugo/layouts/404.html` | Rewrite: keep hero, add search form + popular rail + runtime upgrade script |
| `hugo/layouts/500.html` | New: apologetic copy, retry button, /health links |
| `hugo/layouts/maintenance.html` | New: maintenance copy, link home, no fetches |
| `apps/src/navigator/TutorialNavigator.vue` | ~3 lines: read `?q=` on mount, seed `searchQuery` |
| `srv/lib/build-catalog.js` | Add `featured` array from `FeaturedTasks` |
| `approuter/xs-app.json` | Add `errorPage` map for 404/500/503; possibly `errors` override on `/tutorials/(.*)` route after EC1 probe |
| `test/smoke/error-pages.test.js` | New smoke test |

## Sequencing

The work is small enough to do as a single commit, but the suggested order during implementation is:

1. Hugo layouts (404, 500, maintenance) — visible locally via `cds watch` + Hugo dev server.
2. `TutorialNavigator.vue` `?q=` seeding — verify on home page.
3. `/build/catalog` `featured` field — verify with `curl http://localhost:4004/build/catalog | jq .featured`.
4. `xs-app.json` `errorPage` — verify with the local approuter (`npm run dev:hybrid`).
5. EC1 probe + conditional `errors` override.
6. Smoke test.
7. Deploy and re-verify on the deployed approuter.
