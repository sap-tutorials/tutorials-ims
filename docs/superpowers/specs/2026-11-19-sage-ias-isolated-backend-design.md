# Design: SAGE IMS auth via isolated IAS-authenticated backend (`srv-sage`)

**Date:** 2026-11-19
**Status:** Draft for approval
**Size:** Project (cross-repo: tutorials-ims backend + SAGE extension + IAS provisioning)
**Supersedes the auth approach in:** 2026-11-19-pkce-public-client-design.md (that fix shipped in SAGE 2.0.4 but cannot work — see Root cause)

## Intent / why

SAGE 2.0.4 removed the embedded PROD XSUAA secret and switched IMS sign-in to secret-less PKCE against the XSUAA client `sb-tutorials-prod!t676072`. **It cannot authenticate**: XSUAA returns `401 invalid_client / "Bad credentials"` because the XSUAA `application` plan **cannot be a public client** (broker rejects `public-client`/`_pkce_s256`; confirmed by the tutorials team 2026-09-29, `mta-mcp.yaml:64`). The tenant OIDC metadata confirms it: `token_endpoint_auth_methods_supported` = `["client_secret_basic","client_secret_post","tls_client_auth"]` — no `"none"`.

We must restore IMS sign-in for SAGE **without** re-embedding a secret and **without** modifying the main `tutorials-srv` XSUAA auth model (route-scoped IAS trust on that app was already reverted once for breaking every XSUAA browser route — `srv/server.js:2317-2320`).

**Chosen approach:** give SAGE its own isolated backend (`srv-sage`) + its own IAS public client, exactly mirroring how the MCP surface was isolated (`tutorials-srv-mcp`). SAGE authenticates to IAS via public PKCE (which IAS *can* do, XSUAA cannot) and calls `srv-sage`, which serves a minimal author surface over the shared HANA container under `kind: ias` auth.

## Goals

- SAGE signs in with secret-less PKCE (public client) — no secret in the VSIX, ever.
- SAGE's 5 backend operations work end-to-end against the shared tutorial data.
- Zero change to `tutorials-srv`'s XSUAA auth model or its browser/PAT/platform routes.
- Author-level authorization preserved (a user only sees/edits their own tutorials).

## Non-goals

