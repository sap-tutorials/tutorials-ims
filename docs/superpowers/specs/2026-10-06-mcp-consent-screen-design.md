# MCP OAuth Consent Screen ("Application Access Request") — Design Spike

**Date:** 2026-10-06
**Status:** Research / spike proposal (no code written) — open questions RESOLVED by Tom 2026-10-06
**Author:** Design spike for Tom
**Related:** `2026-09-29-mcp-oauth-design-spec.md`, `2026-10-04-a2a-ias-auth-migration-design.md`, `docs/developers/architecture/mcp-server.md`

## Problem

Other SAP MCP servers (e.g. "Knowledge@SAP MCP Server", fronted by Joule Work
Desktop) show a browser **"Application Access Request"** consent screen during
the OAuth authorization-code flow, before issuing a token. The reference screen:

- Headline: *"<Client App> is requesting access to <MCP Server>. Please ensure
  you recognise the callback address below."*
- A read-only panel: **Application ID** (the OAuth `client_id`) and
  **"Credentials will be sent to"** (the OAuth `redirect_uri`, e.g.
  `http://localhost:18766/mcp-callback`) — a phishing/mis-redirect check.
- The three **independent acknowledgement checkboxes** the user must tick. **Copy
  is BYTE-IDENTICAL to the other SAP MCP tools' screen**, substituting only the
  service name (`<MCP Server>` → "SAP Developers MCP"):
  1. *"I acknowledge that SAP Developers MCP is powered by AI."*
  2. *"I acknowledge that I remain responsible for code compliance and security,
     must verify all results, continue using mandatory tools and processes."*
  3. *"I acknowledge to not enter any personal data."*
- **Allow Access** / **Deny** buttons.

We want the same for the tutorials-ims MCP server (`developers.sap.com`).

## Why config-only (IAS) cannot deliver this

Verified live in the IAS admin console (tenant `atxgsg7zi`, 2026-10-06). IAS's
only native consent mechanism is, per app, under **Authentication and Access**:

- **Terms Of Use** — one radio-selected legal document (e.g. `DEVELOPERS_SAP_COM`),
  shown **at user registration / after an upgrade**, with a single implicit accept.
- **Privacy Policy** — an additional read-only legal-document link.

Gaps vs. the reference screen (all confirmed, not inferred):

1. **Not per-authorization.** Terms of Use fires at *registration/first-logon*,
   not on each MCP-client authorize request. A user with a live IAS SSO session
   is **not** re-prompted — so it is not a reliable per-client access gate.
2. **No independent checkboxes.** One accept-the-document action, not three
   separate AI/compliance/PII acknowledgements. (You can concatenate the three
   statements into one ToU doc, but it collapses to a single checkbox.)
3. **No OAuth client context.** ToU has no `client_id` / `redirect_uri` display —
   the "recognise the callback address" phishing check is impossible.
4. **Child apps are partly read-only.** The `tutorials-*` IAS apps inherit from
   the SAP-managed "SAP Developers" bundled app and warn that some settings are
   read-only.

**Conclusion:** the reference UX is only achievable by **self-hosting the
authorization-server consent step** — Option B below.

## Architecture: a stateless consent-proxy authorization server

The approuter already fronts the OAuth discovery docs and delegates the actual
`/authorize`+`/token` to the IdP. Option B inserts **our own `/authorize`** that
renders the consent HTML, then brokers the real IdP handshake behind it.

**Precedent — reuse the GitHub-OIDC-shim blueprint.** `approuter/lib/github-oidc-shim.js`
is an existing, shipped, hand-rolled OAuth endpoint set in the same approuter
middleware chain. The consent proxy copies its proven patterns 1:1:

- Mounted in `approuter/server.js` `insertMiddleware.first`, BEFORE the
  static/proxy handlers, next to `wellKnownOAuthHandler` (`server.js:598`), so it
  runs on the unauthenticated seam and short-circuits its own paths
  (`writeHead/end`, no `next()`).
- **Stateless across approuter instances.** The authorize→callback correlation
  (client PKCE challenge, client `redirect_uri`, client `state`, our own
  IdP-leg PKCE verifier) is sealed into an encrypted+authenticated short-TTL JWT
  (`A256GCM` via a new credstore secret), carried as the opaque `code` / `state`.
  No in-memory session — same as the shim's `GITHUB_OIDC_STATE_SECRET` approach.
- **Feature-flagged**, read at call time: `MCP_CONSENT_ENABLED`. Off ⇒ immediate
  `next()`, discovery keeps pointing straight at the IdP (zero behavior change).
- `jose` + `undici` are already approuter deps.

### Endpoints (new, under `/mcp-oauth`)

| Path | Role |
|---|---|
| `GET /mcp-oauth/authorize` | Validate inbound client req; render the consent HTML (Allow/Deny). |
| `POST /mcp-oauth/consent` | On **Allow**: start the real IdP authorize-code+PKCE leg (302 → IdP). On **Deny**: 302 back to client `redirect_uri` with `error=access_denied`. |
| `GET /mcp-oauth/callback` | IdP redirects here; exchange code at IdP `/token`; mint OUR `code` (sealed JWT); 302 → client `redirect_uri` with our code + original `state`. |
| `POST /mcp-oauth/token` | Verify client PKCE against the sealed challenge; return the IdP tokens (passthrough) to the client. |

### Flow (one browser login)

