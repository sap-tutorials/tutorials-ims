# HCQL Re-land Design (#2247)

**Date:** 2026-09-11
**Issue:** [sap-tutorials/tutorials-ims#2247](https://github.com/sap-tutorials/tutorials-ims/issues/2247)
**Decision:** Re-land HCQL (issue Option 1), scoped to the 5 authenticated services, on a CAP runtime bump.
**Supersedes:** the reverted approach in `#1002` (reverted by `#1004`).

## 1. Background

`#1002` enabled the CAP 10 HCQL ("CQL over HTTP") protocol adapter on 9 read
services via a central `srv/hcql-enablement.cds` that did
`annotate <Service> with @hcql`. It was reverted in `#1004` because **218 unit
tests failed**: HCQL co-mounted on each service's existing absolute OData
`@path` and greedily parsed request bodies/URLs as CQN, breaking normal OData
traffic (500s on write/action requests, 400s on `=`-carrying query params).
The docs (`docs/developers/reference/hcql-support.md`) were left in the tree and
still imply the feature ships — which is what #2247 is about.

## 2. Spike findings (verified 2026-09-11)

Reproduced against the pinned `@sap/cds@10.0.3`, and re-tested against
`@sap/cds@10.1.0` in an isolated throwaway CAP project.

### On the pinned 10.0.3 (current)
- Adding `annotate <5 authenticated services> with @hcql` reproduces the
  regression: sampled suite went **15/15 green → 8 failed**. Scoping to
  authenticated services does **not** help — the collision is per-path, not
  per-auth.
- `@hcql` does **not** mount at the documented `/hcql/<svc>` prefix
  (`POST /hcql/author` → 404). Instead it rides the service's own OData path
  (`POST /author` with a CQN body → 200), and breaks:
  - OData `$filter=… eq …` (the `=`/`eq` params)
  - read-only `PATCH` → **500** instead of 405
- `cds.env.protocols.hcql.path` defaults to `/hcql` but the adapter ignores it
  for absolute-`@path` services.

### On 10.1.0 (latest published) with plain `@hcql`
- OData `$filter` interception is **fixed** (`GET …$filter=… eq …` → 200).
- But HCQL **still** rides `/admin` (`POST /admin` CQN → 200), still no
  `/hcql/*` mount (404), and read-only `PATCH` → **500**. Plain `@hcql` is not
  enough on 10.1.0 either.

### On 10.1.0 with explicit per-service `@protocol` (the chosen mechanism)
Service configured as
`@protocol: [{ kind: 'odata-v4', path: '/admin' }, { kind: 'hcql', path: '/hcql/admin' }]`:

| Probe | Result | Meaning |
|---|---|---|
| `GET /admin/Books?$filter=title eq 'x'` | **200** | OData clean |
| `PATCH /admin/Books(1)` (read-only) | **405** | no HCQL interception on OData path |
| `POST /admin` with CQN body | **405** | OData path rejects CQN — full separation |
| `POST /hcql/admin` CQN | **200** `{"data":[]}` | HCQL works on its own path |
| `POST /hcql/admin` malformed CQN | **400**, server **alive** | **process-exit DoS is fixed in 10.1.0** |
| `GET /admin/Books?$top=1` after malformed | **200** | process survived |

**Conclusion:** the clean re-land requires BOTH (a) bumping the CAP runtime to
10.1.0 and (b) giving each enabled service an explicit `@protocol` list that
mounts HCQL on a distinct `/hcql/<svc>` path instead of colliding with the
OData `@path`.

## 3. Scope

Enable HCQL on the **5 authenticated services only**
(chosen by the maintainer on #2247):

| Service | OData path | HCQL path | Auth |
|---|---|---|---|
| `AdminService`         | `/admin`           | `/hcql/admin`         | XSUAA + `Admin` |
| `AuthorService`        | `/author`          | `/hcql/author`        | XSUAA + `Tutorial.Author` |
| `AnalyticsService`     | `/admin/analytics` | `/hcql/analytics`     | XSUAA + `Admin` |
| `ExportsService`       | `/admin/exports`   | `/hcql/exports`       | XSUAA + `Admin` |
| `ConsolidationService` | `/api/v1`          | `/hcql/consolidation` | XSUAA + `ConsolidationScope` |

**Out of scope (dropped from the original 9):** the 4 public/anonymous
services `KnowledgeGraphService` (`/graph`), `HomepageService` (`/homepage`),
`SearchService` (`/search`), `DeveloperService` (`/api`). Although the
malformed-CQN process-exit DoS is fixed in 10.1.0, exposing an unspecified beta
query surface anonymously is low value / needless risk; authenticated-only is
the conservative default.

`ExportsService` and `ConsolidationService` expose only actions/functions (no
queryable entities); HCQL `SELECT` returns no rows there. They are included for
symmetry and so the surface is uniform, matching the original intent.

## 4. Design

### 4.1 CAP runtime bump + package.json-wide dependency update (the dominant risk)

A CAP minor bump must not be piecemeal: the whole CAP plugin stack moves with
the runtime, and the maintainer has asked for a package.json-wide refresh
overall. This is done as a coordinated, phased update, each phase gated by the
full test suite so regressions are attributable.

**Prerequisite:** dependency operations hit the private `@sap-tutorials/*`
GitHub npm registry, so `NODE_AUTH_TOKEN` must be set (from `gh auth token`)
before `npm install` / `npm outdated`. In a worktree, edit-isolation blocks the
`$(gh auth token)` substitution — set the token in the environment first (or
run dep work from the primary checkout).

**Phase A — CAP ecosystem (compatibility-critical, required for HCQL):**
- `@sap/cds` `^10.0.3` → `^10.1.0`; `@sap/cds-dk` → `^10.1.x` (10.1.1 latest).
- Move the CAP plugin stack to latest versions compatible with cds 10.1:
  `@cap-js/{ai,attachments,audit-logging,change-tracking,data-inspector,graphql,hana,mcp,ord,sqlite,telemetry}`,
  `@cap-js-community/websocket`, `@cap-js/cds-test`, `cds-caching`,
  `cds-swagger-ui-express`, `@sap/xsenv`, `@sap/xssec`, `@sap-cloud-sdk/*`,
  `@sap-ai-sdk/*`, `@sap-tutorials/cds-alert-notification`.
- Several of these are **exact-pinned** (`@cap-js/mcp 1.1.1`,
  `@cap-js/graphql 0.14.0`, `@cap-js/attachments 4.0.0`,
  `@cap-js/data-inspector 1.0.5`, `cds-caching 2.0.2`, …). Pins are treated as
  deliberate: each is bumped consciously and cross-checked against the memory
  gotchas for that plugin (cds-caching store, mcp, graphql-shortcut, ai, hana).
- Align CAP version pins in `.deploy/mta.yaml`, `.cdsrc*`, CI Node config.

**Phase B — broader tree:** refresh remaining deps (aws-sdk, sharp, socket.io,
undici, cheerio, exceljs, ui5 webcomponents, vitest, playwright, esbuild,
vitepress, etc.) **within their current major only** (maintainer decision,
2026-09-11). Any major-version jump is explicitly out of scope for this PR and
deferred to a separate maintenance change — not swept in here.

**Gate for both phases:** commit the regenerated `package-lock.json`; full unit
+ hybrid suites green; `cds build --production` succeeds; Hugo/apps build
sanity. **Risk:** this is now a broad update across a production app with many
CAP plugins — behavior changes beyond HCQL are expected and triaged. If Phase A
proves too disruptive, this issue falls back to Option 2 (mark docs NOT
DEPLOYED) and the bump is deferred — that decision returns to the maintainer.

### 4.2 HCQL enablement via explicit `@protocol`
- **AdminService** already has `@protocol: [{kind:'odata'},{kind:'mcp', path:'/mcp/admin'}]`
  in `srv/admin-service-mcp.cds`. A service may carry only one `@protocol`, so
  HCQL is added to that existing list (not a second `annotate`):
  `@protocol: [{kind:'odata'}, {kind:'mcp', path:'/mcp/admin'}, {kind:'hcql', path:'/hcql/admin'}]`.
  The load-bearing object-form (per the file's own warning) is preserved.
- **The other 4 services** have plain `@path` and no `@protocol`. A central
  `srv/hcql-enablement.cds` adds, per service:
  `annotate <Service> with @protocol: [{kind:'odata', path:'<existing @path>'}, {kind:'hcql', path:'/hcql/<svc>'}];`
  The OData `path` MUST match the service's current `@path` exactly, or the
  OData URL moves and breaks every existing client.
- Object-form entries only — a bare-string array collapses all adapters onto
  one path and 404s OData (documented hazard in `admin-service-mcp.cds`).
- **Kill switch:** delete `srv/hcql-enablement.cds` (removes 4 services) and
  drop the `hcql` entry from AdminService's `@protocol` list; `cds build
  --production`; redeploy.

### 4.3 Approuter routing
- Add `/hcql/*` (or per-service `/hcql/admin`, …) routes to the approuter
  `xs-app.json` (root + `.deploy/` copy — keep both in sync), `authenticationType`
  matching the OData routes (XSUAA), JWT-forwarded to `tutorials-srv`.
- Verify against the documented Akamai constraints (POST bodies are fine;
  `/hcql/*` is a POST-only JSON surface so bare PATCH/DELETE verb issues don't apply).

### 4.4 Tests
New `test/unit/hcql-enablement.test.js` (unit, in-memory), asserting the
separation proven in the spike:
- OData path unchanged: `GET /<svc>/…$filter=… eq …` → 200; read-only
  `PATCH` → 405; `POST /<svc>` with a CQN body → 405 (OData rejects CQN).
- HCQL path works: `POST /hcql/<svc>` with a valid CQN `SELECT` → 200.
- Robustness: `POST /hcql/<svc>` with malformed CQN → 400 and the server stays
  up (no process exit).
- Auth inherited: unauthenticated `POST /hcql/<svc>` → 401; wrong scope → 403.

The previously-failing OData suites (author/analytics/admin/homepage/etc.) must
stay green — they are the regression canary.

### 4.5 Docs
- Rewrite `docs/developers/reference/hcql-support.md`: distinct `/hcql/<svc>`
  paths (not "same URL as OData"), authenticated-only 5-service table, requires
  `@sap/cds >= 10.1.0`, and replace the process-exit hazard section with the
  fixed-in-10.1.0 note (malformed CQN → 400).
- Update the CLAUDE.md Top-Gotchas HCQL pointer to match (distinct path,
  authenticated-only, 10.1.0, DoS-fixed).
- Restore the VitePress sidebar entry (`#1003`) if it was removed.

## 5. Acceptance criteria (from #2247, Option 1)
- [x] Decision recorded: re-land, authenticated-only, on CAP 10.1.0.
- [ ] Root cause of the 218-test regression documented (this spec §2) and fixed
      (explicit `@protocol` path isolation + CAP bump).
- [ ] `@hcql`/HCQL scoped to authenticated services only, never anonymous.
- [ ] Full unit + hybrid suites green.
- [ ] Docs updated to match reality.

## 6. Risks & open questions
- **CAP minor bump + dep-wide refresh blast radius** — primary risk (see §4.1).
  Full suites + build gate it, phased for attribution.
- **Decided (2026-09-11):** Phase B is within-major only; major bumps deferred.
- **`@protocol` path exactness** — the OData `path` in each new `@protocol`
  list must equal the current `@path`; a repo-wide check of each service's
  `@path` is part of implementation.
- **cds-dk vs cds version skew** — pin both to 10.1.x; cds-dk 10.1.1 is the
  latest published, cds runtime 10.1.0.
- **Hybrid/HANA validation** — the spike ran on SQLite in-memory; hybrid tests
  against real HANA must confirm nothing HANA-specific breaks under 10.1.0.
