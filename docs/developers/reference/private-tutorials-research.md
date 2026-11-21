# Private Tutorials — Research

**Issue:** [sap-tutorials/tutorials-ims#3099](https://github.com/sap-tutorials/tutorials-ims/issues/3099) · Research spike, 2026-11-21.

Evaluates how to add **Private Tutorials** to developers.sap.com: tutorials authored and rendered through the existing pipeline but **served to a restricted audience** — gated to specific logged-in accounts, or geo/IP-fenced — so they can safely carry sensitive material (credentials, login details) or unreleased features shown only in a controlled setting (CodeJams, App Space, TechEd labs). This is a scoping doc; it does **not** commit an implementation to the roadmap.

---

## TL;DR

- **Reuse is high.** Authoring and rendering are unchanged — the gap is entirely at the **serve/access** layer. We already ship two working templates for "same pipeline, restricted audience": the **QA channel** (`srv-qa`) and the **SAGE preview backend** (`srv-sage`).
- **Nothing gates tutorial content today.** `/tutorials/*` is `authenticationType: "none"` at the approuter and a bare, unauthenticated Express handler in CAP. The only serve-time decision is lifecycle `status` (ACTIVE vs INACTIVE). There is **no** per-tutorial visibility flag, **no** account allowlist, and **no** geo/IP fencing anywhere in the codebase — all three are net-new.
- **Two viable gating models**, matching the two precedents:
  1. **Channel gate (coarse, QA-style):** a separate app/namespace + approuter XSUAA-scope gate. All-or-nothing per channel, edge-enforced. Cheapest; proven.
  2. **Per-identity gate (fine, SAGE-style):** IAS/XSUAA-authenticated backend with in-handler identity checks (allowlist / event-membership). Needed for "gate to specific accounts."
- **Geo/IP fencing is greenfield** — we have a reusable client-IP extractor but no country resolution or allow/deny evaluation. Best placed as an approuter extension (defense at the edge) rather than deep in CAP.
- **Sensitive content raises the bar.** Every existing channel gates only at the approuter; the CAP serve handler trusts whoever reaches it. For credentials-in-tutorials, a design should add **defense-in-depth** (handler also enforces), and treat secrets as rotate-after-event, never long-lived.
- **Recommendation:** pursue as a feature-flagged spike in house style (DB flags, fail-closed for *private* content, DEV-first). Start from the **SAGE auth model** for account-gating; layer the **QA channel pattern** for a whole-channel event lane; treat geo/IP as an optional, separate approuter layer.

---

## What "private" must change — and what it must not

The authoring and rendering pipeline is **unchanged**. A private tutorial is still markdown in a `sap-tutorials` repo → parsers → Hugo → HTML BLOB in HANA. What changes is only **who can retrieve the rendered HTML**, and **where the sensitive source lives**.

| Layer | Public tutorials today | Private tutorials need |
| --- | --- | --- |
| Authoring | markdown in public `sap-tutorials/*` repos | **private** source repo (credentials must not sit in a public repo) |
| Parse / render | `scripts/parsers/*` → Hugo | unchanged |
| Storage | `ContentCurrent` BLOB, flat `slug` namespace | prefixed slug or separate namespace/container |
| **Serve** | `/tutorials/*` → `none` auth → bare Express handler | **authenticated + authorized** serve path |
| Access decision | `status !== 'INACTIVE'` | identity allowlist / event-membership / geo-IP |

---

## Existing building blocks (verified in-repo)

### 1. Serving is 100% anonymous today

- AppRouter `approuter/xs-app.json` routes `^/tutorials/(.*)$` → `/content/tutorials/$1`, destination `srv-api`, **`authenticationType: "none"`** (same for `_nav.json`/`.model.json`).
- CAP mounts a bare Express route in `srv/server.js:849` — `app.get('/content/tutorials/*slug', serveHandler)` — **no auth middleware**.
- `serveHandler` (`packages/content/content-store.js:1116`; `srv/lib/content-store.js` is a re-export facade) does a status lookup (`content-store.js:1295-1326`): the **only** access decision is `status === 'INACTIVE'` → 404. Everything else is served.
- **Implication:** account-gating `/tutorials/*` requires flipping the route to `xsuaa`/`ias` *and* adding enforcement in the handler. Doing it for a *subset* (only private slugs) means either a distinct route prefix or a separate destination/app.

### 2. QA channel — the coarse "channel gate" template

- Separate deployed app `tutorials-srv-qa` + separate HDI container `tutorials-hana-qa`, same codebase, CDS namespace `com.sap.developers.ims.qa`, separate publish key `CONTENT_API_KEY_QA`. Handlers instantiated per-namespace via `createContentHandlers({ namespace, apiKeyEnv })` (`content-store.js:2319`).
- Gate is **entirely at the approuter**: `xs-app.json` `/tutorials-qa/*` routes are `authenticationType: "xsuaa"` + `"scope": "$XSAPPNAME.Tutorial.Author"`, destination `srv-qa-api`. Access = assign the **"Tutorials Author"** role collection (`xs-security.json`).
- **Fit:** proves "same render pipeline, different channel, XSUAA-scope-gated at the edge." A private *event lane* could clone it: new prefix (`/tutorials-private/*`) → new scope (`Tutorial.Private`) → new namespace/app. **Coarse** — one scope = the whole channel, not per-tutorial or per-account.

### 3. SAGE preview backend — the fine "per-identity gate" template (closest precedent)

- New (2026-11) isolated CF app `tutorials-srv-sage` (MTA `mta-sage.yaml`, `path: gen/srv-sage`) over the **shared** `tutorials-hana` container (adopted `existing-service`). Mirrors the `srv-mcp`/`srv-qa` isolation pattern.
- **Auth:** `srv-sage/package.json` sets `cds.requires.auth = { kind: ias, xsuaa: true }` — IAS primary (public PKCE client `tutorials-sage-identity`), XSUAA fallback. Service is `@path:'/author' @requires:'authenticated-user'`.
- **Authorization is in-handler by caller identity** (`assertOwnership` / `provisionDbUser`) — a user sees only their *own* tutorials, because IAS tokens carry no XSUAA scopes. **This per-user in-handler check is exactly the mechanism "gate to specific accounts" extends.**
- **Rendering:** `POST /preview/render` (`srv-sage/preview-renderer.js`) shells out to a bundled Hugo against a `preview-site/` scaffold, rendering on the fly from author-pushed markdown — **content never persisted to the public store.** This "render a tutorial for a restricted viewer without publishing it publicly" is architecturally the core of private tutorials.
- **Fit:** start here for account-gated private tutorials. It already does isolated + authenticated + per-identity-scoped rendering; it does **not** yet do account-allowlist or geo/IP (gating today is "owner only").

### 4. Content keying — flat `slug` namespace, prefix convention

- `ContentCurrent` (key `slug`, the live serve table), `ContentHistory` (`version,slug`), `ContentManifest` (`version`) — `db/schema.cds:704-725`, aspects in `db/_content-shape.cds`. **No "kind" discriminator.**
- Kinds coexist by **slug prefix**: top-level pages are `page-<name>` (`page-browse`, `page-teched`), tutorials use bare slugs. Serve/publish select `.where({slug})` with no kind filter.
- **Fit:** a `private-<...>` prefix (or a per-event/per-account prefix), or a discriminator/visibility column on `ContentCurrentAspect`, both slot in cleanly. But `ContentCurrent` is the **public** serve table with no read gate — any private namespace needs its gate at serve/approuter, as in §2/§3.

### 5. Event ↔ tutorial relationship already exists (for the event use cases)

- **App Space** (`/app-space/?eventId=NNN`) is a per-event progress overlay, not a content namespace. The event→tutorial link is the `Events` → `Missions` → `CompletionPaths` → `CompletionPathItems` graph, keyed by `eventId` (`Events.legacyId`); backend `getAppSpaceProgress` (`srv/developer-service.js:640`). **Fully public** — personalizes via the caller's JWT but gates nothing.
- **`EventRegistrations`** (`db/devtoberfest.cds:71`, `{user, event, joinedAt, termsVersion}`) is the only **per-user event-membership** entity — closest existing "this user belongs to this event," though today it gates registration/terms, not content.
- **TechEd sessions** (`db/external/teched.cds`) are a public read-only RainFocus directory; no gating; not a reuse candidate.
- **Fit:** for "unlock these tutorials for attendees of event X," `EventRegistrations`-style membership is the natural authorization input to a SAGE-style in-handler check.

### 6. Enum / restriction precedents to copy

- Audience tier: `db/schema.cds:682` `audience : String(20) enum { ALL; AUTHENTICATED; ADMIN; }` (on alerts) — closest "audience tier" shape for a new `Tutorials.audience`/`visibility`.
- Private-vs-shared: `db/analytics-builder.cds:35` `visibility default 'private' enum { private; shared-admins }`.
- Row-level restriction: `@restrict` in `analytics-service.cds:146-152` (user-scoped SavedQueries) — the one existing per-user row filter; a model for per-account tutorial filtering.
- XSUAA machinery: add a `Tutorial.Private` scope + role collection shaped exactly like `Tutorial.Author` (`xs-security.json`).

### 7. Geo/IP — greenfield

- No geo/country/CIDR logic anywhere. IP is read only for rate-limiting/spam dedup, via `x-forwarded-for`: reusable extractor `clientIpFrom(req)` at `srv/lib/rate-limit/shared-limiter.js:70`.
- No `cf-ipcountry`/geoip/CIDR evaluation exists — country resolution and allow/deny is new work, best as an approuter extension (edge) or alongside the serve-time status check.

---

## Gating options (ranked)

| Option | Granularity | Reuse | Build cost | Best for |
| --- | --- | --- | --- | --- |
| **A. SAGE-style per-identity backend** | per-account / per-event-membership | High (clone `srv-sage` auth + preview-render) | Medium | **Gate to specific accounts.** CodeJams, invite-only labs. |
| **B. QA-style channel gate** | whole channel (one scope) | High (clone `srv-qa` + approuter scope) | Low | A coarse "private event lane" where everyone with the role sees everything in it. |
| **C. Approuter geo/IP fence** | by source IP/country | Low (only IP extractor exists) | Medium–High | On-site-only content; layer *on top of* A or B, never alone. |
| **D. Visibility flag on public serve path** | per-tutorial | Medium | Medium | Not recommended for sensitive content — keeps secrets in the public store/table and flips `/tutorials/*` to auth for everyone. |

**Recommended composition:** **A** as the core (isolated authenticated backend, in-handler allowlist keyed off an `EventRegistrations`-style membership), optionally fronted by **C** for on-site-only events. Use **B** when a whole invite-only channel is simpler than per-account logic. Avoid **D** for anything truly sensitive.

---

## Risks & design constraints

- **Edge-only gating is insufficient for secrets.** Every current channel trusts the serve handler. Private content with credentials needs **defense-in-depth**: the handler itself must re-check identity/authorization, not just the approuter route. (Platform posture today is edge-only — this is the one place private tutorials must diverge.)
- **Private source must not live in a public repo.** The authoring reuse story breaks if credentials sit in `sap-tutorials/*` public markdown — private tutorials need a private source repo (fetch-tutorials already supports private repos via token; the SAGE "push markdown, render on the fly, don't persist publicly" model avoids a public BLOB entirely).
- **Secrets are rotate-after-event.** Treat any credential shown in a tutorial as burned when the event ends; design for per-event ephemeral accounts, not durable secrets baked into content.
- **IAS tokens carry no XSUAA scopes** (per SAGE) — account-gating via IAS must be in-handler identity, not scope-based; scope-based gating (QA-style) uses XSUAA.
- **Geo/IP is advisory, not a security boundary** — XFF terminates at our own approuter and is spoofable before it; treat it as convenience fencing, always paired with real auth.
- House style: **DB feature flags, DEV-first, fail-open for public, fail-CLOSED for private** (a bug must not leak private content).

---

## Suggested next step (if pursued)

A time-boxed POC extending `srv-sage`: add an **allowlist/event-membership authorization check** (keyed off an `EventRegistrations`-style table) to the existing per-identity preview-render path, serving a non-persisted private tutorial to an invited account — proving account-gating end-to-end on the closest existing backend before deciding on channel (B) or geo (C) layers.