```
mcp-remote → /mcp-oauth/authorize?client_id&redirect_uri&code_challenge&state
           → render consent page (client_id + redirect_uri shown; 3 checkboxes)
  [Allow]  → POST /mcp-oauth/consent → 302 to IdP /oauth2/authorize (our own PKCE)
  IdP      → /mcp-oauth/callback → exchange at IdP /token → 302 client redirect_uri (our code)
  mcp-remote → POST /mcp-oauth/token → verify client PKCE → return IdP token
  [Deny]   → 302 client redirect_uri?error=access_denied
```

### Discovery flip (one line)

`approuter/lib/well-known-oauth.js:169` — when `MCP_CONSENT_ENABLED`, set
`authorization_endpoint` to `${baseUrl}/mcp-oauth/authorize` and `token_endpoint`
to `${baseUrl}/mcp-oauth/token` instead of the raw IdP endpoints. The protected-
resource doc and the `401 WWW-Authenticate` challenge
(`approuter/lib/mcp-auth-challenge.js`) are unchanged.

## Hard constraints / landmines (from prior settled findings)

- **Do NOT reuse the approuter's own `/login` handshake.** Its PKCE + state are
  validated server-side against a cached verifier (`@sap/approuter`
  `oauth2-strategy.js`); a hand-rolled authorize redirect through it 401s unless
  you disable protections app-wide (a security regression). The consent proxy
  therefore runs its OWN PKCE/state on the IdP leg — exactly as the GitHub shim
  does — and never touches the framework login route.
- **Two PKCE legs.** The client↔us leg (we are the AS the client sees) and the
  us↔IdP leg (we are an OAuth client of IAS) are independent. Keep both verifiers
  in the sealed JWT; never cross them.
- **RFC 9207 `iss`.** Our `/authorize` response `iss` must equal the discovery
  `issuer` we advertise (which, flipped, becomes the approuter self-URL). mcp-remote
  rejects a mismatch (`IssuerMismatchError`). The existing XSUAA self-issuer path
  already advertises the approuter as issuer — reuse it; do not advertise IdP as
  issuer while serving `/authorize` ourselves.
- **Akamai edge 403s non-browser User-Agents.** The consent *page* is browser-
  rendered (fine), but the back-channel `/mcp-oauth/token` call from mcp-remote
  (node UA) is still subject to the known Akamai 403 on `developers.sap.com` —
  this blocker is orthogonal to consent and must be solved regardless (tracked
  separately). Spike on the DEV approuter host, which is not Akamai-fronted.
- **Public PKCE client requires IAS, not XSUAA** (settled 2026-09-29). The IdP leg
  must use the IAS public client; this spike assumes the IAS migration path.

## Spike scope (prove the UX, defer hardening)

**In scope for the spike (DEV only, flag OFF by default):**
1. `approuter/lib/mcp-consent.js` — the four endpoints + sealed-JWT state, modeled
   on `github-oidc-shim.js`. HTML consent page as an inline template (SAP
   Fundamental Styles Horizon, matching the reference look).
2. Wire into `approuter/server.js` `insertMiddleware.first` behind
   `MCP_CONSENT_ENABLED`.
3. Discovery flip in `well-known-oauth.js` gated by the same flag.
4. The three acknowledgement checkboxes enforced server-side (Allow disabled /
   rejected until all three posted true).
5. Unit tests mirroring the shim's (`approuter/test/` CJS), + a manual
   mcp-remote end-to-end against DEV.

**Out of scope for the spike (follow-ups if it graduates):**
- Dynamic client registration (`/register`) — mcp-remote uses static client info
  today; not required for the UX.
- Localization of the consent copy.
- PROD rollout + Akamai UA allowlisting for the token back-channel.

**Explicitly decided NOT needed (not deferred — ruled out):**
- Acknowledgement persistence / audit record (decision 2).
- Consent "remember" / re-prompt-policy logic — always re-prompt (decision 3).

## Resolved decisions (Tom, 2026-10-06)

1. **Acknowledgement wording** — use the **exact same text** as the other SAP MCP
   tools' consent screen, substituting only the service name. No Legal/DevRel
   drafting round needed; the copy is a hard-coded constant (see Problem section).
2. **No persistence.** Acknowledgement is NOT recorded — no audit table, no CAP
   write-leg. The spike is **approuter-HTML-only**. (Matches the other tools: the
   ack is a gate, not a stored compliance record.)
3. **Re-prompt on EVERY authorize.** Consent is part of the login handshake and
   shows each time the authorize flow runs (observed: ~weekly re-auth in Joule
   Work Desktop for these MCPs). No "remember" / once-per-client logic — simpler.
4. **Scope = every interactive user-auth-code flow only.** Gate `/mcp-auth` (the
   browser authorize-code+PKCE flow). **Explicitly EXCLUDE** the PAT flow
   (`/mcp-pat`) and any M2M / client-credentials flow — those never hit
   `/mcp-oauth/authorize`, so they are naturally out of the path; no extra guard
   needed beyond mounting consent only on the interactive authorize endpoint.

## Effort estimate

- Spike (endpoints + consent HTML + flag + unit tests + DEV e2e): **~1–2 days**,
  low risk given the shim precedent to copy.
- Productionizing (audit record, re-prompt policy, Akamai, PROD): separate,
  larger, blocked on the IAS public-client migration landing.
