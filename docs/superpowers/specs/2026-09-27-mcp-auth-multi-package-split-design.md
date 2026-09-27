# MCP Auth Multi-Package Split — Design

**Date:** 2026-09-27
**Author:** Thomas Jung (with Claude)
**Status:** Draft for review

## Problem

External developers cannot authenticate to the tutorials MCP endpoint. `mcp-remote`
launches the browser, the user authorizes, an auth code is returned — then the
token exchange fails with `invalid_client` / "Bad credentials".

Root cause: `sb-tutorials-prod!t676072` is a **confidential** XSUAA client. XSUAA
allows exactly one OAuth client per instance, and it requires a `client_secret` at
the token endpoint. `mcp-remote` sends PKCE only (no secret), so XSUAA rejects the
exchange. The redirect URI is not the problem — `http://localhost:*/oauth/callback`
is already allowlisted.

Distributing a client secret to every external user is not viable, so the client
must become **public** (PKCE, no secret). Because there is one client per instance,
and the existing `tutorials-xsuaa` instance is the confidential login client for the
approuter/admin UI, the public client must live on a **separate XSUAA instance**.

## Goals

1. External developers connect via `mcp-remote` using **PKCE only, no client secret**.
2. The approuter's confidential login flow (admin UI, all existing services) is
   **unchanged**.
3. First deliberate step of a broader modularization strategy: separate service
   instances now, potentially separate MTAs later, for maintainability and
   independent scaling. Retire the `srv-qa` copied-lib drift tax while we are here.

## Non-goals

- Homepage `/` flip, IAS migration, or changing the anonymous `/mcp/*` and
  `/mcp-pat/*` tiers.
- Granting `Tutorial.MCP` as a custom scope. "Any authenticated developer" means the
  MCP auth tier gates on `authenticated-user` (logged-in is enough); XSUAA has no
  mechanism to auto-grant a custom scope to all users, and we do not want per-user
  role-collection assignment for baseline MCP.

## Decisions (with rationale)

### D1. Dedicated MCP CAP module + dedicated public XSUAA instance (Option A3)

Rejected alternatives:
- **In-place flip** of `tutorials-xsuaa` to public — strips the approuter's secret. No.
- **Two xsuaa bindings on `tutorials-srv`** — CAP Node's `xsuaa` auth strategy
  resolves a single credentials set; accepting two issuers on one module is
  undocumented on Node and risks breaking validation of existing tokens
  (whole-backend 401). Rejected on the "must not break anything else" bar.

Chosen: a new `tutorials-srv-mcp` CAP module bound to a **single** new public
instance `tutorials-xsuaa-mcp`. Each app validates exactly one issuer → zero binding
ambiguity. Models on the proven in-repo `srv-qa` separate-module pattern. This is
also a clean seam for eventual extraction into its own MTA/repo.

### D2. CAP validates the token; approuter stops gating `/mcp-auth`

Trace established that CAP validates the XSUAA JWT itself (xsuaa strategy,
`@sap/xssec` v4) and that `DeveloperService` MCP handlers already
`@requires: 'authenticated-user'` (`srv/developer-service-mcp.cds:5-6`). The custom
`Tutorial.MCP` scope is enforced **only** at the approuter route today. So:

- Approuter `/mcp-auth/*` route: `authenticationType: xsuaa` → **`none`** (matches
  `/mcp/*` today), target → `srv-mcp-api`.
- CAP (`tutorials-srv-mcp`) validates the public token and enforces
  `authenticated-user`.
- Approuter login flow: untouched.

### D3. Multi-package npm workspace (retire the copy tax)

The `srv-qa` module today copies ~150 files from `srv/lib` via a hand-curated `cp`
block (`.deploy/mta.yaml:191`) — a repeatedly-broken drift foot-gun. Replace copying
with a workspace of published-internally packages consumed via `package.json` deps.

Package boundaries (from dependency-closure traces):

