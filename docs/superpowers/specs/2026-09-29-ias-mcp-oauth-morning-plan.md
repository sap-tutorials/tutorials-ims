# MCP OAuth via IAS — Decision Plan (morning briefing, 2026-09-29)

**For:** Tom · **Author:** overnight autonomous session · **Status:** research complete, POC gated on your go

## One-paragraph situation

XSUAA **cannot** issue a public/secretless PKCE client on this landscape — proven empirically (broker rejects `public-client`, the `_pkce_s256` grant, and `credential-types:none`; the confidential-client "omit the secret" fallback returns `invalid_client` at the token endpoint). So the OAuth-for-MCP requirement (which must exist *alongside* the already-shipped PAT path) needs a different issuer. **IAS is that issuer** — it supports public/PKCE OIDC apps, is already an active trust on the subaccount (`atxgsg7zi.accounts.ondemand.com`), and is entitled (`identity`/`application` plan, free). #2506 (branded login) is a *separate* lever (user-IdP federation) and does **not** fix MCP — do not couple them, though the MCP work warms up #2506's prerequisites.

## The decision hinges on ONE measurement (M1)

The entire authenticated data model + NGDS badge crediting keys on `Users.sapId`, resolved from the token's **`user_uuid`** claim (`packages/core/resolve-db-user.js:52`, via `@sap/xssec` `token.userId`). It is stored to `Users.sapId` on provision and later re-tested by the NGDS gate `^[PSIps]\d{6,}$` (`srv/lib/ngds-autosend.js:40`).

**M1 (red/green light):** decode a real **IAS** token for a known migrated user and confirm all three —
1. claim key is literally `user_uuid`,
2. value === that user's existing XSUAA `user_uuid` / current `Users.sapId`,
3. value matches `^[PSIps]\d{6,}$`.

- **GREEN** → IAS-for-MCP is a small, isolated, reversible change (see POC below). Full-migration path is plausible later.
- **RED** (IAS emits the SAP id under a different claim — `sub`/`scim_id`/email) → `resolveUserSapId` falls through to `user.id` (email), silently orphaning ~797k users' progress and silently dropping NGDS badges (no HANA-level UNIQUE on `sapId` — schema.cds:157 is a CAP-runtime-only check, bypassed by the direct `cds.db` insert). Then IAS-for-MCP becomes a **project** (claim-mapping branch + 797k-row reconcile + HANA UNIQUE hardening + NGDS-gate rework), not a flip.

M1 needs a real IAS token — **not** a full deploy. Cheapest form: register the IAS app, get one token for a known user, decode it. That is the whole gate.

## Recommended POC (small, isolated, reversible) — gated on your go

Scope: **srv-mcp ONLY, hybrid, DEV only.** Never touches `tutorials-srv` browser routes or PROD.

1. `cf create-service identity application tutorials-identity-mcp` *(create-op — needs your explicit go; free plan)*
2. Register an IAS OIDC **public/PKCE** app in the `atxgsg7zi` tenant with mcp-remote loopback redirect URIs. *(likely needs IAS admin-console access)*
3. **M1 measurement** — obtain one IAS token for a known migrated user, decode, check the three conditions above. **This is the gate — stop here if RED.**
4. If GREEN: bind `tutorials-identity-mcp` to srv-mcp, flip `srv-mcp/package.json` auth `{"kind":"xsuaa"}` → `{"kind":"ias","xsuaa":true}` (hybrid — keeps existing XSUAA/`mcp-remote` bearer + admin working), repoint `.well-known` discovery at the IAS issuer, redeploy the mcp MTA.
5. Run mcp-remote PKCE against `/mcp-auth/api` end-to-end (the interactive browser leg — **needs you**).

**Rollback:** one-line auth-kind flip back to `{"kind":"xsuaa"}` + redeploy. No data migration in the POC.

## What I need from you (the human-only steps)
- **Authorize `cf create-service identity …`** (a new managed instance; free, but a create-op I won't do unattended).
- **IAS admin-console access** to register the OIDC app (or confirm you'll do that step).
- **~2 interactive browser logins** (M1 token capture + the final mcp-remote PKCE run).

## What I did autonomously overnight (all safe/reversible)
- Proved the XSUAA dead-end (both avenues) — see commit `411e26b63` + this session.
- **DEV cleaned to healthy:** deleted orphaned `tutorials-xsuaa-mcp`; srv-mcp bound to `tutorials-xsuaa`, 1/1; approuter env at corrected `eu10` values. Branch `worktree-mcp-xsuaa-public-client` pushed, **unmerged**, no PR (its fix served the abandoned XSUAA-OAuth path).
- Confirmed `identity` entitlement (free) + active IAS trust + the exact claim-resolution code path.
- Wrote the full impact analysis: `docs/superpowers/specs/2026-09-29-ias-migration-impact-research.md`.

## Open questions the POC answers (from the research doc)
- **M1** (above) — the one that matters.
- Does `ias`+`xsuaa:true` hybrid accept BOTH token types on one srv-mcp route?
- Does the IAS `application` plan need mTLS (`cert.*`/x5t) through the approuter `authenticationType:none` passthrough?
- Do IAS tokens (which carry NO scopes) still pass any `@requires:` scope checks, or need AMS/XSUAA-for-scopes?

## Doc-drift note to fix regardless
Repo docs disagree on the current IdP. Live truth (`btp list security/trust`): two active trusts — `sap.default` AND the `atxgsg7zi` IAS tenant. And `docs/end-users/mcp-quickstart.md` still claims "secretless PKCE OAuth works" — **false** per this session's proof; correct it.
