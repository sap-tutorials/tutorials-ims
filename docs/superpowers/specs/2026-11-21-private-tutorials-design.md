# Private Tutorials — Design

**Issue:** [sap-tutorials/tutorials-ims#3099](https://github.com/sap-tutorials/tutorials-ims/issues/3099) · Design, 2026-11-21.
**Research basis:** [`docs/developers/reference/private-tutorials-research.md`](../../developers/reference/private-tutorials-research.md) (merged, PR #3165).

Designs two independent "private tutorial" behaviors on top of the existing authoring + render pipeline, both driven by one new per-tutorial `visibility` field. No change to how tutorials are authored or rendered — only to where they're *discoverable* and who can *serve* them.

---

## Intent & why

Today every published tutorial is public: listed in the navigator, indexed by search, in the sitemap, and served anonymously at `/tutorials/:slug`. Two situations need something narrower:

1. **Event-hidden** — tutorials that exist for an App Space event but shouldn't appear in the navigator, search, or sitemap, and shouldn't be stumbled onto outside the event app. Reached only via the event app's own links. **Not sensitive** — a leaked URL still works. This is a *discoverability* change, not a security boundary.
2. **Pre-release** — tutorials for unreleased features, visible and servable only to a select group controlled by an **auth role**. Both listing *and* serving must refuse anyone without the role. This **is** a security boundary (hard gate).

## Goals

- One `visibility` field on `Tutorials`: `LISTED` (default, today's behavior), `UNLISTED` (event-hidden), `ROLE_GATED` (pre-release).
- `UNLISTED`: suppressed from navigator, search, and sitemap; still servable at its normal URL.
- `ROLE_GATED`: suppressed from navigator, search, and sitemap for everyone; servable **only** behind an XSUAA scope (`Tutorial.PreRelease`) at a dedicated gated route; defense-in-depth so a direct hit on the public route cannot serve it.
- Existing tutorials keep behaving exactly as now (default `LISTED`).

## Non-goals

- Per-user allowlists or per-event membership gating (pre-release is **role-scoped**, all-or-nothing by role; event-hidden is hide-only, no auth).
- Geo/IP fencing (research option C — not in scope).
- A separate app/namespace/HDI container for private content (research option B — the content isn't sensitive enough to warrant physical isolation; the role gate suffices).
- Private source repos / non-persisted rendering (SAGE model) — both features ride the normal public `ContentCurrent` store.
- Mission/Group visibility — the field lives on `Tutorials` only.

## Anti-goals (would make this a failure even if it "works")

- A ROLE_GATED tutorial ever served to a caller without the scope — including by a bug that fails *open*. Pre-release gating must **fail closed**.
- Flipping the anonymous public `/tutorials/*` route to authenticated, degrading every normal tutorial request.
- An UNLISTED or ROLE_GATED slug leaking into the sitemap or search index.

## Constraints

- House style: DB-backed feature flags where a flag is warranted, DEV-first, PRs target **DEV** (never direct-merge to `main`).
- Serve handler (`packages/content/content-store.js`) does **no** JWT/scope parsing today and the `/tutorials/*` route is `authenticationType: none`. The design must not introduce JWT parsing into the anonymous route.
- Navigator and search read from **views** over `Tutorials` (`NavigatorCatalog`, `SearchableItems`); sitemap is **Hugo-generated at build time**, not a request-time handler. These are three different seams with three different fixes.
- XSUAA scope changes require a manual `cf update-service tutorials-xsuaa -c xs-security.json` after deploy (MTA deploys often skip the re-push).

---

## Approaches considered

### Pre-release serve gate

- **A1 — gated prefix route (CHOSEN).** Serve ROLE_GATED tutorials under a dedicated prefix (`/tutorials-prerelease/:slug`) that the approuter gates with `authenticationType: xsuaa` + `scope: $XSAPPNAME.Tutorial.PreRelease`, routed to the *same* serve handler. Mirrors the proven QA-channel route gate exactly; introduces no JWT parsing; leaves the anonymous `/tutorials/*` route untouched. The handler additionally refuses to serve a ROLE_GATED row on the *public* route (defense-in-depth), so the gate holds even if someone guesses the public URL.
- **A2 — in-handler scope check (rejected).** Flip `/tutorials/*` to authenticated and parse the JWT in the handler, enforcing the scope only for ROLE_GATED rows. Gives one URL for all tutorials and true per-row gating, but adds net-new JWT/scope parsing to a handler that has none and makes every anonymous tutorial request pass through auth — a fail-open risk on the whole public surface. Rejected: too much blast radius for a feature that only needs to gate a handful of rows.
- **B — clone the QA channel (rejected).** Separate app + namespace + HDI container. Full isolation, but the content isn't sensitive beyond the role gate, so the heavyweight separation buys nothing. Rejected per non-goals.

**Chosen: A1.** Pre-release tutorials are reached from a controlled app (the pre-release/event surface), not the public navigator, so a distinct URL is acceptable, and A1 reuses machinery that already works in production for QA.

### Event-hidden

One sensible way: a `visibility: UNLISTED` flag + suppression at the three discovery seams, served unchanged at the normal public URL. The alternatives (private repo, separate app, auth gate) all contradict "not sensitive, lives in the current store," so they were dropped without a full write-up.

---

## The design

### 1. Data model — `db/schema.cds`

- New enum near the existing `TaskStatus` (line 18):
  ```cds
  type Visibility : String(50) enum { LISTED; UNLISTED; ROLE_GATED; }
  ```
- New element on `Tutorials` directly (entity body lines 46–73), **not** on the shared `TaskBase` aspect (keeps the field per-tutorial; Missions/Groups do not get it):
  ```cds
  visibility : Visibility default 'LISTED';
  ```
  Default `LISTED` means every existing row reads as today without a data migration.
- No other entity carries the field. Navigator and search read it through views over `Tutorials`; the serve handler reads the column directly. `TutorialMeta` does not need it (it carries per-user/per-repo metadata, not catalog identity).

### 2. Discovery suppression — three seams

**Keying decision (confirmed with maintainer):** `build-catalog.js` **keeps every tutorial** and gains a `visibility` field on its payload; the *consumers* filter, not the catalog. Required because `fetch-tutorials` reads `/build/catalog` (via `CAP_BASE_URL`) to generate tutorial pages — if the catalog dropped non-`LISTED` rows, the build step could never generate UNLISTED pages (which must still be built and reachable by URL) nor mark them `private`. So: catalog carries visibility; navigator/search views filter to `LISTED`; the build step reads visibility off the catalog to emit sitemap front-matter.

| Surface | File:line | Change |
| --- | --- | --- |
| Navigator (nav tree) | `db/views.cds:95-96` — `NavigatorCatalog` view WHERE | add `and tut.visibility = 'LISTED'` (treat null as LISTED if the column can be null pre-activation: `and (tut.visibility = 'LISTED' or tut.visibility is null)`) |
| Catalog/browse feed | `srv/lib/build-catalog.js:24-26` — direct CQL `SELECT.from(Tutorials)` | **Do NOT filter out non-LISTED.** Add `visibility` to the selected columns so the build step can read it. The user-facing *browse page* filters to `LISTED` where it consumes this payload; the raw feed carries all rows. |
| Search index | `db/views.cds:112` — `SearchableItems` Tutorials branch WHERE | add `and (t.visibility = 'LISTED' or t.visibility is null)` |
| Sitemap | Hugo template `hugo/layouts/_default/sitemap.xml` (already excludes `.Params.private`) + `fetch-tutorials` page generation | `fetch-tutorials` emits `private: true` front-matter for any tutorial whose catalog `visibility != 'LISTED'`, so the existing `.Params.private` exclusion drops it from the sitemap. Data path already exists (catalog read via `CAP_BASE_URL`). |

Both `UNLISTED` and `ROLE_GATED` are suppressed from navigator, search, and sitemap — only `LISTED` is discoverable. (Views filter to `LISTED` rather than "not UNLISTED" so ROLE_GATED is hidden too.) UNLISTED pages are still **built and servable** at their normal URL (event-hidden = hide-only). ROLE_GATED pages are also built and published to the shared store (maintainer-confirmed), but the serve gate (§3) makes the public route 404 them.

### 3. Pre-release serve gate (A1)

- **Approuter** — `approuter/xs-app.json`: add a route block mirroring the `Tutorial.Author` QA routes (~lines 629–674), for the new prefix:
  ```jsonc
  { "source": "^/tutorials-prerelease/(.*)$",
    "target": "/content/tutorials-prerelease/$1",
    "destination": "srv-api",
    "authenticationType": "xsuaa",
    "scope": "$XSAPPNAME.Tutorial.PreRelease" }
  ```
  This rewrites to a **new** CAP path `/content/tutorials-prerelease/*` (mounted in `srv/server.js` to the shared `serveHandler` with a `gated: true` flag — see "gated-request marker"), so the mount itself is the trust signal. The public `/content/tutorials/*` mount is unchanged and anonymous.
- **XSUAA** — `xs-security.json`: mirror the three `Tutorial.Author` entries for `Tutorial.PreRelease`:
  - scope `$XSAPPNAME.Tutorial.PreRelease` (after line 37),
  - role-template `TutorialPreRelease` (scope-references the new scope + `Everyone`),
  - role-collection `"Tutorials PreRelease"`.
  Access = assign the "Tutorials PreRelease" role collection in BTP. Remember the manual `cf update-service` after deploy.
- **Defense-in-depth in the handler** — `packages/content/content-store.js`. Three coupled changes:
  1. **Read visibility early, before the cache lookup.** The in-process cache (`serveStoredSlug`, line ~989 `cache.get(slug)`) is keyed by bare `slug` and the served response sets `Cache-Control: public, max-age=60` (line ~1102 / headers below). Both routes share this handler, so the visibility/route decision **must run on every request before `cache.get`**, not only on cache misses — otherwise a warmed cache serves a ROLE_GATED body to a later public hit. The status SELECT at 1295–1298 already runs before the cache hit (comment line ~1285); add the `visibility` column there and gate the cache path on the result.
  2. **Public route + ROLE_GATED → 404.** The approuter rewrites `/tutorials-prerelease/*` → `/content/tutorials/*`, so the handler needs a **trusted** way to tell a scope-gated request from a raw public one (see "gated-request marker" in What's left — must be approuter-set and not client-spoofable). If the row is `ROLE_GATED` and the request did **not** arrive via the gated prefix → `serveNotFound` (404, not 403 — don't confirm existence). Fail **closed**: if visibility can't be read, do not serve on the public route.
  3. **Gated responses are not cacheable as public.** When serving a ROLE_GATED tutorial via the gated route, set `Cache-Control: private, no-store` (not `public, max-age=60`) and **do not enter it into the shared in-process `cache`** (or key that cache by route+slug so a gated entry can never satisfy a public lookup). Otherwise the edge/CDN or the shared process cache re-serves gated bytes on the public route and defeats the 404 in step 2. This is the load-bearing cache change the first draft missed.

  Net: the public route is structurally unable to serve or cache pre-release content; the gated route (scope-enforced at the edge) serves it with no-store.

### 4. Authoring

Authors set `visibility` the same way they set other tutorial metadata — via the publish path / admin. Default is `LISTED`, so nothing changes for existing authoring. (Exact admin-UI affordance left to the builder; the field is a simple enum on `Tutorials`.)

---

## What's left to the builder

- **Gated-request marker mechanism (my call; builder confirms the approuter mechanics).** The handler must trust the "came via the gated route" signal, and an approuter *route-injected request header* is not reliably trustworthy (version-dependent, and headers are easy to get wrong). **Decided approach: route to a distinct backend path, not the same one.** The gated approuter route rewrites `/tutorials-prerelease/(.*)` → **`/content/tutorials-prerelease/$1`** (a new path), and CAP mounts that path to the *same* `serveHandler` with a flag (e.g. `serveHandler` bound with `{ gated: true }`, or a sibling `app.get('/content/tutorials-prerelease/*slug', ...)` in `srv/server.js` that calls the shared handler with the gated flag). The public `/content/tutorials/*` mount stays anonymous and `gated: false`. The discriminator is then the *mount*, which the client cannot influence — not a spoofable header. This keeps "one handler, one cache-aware code path" while giving a trustworthy signal. (Note vs. QA: QA gets isolation from a separate *destination/app*; here both paths hit the same app, so the trust boundary is the server-side mount, enforced by the §3 cache rules.) Builder to confirm the installed `@sap/approuter` rewrites the path as expected and that the scope check precedes the rewrite.
- Whether `UNLISTED`/`ROLE_GATED` tutorials should also be excluded from any *other* derived surfaces not listed above (e.g. "related tutorials" widgets, RSS, KG projections) — builder to grep for other consumers of the `Tutorials`/`NavigatorCatalog`/`SearchableItems` sets and apply the same `LISTED` filter; the four in §2 are the known ones.
- Admin-UI affordance for setting `visibility` (dropdown on the tutorial admin form).
- Whether the pre-release surface needs its own navigator (a scope-gated listing of ROLE_GATED tutorials for role-holders) — out of scope here unless you want role-holders to *browse* pre-release tutorials rather than follow direct links. Flag for a follow-up.
- Tests: unit coverage that each view/predicate excludes non-`LISTED`; a serve-handler test that a ROLE_GATED slug 404s on the public route and serves on the gated route; smoke/e2e that the approuter returns 403 without the scope.

## Rollout

- DEV-first. The data-model default (`LISTED`) makes the change inert until a tutorial is explicitly marked otherwise, so no feature flag is strictly required — but gate the **serve-handler defense-in-depth branch** conservatively (fail closed: if visibility can't be read, treat as non-servable on the public route only for rows that *are* ROLE_GATED; never fail open).
- Ship order: (1) data model + view/predicate filters + sitemap front-matter (makes UNLISTED fully work and hides ROLE_GATED from discovery); (2) xs-security scope/role + approuter gated route + handler defense-in-depth (makes ROLE_GATED servable to role-holders and unservable to everyone else). Each step is independently safe.
- **XSUAA sequencing (ops-critical):** the `Tutorial.PreRelease` scope must be **live before** the approuter route references it. MTA deploys often skip re-pushing xs-security, so step (2) includes an explicit `cf update-service tutorials-xsuaa -c xs-security.json` and a verification that the scope exists before the gated route is exercised. If the route references a scope that isn't live, the gate can fail to start or no-op — treat "scope live" as a gate on serving ROLE_GATED content. This is a builder+ops step, not auto-verified by the pipeline.