- **`packages/core`** — domain/runtime utils with no feature opinion. Consumed by
  every module. Includes: secret-resolver, credstore, legacy-id, metrics, alerting,
  feature-flags/*, runtime-config leaves, markdown, tag utils, embedding-client,
  chat-settings-resolver, resolve-tutorial-author, safe-fetch, `jobs/job-lock`,
  `branch/slug-key`, etc.
- **`packages/content`** — content-store/publish/catalog/render/media pipeline.
- **`packages/mcp`** — `mcp-developer-tools`, `mcp-arg-validators`,
  `mcp-progress-store`, `tutorial-step-slicer`.
- **`packages/kg`** — `srv/lib/kg/*` + root `kg-*.js` (main-srv consumer).
- **`packages/channels`** — `srv/lib/channels/*` + channel/media-diet libs
  (main-srv consumer).

Layering: `core` depends on nothing; feature packages depend only on `core`, never
each other. A boundary lint enforces no feature→feature imports.

### D4. `complete_step` cross-service emit → best-effort

The MCP `complete_step` tool shares the completion handler that emits WS fan-out via
`EventStreamService` + `DisplayService` (`srv/developer-service.js:780-789`, under
`cds.User.privileged`). In a standalone `srv-mcp` those services are not mounted.
Wrap the `cds.connect.to(...)` emit in a guard: if unreachable, log and continue.
Progress writes still succeed; live-monitor fan-out from the MCP path is a
nice-to-have, not correctness. Keeps `srv-mcp` thin and independently extractable.

## Architecture

```text
db/schema.cds  ── shared CDS model (referenced by build model paths, not copied)

packages/            npm workspace (consumed via package.json deps — no cp)
  core/     ← everyone
  content/  ← srv, srv-qa
  mcp/      ← srv, srv-mcp
  kg/       ← srv
  channels/ ← srv

Modules:
  tutorials-srv       → tutorials-xsuaa      (confidential)  UNCHANGED login flow
  tutorials-srv-qa    → tutorials-xsuaa      (confidential)  cp block retired → deps
  tutorials-srv-mcp   → tutorials-xsuaa-mcp  (PUBLIC/PKCE)   NEW; serves /mcp/api

MTAs:
  mta.yaml            (existing three-module set)
  mta-mcp.yaml        NEW → tutorials-srv-mcp + tutorials-xsuaa-mcp

Approuter (xs-app.json):
  /mcp-auth/*  authType xsuaa → none ; target srv-mcp-api
```

### `tutorials-srv-mcp` contents

- Own thin `package.json` (deps: `@cap-js/mcp@1.3.0`, `@sap/cds`, `@sap/xssec`,
  `@cap-js/hana`, `packages/core`, `packages/mcp`; `cds.requires.auth.kind: xsuaa`,
  `db.kind: hana`).
- Own thin `server.js`: only the `/mcp-auth`→`/mcp` rewrite (subset of
  `srv/server.js:1187-1193`) + the `MCP_AUTH_ENABLED` kill switch (1172-1176).
  `@cap-js/mcp` auto-mounts `/mcp/api` at bootstrap — no hand-mounting.
- CDS: fork of `developer-service.cds` + `developer-service-mcp.cds`, trimmed to the
  MCP surface, projecting on the full shared `db/schema.cds` (build
  `model: ["srv-mcp", "db"]`).
- Binds shared prod `tutorials-hana` + `tutorials-credstore` (for secret-resolver) +
  new `tutorials-xsuaa-mcp`.

### `tutorials-xsuaa-mcp` (new resource)

`xs-security-mcp.json`: `xsappname: tutorials-mcp`, `tenant-mode: dedicated`,
`oauth2-configuration`: `public-client: true`,
`grant-types: [authorization_code, authorization_code_pkce_s256, refresh_token]`,
`redirect-uris` including `http://localhost:*/oauth/callback` and the vscode/dev-portal
URIs. Scopes: a `Tutorial.MCP` scope may be *defined* for optional elevated tooling,
but the auth tier does **not require** it — baseline MCP gates on `authenticated-user`
only (consistent with the non-goal). No per-user role-collection assignment is needed
for baseline access.

### `.well-known` OAuth discovery

`approuter/lib/well-known-oauth.js` advertises fully-qualified scopes and the issuer;
it must reflect the **new** `tutorials-mcp` xsappname/issuer so `mcp-remote`
discovery points at the public instance. Verify and update.

### mcp-remote client config (end state)

```
npx -y mcp-remote https://developers.sap.com/mcp-auth/api \
  --static-oauth-client-info '{"client_id":"sb-tutorials-mcp!t<INSTANCE_SUFFIX>"}' --host localhost