- No change to the main app's `/author` service, `server.js`, content-store, websockets, scheduler.
- No AI variant generation, content rebuild, GitHub, or credstore in `srv-sage` — SAGE never calls those (verified: `rebuildContent`/`generateOsVariants` have zero call sites in the extension).
- Preview (`POST /preview/render`) is **in scope**, moved from the srv-qa host into `srv-sage` (its renderer is portable; see Open questions #1). SAGE will hit one isolated IAS surface for everything.
- No git-history scrub of the (already-rotated, dead) 2.0.4 secret.

## Anti-goals

- Do NOT re-introduce any client secret into the extension.
- Do NOT enable IAS trust on the main `tutorials-srv` `/author` path (the reverted approach).
- Do NOT attempt `public-client: true` on any XSUAA descriptor (broker rejects it).

## Constraints / key facts (from investigation)

- SAGE's **entire** backend surface = 5 lightweight AuthorService ops, all plain HANA read/update, no heavy deps:
  | SAGE feature | Op | R/W |
  |---|---|---|
  | My Tutorials panel | `GET MyOwnedTutorials` | read |
  | Tag autocomplete | `GET Tags` (OData `$filter/$top/$skip/$count`) | read |
  | Slug check | `isSlugAvailable {slug}` | read |
  | Mark reviewed | `reviewTutorial {tutorialId}` | write |
  | Snooze (defined, no prod caller) | `snoozeTutorial {tutorialId,days}` | write |
- Isolation pattern is proven 3× (`srv-mcp`, `srv-qa`): a dedicated `.cdsrc.json` build task (`model: ["srv-sage","db"]`), shared HANA adopted as `existing-service`, thin `server.js`, own MTA.
- Auth-gate pattern is proven by `srv-mcp`: `auth: { kind: ias, xsuaa: true }` (hybrid) + `@requires: 'authenticated-user'` (NOT the XSUAA `Tutorial.Author` scope, which IAS tokens can't carry). AuthorService already does the *real* authorization in-handler by caller identity (`assertOwnership`, `provisionDbUser` scoping) — that survives the switch. This is the enabling fact.
- IAS public client exists today (`tutorials-identity`, tenant `atxgsg7zi.accounts.ondemand.com`); its `public-client: true` is set out-of-band via `cf update-service`, not in version control. SAGE needs a `vscode://sap-tutorials.sage-tutorial-extension/**` redirect URI added to an IAS app (currently XSUAA-only).
- OData action path ambiguity: SAGE source calls `/author/reviewTutorial`; unit tests assert `/author/AuthorService.reviewTutorial`. `srv-sage` must serve whatever the shipped extension actually calls; pin by inspecting the built `out/` of the deployed build, and align the extension client to the canonical CAP action-import path.

## Approaches considered

- **A. Isolated `srv-sage` IAS app (CHOSEN).** Own IAS public client + own CAP app + own MTA; minimal author surface; `@requires:'authenticated-user'` + existing in-handler ownership. Full security isolation; zero blast radius on the main app. Cost: a new (thin) deployable + IAS client provisioning. Chosen because it mirrors the team's own proven answer (MCP) and never touches the twice-fragile main-app auth.
- **B. Backend token-exchange proxy on `tutorials-srv`.** Smaller build, but couples SAGE to the main app and adds an endpoint that custodies the XSUAA secret server-side. Rejected in favor of full isolation (user's explicit preference for an isolated security setup like MCP).
- **C. IAS trust on main `tutorials-srv` `/author`.** Requires issuer trust + IAS→`Tutorial.Author` role mapping on a path whose IAS trust was already reverted for breaking browser routes. Highest blast radius. Rejected.
- **D. Revert to embedded secret.** Re-introduces the vulnerability. Rejected.

## The build (what the implementer does)

Cross-repo. Order matters: backend + IAS first (so there's something to authenticate against), then the extension flip.

### Part 1 — `tutorials-ims` repo: new `srv-sage` app
1. `srv-sage/` dir: thin `server.js` (copy `srv-mcp/server.js` shape, drop the `/mcp-auth` rewrite); `package.json` with `cds.requires.auth = { kind: ias, xsuaa: true }`, `db: { kind: hana }`.
2. `srv-sage/author-sage-service.cds`: a SAGE-scoped service `using { com.sap.developers.ims } from '../db/schema'` (+ `../db/views` for `MyOwnedTutorials`), exposing ONLY the 5 ops, gated `@requires: 'authenticated-user'`. Do **not** `using { AdminService }` (that's only needed for the dropped `rebuildContent`).
3. Port handler logic from `srv/author-service.js` for those 5 ops: the `MyOwnedTutorials` caller-scoped read, `Tags` read, `isSlugAvailable`, `reviewTutorial`, `snoozeTutorial`, plus `assertOwnership`/`provisionDbUser`/`resolveDbUser` identity resolution (bundle `resolve-db-user` the way `scripts/bundle-shared.cjs` bundles for srv-mcp). No AI/GitHub/credstore imports.
4. `.cdsrc.json`: add build task `{ "for":"nodejs", "src":"srv-sage", "dest":"srv-sage", "options": { "model": ["srv-sage","db"] } }`.
5. `mta-sage.yaml` (new MTA): module `tutorials-srv-sage` (`path: gen/srv-sage`); adopt `tutorials-hana`, `tutorials-identity` (IAS), `tutorials-xsuaa` (hybrid fallback) as `existing-service`; approuter route for SAGE if needed. (credstore/destination NOT needed — no secret-backed actions.)
6. Provision SAGE's IAS public client (own instance or reuse `tutorials-identity`) and add the `vscode://…` redirect URI additively via `cf update-service` (owned by Tom; documented, not scripted into VCS — matches `ias-setup.md`).

### Part 2 — SAGE extension repo
7. Repoint `imsAuth.ts` from the XSUAA tenant to the IAS tenant: `authUrl`/`tokenUrl` → `https://<ias-tenant>/oauth2/authorize` + `/oauth2/token`; `clientId` → SAGE's IAS public clientid. Keep PKCE + `state` (both already correct for a public client).
8. Repoint `imsApiClient.ts` base URL to the `srv-sage` app host; confirm the action-import path matches what `srv-sage` serves.
9. Bump version (2.0.5), CHANGELOG/RELEASE-NOTES.

## Verification (before claiming done)

- Live probe from Tom's machine: secret-less PKCE token exchange against the **IAS** endpoint returns a token (not `invalid_client`).
- `srv-sage` deployed to DEV; SAGE (pointed at DEV) completes sign-in AND all 5 ops return real data (My Tutorials shows the author's tutorials — not 0, cf. the known "author join returns 0 for non-browser-logged-in users" gotcha).
- Main-app regression check: XSUAA browser routes on `tutorials-srv` unaffected (separate MTA, so structurally isolated — confirm by smoke test).
- Unit tests for any new `srv-sage` handlers + the extension's changed auth/client.

## Open questions for Tom

1. **Preview** (`/preview/render`) — **RESOLVED: serve it from `srv-sage` too.** Recon confirmed the current srv-qa route is XSUAA-scope-gated (`requireXsuaaScope('Tutorial.Author')` in `srv-qa/xsuaa-scope-middleware.js`) and srv-qa binds no IAS, so an IAS token gets 401/403 — preview breaks under the switch just like `/author`. Rather than bolt IAS onto srv-qa's bespoke middleware, move the route into `srv-sage`: `srv-qa/preview-renderer.js` (194 lines) depends only on Node builtins + a local `./lib/parsers.bundle.mjs` (no srv-qa/XSUAA coupling), so it ports cleanly. All SAGE traffic then hits one isolated IAS surface.
2. **IAS client:** **DECIDED — dedicated SAGE IAS public-client instance** (audience isolation; SAGE tokens aud-scoped to SAGE, separate from MCP's `tutorials-identity`). Provision its own `identity` instance + `vscode://sap-tutorials.sage-tutorial-extension/**` redirect URI.
3. **Rollout:** **DECIDED — DEV + testing-release first.** Deploy `srv-sage` to DEV, cut SAGE 2.0.5 as `latest-testing` pointed at DEV, verify the full round-trip (sign-in + all 5 ops + preview returning real data), THEN stable PROD `srv-sage` + stable 2.0.5.

## Critical client constraint (from PR #2707)

SAGE must send the IAS **`id_token`** (a JWT with a usable `aud`) as the Bearer — **not** the opaque IAS `access_token`. `@sap/xssec kind:ias` validates `aud === clientid`; the access_token won't validate. The extension's `imsAuth.ts` currently stores/returns `tokenResponse.access_token`; for IAS it must return `id_token`. This is a required change in `createSessionFromToken`/`getAccessToken`.

## Delivery

- `tutorials-ims`: feature branch → PR → DEV (never direct to main/PROD; this repo's PRs target DEV).
- SAGE: feature branch → PR → `main`.
- Both signed commits. No prod deploy without explicit go-ahead + the live sign-in verification.
