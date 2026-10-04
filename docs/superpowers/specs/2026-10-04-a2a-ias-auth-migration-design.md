# A2A Agent Auth Migration: XSUAA client-credentials → SAP IAS

**Issue:** [#2593](https://github.com/sap-tutorials/tutorials-ims/issues/2593)
**Date:** 2026-10-04
**Status:** Design approved — ready for implementation plan
**Branch:** `feat/a2a-ias-auth-2593` (worktree: `.claude/worktrees/a2a-ias-auth`)

## Problem

The MCP signed-in tier (`/mcp-auth/*`) was migrated to SAP IAS (OAuth 2.1
auth-code + PKCE, public client) in PR #2592. The A2A agent (`POST /a2a`) was
intentionally left on the **old XSUAA client-credentials** flow — confirmed
still live on prod via its agent-card (`securitySchemes.xsuaa.flows.clientCredentials`,
scope `Tutorial.MCP`). This spec migrates A2A's token source to IAS.

### Why "mirror MCP exactly" does not apply

A2A is **machine-to-machine** (`POST /a2a`, no browser). The MCP migration
solved a *user* auth-code + PKCE redirect flow, which A2A has no equivalent of.
The honest IAS fit for M2M is **OAuth2 client-credentials** (SAP's documented
technical-user model) — a like-for-like swap of the token *source* (XSUAA → IAS)
while keeping the client-credentials *grant*. PKCE does not enter the A2A path.

## Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Auth model | **IAS client-credentials (secret)** | Lowest-risk, true like-for-like with what Central Joule consumes today; unblocks the XSUAA→IAS cutover. mTLS/X509 (secretless) is a later config swap. |
| IAS tenant | **`atxgsg7zi`** (`XSUAA_MCP_URL`) | Matches current MCP prod; keeps A2A and MCP on one tenant. (Issue noted a prior broken-federation note on `atxgsg7zi` resolved by switching to `alzmza7li`; user confirmed `atxgsg7zi`.) |
| Validation location | **In-process in the main `srv`** (A1) | Faithful mirror of how `srv-mcp` validates; keeps A2A in the main MTA. |
| Hybrid fallback | **`xsuaa: true`** on the IAS auth kind | Non-breaking, reversible cutover: XSUAA tokens keep working during transition. |
| `tokenUrl` source | **Derive from IAS issuer** (`<issuer>/oauth2/token`) | One source of truth, cannot drift; `ChatSettings.a2aTokenUrl` DB column becomes an optional override. |

## Current-state wiring (confirmed)

- **A2A route (approuter):** `approuter/xs-app.json:584-591` — `^/a2a/?$` →
  `srv-api`, `authenticationType:"xsuaa"`, `scope:"$XSAPPNAME.Tutorial.MCP"`.
- **A2A handler (main MTA):** `srv/server.js:1165` reserves `POST /a2a`;
  `srv/server.js:2233-2246` binds `makeA2aRouter()` through CAP `contextMw` +
  `authMw`. Anonymous reject at `srv/lib/a2a/rpc-router.js:43-46` (JSON-RPC
  `-32001` / HTTP 401), trusting `cds.context.user` from CAP auth.
- **Agent card builder:** `srv/lib/a2a/agent-card.js:32-52` (pure). Lines 44-47
  hardcode `securitySchemes.xsuaa` clientCredentials + `security:[{xsuaa:['Tutorial.MCP']}]`.
  Injected at `srv/server.js:1103-1111` via `resolveA2aSettings()` →
  `buildAgentCard({baseUrl, tokenUrl, enabled})`.
- **A2A config:** DB-driven, no env. `srv/lib/runtime-config/a2a-settings.js` →
  `ChatSettings` singleton (`a2aEnabled`/`a2aPublicBaseUrl`/`a2aTokenUrl`),
  `SETTINGS_ID = 00000000-0000-0000-0000-00000000c8a7`.
- **Main srv auth today:** NO `cds.requires.auth` kind — gated purely by the
  approuter XSUAA route. No in-process JWKS/issuer validator exists in `srv/`.
- **MCP IAS reference (the template):** `srv-mcp/package.json:28-31`
  (`auth:{kind:'ias',xsuaa:true}`, `@sap/xssec@^4.13.1`); approuter discovery
  `approuter/lib/well-known-oauth.js` (IAS branch keyed on `MCP_ISSUER_KIND=ias`,
  issuer from `XSUAA_MCP_URL`); IAS client `tutorials-identity` bound in
  `mta-mcp.yaml:74,84-100` (adopted `existing-service`, public/secretless).

## Target architecture (A1)

```text
A2A consumer (Joule / trusted BTP)
  → client-credentials exchange against IAS  <issuer>/oauth2/token  (client-id + secret)
  → POST /a2a  with  Authorization: Bearer <IAS access token>
    → approuter  ^/a2a/?$  authenticationType:"none"  → srv-api destination
      → main srv CAP auth {kind:'ias', xsuaa:true}  validates IAS bearer (xssec)
        → cds.context.user populated → rpc-router (anonymous reject unchanged)
```

The approuter stops minting the token (`xsuaa`→`none`, token-as-credential,
matching `/mcp-auth`). CAP's xssec IAS strategy validates in-process. `xsuaa:true`
keeps XSUAA bearers accepted during cutover.

## Changes

### 1. Config / binding (the real migration)

- **`srv` CAP config** — add `cds.requires.auth = { kind: 'ias', xsuaa: true }`
  (mirror `srv-mcp/package.json:28-31`). `@sap/xssec@^4.13.1` is **already** a
  main-srv dependency (root `package.json`), so no new dep is needed. The main
  srv currently declares **no** `cds.requires.auth` kind — this adds the first.
- **`mta.yaml` source + `.deploy/mta.yaml`** — bind `tutorials-identity` (existing
  IAS client, `existing-service`) to `srv-api` alongside `tutorials-xsuaa`.
  Confirm `srv-api` already carries `XSUAA_MCP_URL` / `MCP_ISSUER_KIND` or that
  the IAS issuer is otherwise resolvable in the main srv at runtime.
- **`approuter/xs-app.json:584-591`** — `/a2a` route `authenticationType:"xsuaa"`
  → `"none"`; remove the `scope` line. Destination stays `srv-api`.
- **IAS tenant** — stays `atxgsg7zi` via existing `XSUAA_MCP_URL`; no new env var.

> **Blast-radius note:** adding an `auth` kind to the main `srv` affects **every**
> service in the main MTA, not just `/a2a`. `xsuaa:true` keeps XSUAA tokens valid,
> so XSUAA-gated routes should be unaffected — but this MUST be verified by the
> full unit suite plus smoke against other main-MTA surfaces (admin UI, content,
> `/mcp-admin`) before merge. This is the single highest-risk change in the spec.

### 2. Agent card (`srv/lib/a2a/agent-card.js:44-47`)

- Replace `securitySchemes.xsuaa` with an IAS `clientCredentials` scheme keyed
  `ias`, `tokenUrl` → IAS `<issuer>/oauth2/token`. Update `security` to
  `[{ ias: [...] }]` with the appropriate IAS scope(s).
- Keep the builder **pure** — `tokenUrl` continues to be injected by the caller.

### 3. tokenUrl resolution (`srv/server.js:1103-1111` + `a2a-settings.js`)

- Derive `tokenUrl = <IAS issuer>/oauth2/token` from the resolved IAS issuer
  (same source `well-known-oauth.js:resolveIssuer()` uses — `XSUAA_MCP_URL`).
- `ChatSettings.a2aTokenUrl`, if non-empty, overrides the derived value (admin
  escape hatch). Document this precedence in `a2a-settings.js`.

### 4. Docs (3 files + 1 new row)

- **`srv/mcp/a2a-instructions.md`** (lines 17-19, 67) — XSUAA → IAS
  client-credentials; "OAuth Token URL" → IAS token endpoint.
- **`docs/end-users/a2a-quickstart.md`** (16-17, 53, 63-105, 177) — rewrite the
  token-exchange walkthrough for IAS client-credentials (client-id/secret against
  IAS `/oauth2/token`). Keep it M2M — no PKCE/interactive path.
- **`hugo/content/api-docs/_index.md`** (139-182, esp. 180) — A2A "### Auth"
  section → IAS. Mirror the IAS phrasing already used for `/mcp-auth`.
- **`hugo/data/api_endpoints.yaml`** — **add** an `/a2a` row (none exists today);
  mirror the `/mcp-auth/*` row shape, `auth` → IAS client-credentials. Then
  `node scripts/check-api-docs-drift.cjs` MUST pass.

## Testing

- **Unit (fast, in-memory):** `agent-card.js` builder test asserting the IAS
  scheme shape (`securitySchemes.ias`, `clientCredentials`, derived `tokenUrl`),
  and the tokenUrl-derivation + DB-override precedence in `a2a-settings.js`.
- **Drift:** `node scripts/check-api-docs-drift.cjs` → OK (row count +1).
- **Hybrid/smoke** (`npm run test:hybrid`, `test:smoke`, `test:e2e` as applicable):
  IAS token accepted on `/a2a`; XSUAA token still accepted (hybrid);
  anonymous still rejected `-32001`/401 with `WWW-Authenticate: Bearer`.
- **Non-interactive IAS validation against prod tenant** — as #2592 did for the
  MCP authorize endpoint: confirm the IAS `/oauth2/token` client-credentials
  exchange succeeds for the A2A client on `atxgsg7zi` (no `invalid_client`).
- **Line endings:** all touched files remain LF (Windows worktree — verify).

## Coordination / rollout

- **Central Joule & trusted-BTP consumers** — the token *source* changes
  (XSUAA → IAS `atxgsg7zi`). `xsuaa:true` hybrid means their existing XSUAA
  tokens keep working through the transition, but they must be told to re-point
  at the IAS token endpoint before XSUAA is removed. **Flag this in the PR** —
  do not remove XSUAA fallback until consumers confirm cutover.
- **Rollback:** revert the approuter route to `xsuaa` + restore the XSUAA
  security scheme in the card; the hybrid `auth` kind can stay (it accepts both).

## Out of scope

- Option B (IAS mTLS/X509 secretless) and Option C (forwarded user token /
  on-behalf-of). B is a later config swap enabled by this structure.
- Central Joule's own token-source change (coordinated, not implemented here).
- Homepage `/` flip and any non-A2A auth surface.
- Removing the XSUAA fallback (`xsuaa:false`) — a separate follow-up after
  consumer cutover is confirmed.