```
No secret. Self-service with client_id + URL only. (`<INSTANCE_SUFFIX>` is assigned by
XSUAA when `tutorials-xsuaa-mcp` is created — read it from the service binding.)

## The content-store cycle (must fix during content carve)

`content-store.js` ⇄ `content-publish-session.js` ⇄ `embedding-pipeline.js` ⇄
`recompute-tutorial-progress-bulk-sql.js` form an intra-`content` require cycle via
`toBuffer` / `recomputeTutorialProgress`. Not cross-package (layering stays acyclic),
but these four cannot be split apart. Fix: extract `toBuffer` (and the
`recomputeTutorialProgress` re-export) into `packages/core` (e.g. `core/buffers.js`)
to break the cycle cleanly before/while moving content files.

## Phasing (one branch, independently-verifiable phases)

**P1 — workspace + `core`.** Create npm workspace; carve `packages/core`; point
`tutorials-srv` at it. Existing `npm test` stays green. Add boundary lint.

**P2 — `content`, `mcp`, `kg`, `channels`.** Carve remaining packages. Fix the
content-store cycle. `kg`/`channels` require a **main-srv** import-graph trace +
de-cycle (their live edges are not exercised by srv-qa) — treat as a plan
prerequisite for those two packages. Existing tests green after each.

**P3 — `tutorials-srv-mcp` + `mta-mcp.yaml` + `tutorials-xsuaa-mcp`.** Stand up the
module consuming `core`+`mcp`; new MTA; new public instance; approuter
`/mcp-auth` → none. Best-effort `complete_step` emit.

**P4 — retire srv-qa copies (point of no return, own gate).** srv-qa's cp block is
~90 files of dead weight + ~55 live files now provided by packages. Delete the block;
srv-qa consumes `core`+`content`. srv-qa hybrid + smoke must be green before merge.

## Testing & acceptance

- Per-phase: `npm test` green; package-boundary lint (no feature→feature imports).
- **Primary acceptance (Tom's #1 rule — test the actual thing):** `mcp-remote`
  connects to the deployed `/mcp-auth/api` with **PKCE only, no secret**, and an MCP
  tool call (e.g. `get_my_tutorials`) succeeds as the authenticated user.
- P3: hybrid test against real HANA + `tutorials-xsuaa-mcp` binding.
- P4: srv-qa hybrid + smoke green post-cp-removal.
- Deploy to **DEV first** (main protected, PRs target DEV, no main-hotfix path);
  verify before any prod cutover.

## Risks

- **R1 — main-srv kg/channels de-cycle (P2).** Their real edges are only in the
  larger, cyclier main-srv graph; carving may surface feature→feature edges the
  srv-qa slice hid. Mitigation: dedicated trace as plan prerequisite; boundary lint.
- **R2 — P4 touches the working srv-qa build.** Mitigation: mostly deletion of dead
  copies; isolated phase with its own green-gate; DEV-first.
- **R3 — `.well-known`/issuer mismatch** breaks `mcp-remote` discovery. Mitigation:
  explicit verify step; PKCE e2e is the acceptance test.
- **R4 — Windows CRLF flips** on large multi-file moves (known worktree hazard).
  Mitigation: `file` check + Node normalize before commit.
- **R5 — implementation via subagent fan-out** risks scope overrun. Mitigation:
  subagent-driven-development with per-task scope, final whole-branch review, PR to
  DEV (subagent review ≠ PR review).

## Implementation approach

After spec + implementation plan are approved: subagent-driven-development fan-out,
one task per package/phase, final whole-branch review, `gh pr create` targeting DEV.
