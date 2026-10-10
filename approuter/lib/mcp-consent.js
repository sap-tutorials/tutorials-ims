// approuter/lib/mcp-consent.js
//
// A self-hosted OAuth 2.1 authorization-server PROXY that renders the
// "Application Access Request" consent screen before brokering the real IAS
// public-PKCE authorize-code flow. This is the only way to show the per-request,
// multi-checkbox AI-acknowledgement consent that other SAP MCP servers (e.g.
// Knowledge@SAP via Joule Work Desktop) present — IAS's native Terms-of-Use is a
// single registration-time document, not a per-authorization gate (see the
// design spec: docs/superpowers/specs/2026-10-06-mcp-consent-screen-design.md).
//
// We are TWO OAuth roles at once:
//   * To the MCP client (mcp-remote) we ARE the authorization server. Discovery
//     (well-known-oauth.js, flipped when MCP_CONSENT_ENABLED) points its
//     authorization_endpoint/token_endpoint here.
//   * To IAS we are a public PKCE client. We run our OWN PKCE on the us<->IAS leg.
//
// Two INDEPENDENT PKCE legs — never cross them:
//   client_code_challenge  — the client's challenge; we verify it at /token.
//   idp_code_verifier      — our verifier for the IAS leg; sent to IAS /token.
//
// Flow (one browser login):
//   mcp-remote → GET  /mcp-oauth/authorize  (validate client req → render consent)
//   [Allow]    → POST /mcp-oauth/consent     (acks checked → 302 IAS /oauth2/authorize, our PKCE)
//   IAS        → GET  /mcp-oauth/callback     (exchange IAS code → 302 client redirect_uri, our code)
//   mcp-remote → POST /mcp-oauth/token        (verify client PKCE → return IAS tokens)
//   [Deny]     → 302 client redirect_uri?error=access_denied
//
// Statelessness: the approuter runs multiple instances, so authorize→consent→
// callback→token correlation is NOT held in memory. Each hop's context is sealed
// into an encrypted+authenticated short-TTL JWT (A256GCM via MCP_CONSENT_STATE_
// SECRET) carried as the opaque `txn`/`state`/`code`. Same pattern as
// github-oidc-shim.js.
//
// Landmines (see the spec + settled findings):
//   * Do NOT reuse @sap/approuter's own /login handshake — its PKCE/state are
//     validated server-side against a cached verifier; a hand-rolled redirect
//     through it 401s. We run our own PKCE/state entirely here.
//   * Public PKCE client requires IAS, not XSUAA.
//   * RFC 9207: the authorize-response iss (IAS stamps its own base) travels
//     opaquely inside our sealed state and is never surfaced to the client; the
//     client only sees US as its issuer (the flipped discovery doc).
//
// Feature flag: MCP_CONSENT_ENABLED (read at CALL time, not module load, so it
// tracks runtime config and is unit-testable). Off ⇒ immediate next(), discovery
// keeps pointing straight at the IdP (zero behavior change).
//
// CJS to match approuter/. `jose` is already an approuter dep.

'use strict'

const crypto = require('node:crypto')
const { EncryptJWT, jwtDecrypt } = require('jose')
const { resolveSecret } = require('./credstore-secret')

const BASE = '/mcp-oauth'
const AUTHORIZE_PATH = `${BASE}/authorize`
const CONSENT_PATH = `${BASE}/consent`
const CALLBACK_PATH = `${BASE}/callback`
const TOKEN_PATH = `${BASE}/token`

// The service name shown in the consent copy. Substituted into the SAME verbatim
// text the other SAP MCP tools use (Tom, 2026-10-06).
const SERVICE_NAME = 'SAP Developers MCP'

const STATE_SECRET_ALIAS = 'MCP_CONSENT_STATE_SECRET'
const TXN_TTL_S = 600 // 10 min: a human reads the consent page before deciding
const CODE_TTL_S = 300 // 5 min: authorize→token window

// Read at call time so runtime config / tests take effect without reload.
function isEnabled() {
  return String(process.env.MCP_CONSENT_ENABLED || '').toLowerCase() === 'true'
}

// IAS issuer endpoint. Reuse the approuter's already-configured XSUAA_MCP_URL
// (set in mtaext, read by well-known-oauth.js). The client_id is NOT server
// config — it comes from the MCP client's authorize request and is forwarded through
// the sealed state to the IAS leg. This preserves the env-specific + client-supplied
// model (DEV 0b1e8b56…, PROD sb-tutorials-prod!t676072, etc.).
function iasIssuer() {
  const v = process.env.XSUAA_MCP_URL
  return v ? v.replace(/\/+$/, '') : null
}

// Externally-visible base URL of this approuter, from the inbound request —
// honors CF's x-forwarded-proto/host. Same derivation as well-known-oauth.js.
function resolveBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim()
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
  if (!host) return null
  return `${proto}://${host}`
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html)
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' })
  res.end()
}

function withQuery(url, params) {
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
  }
  return u.toString()
}

// OAuth 2.0 §4.1.2.1 error redirect back to the client.
function errorRedirect(res, redirectUri, state, error, description) {
  if (!redirectUri) return sendJson(res, 400, { error, error_description: description })
  return redirect(res, withQuery(redirectUri, { error, error_description: description, state }))
}

// ── stateless txn/state/code sealing ─────────────────────────────────────────
async function stateKey() {
  const secret = await resolveSecret(STATE_SECRET_ALIAS, { logTag: '[mcp-consent]' })
  if (!secret) throw new Error(`${STATE_SECRET_ALIAS} not configured`)
  return crypto.createHash('sha256').update(secret).digest()
}

async function sealState(payload, ttlS = CODE_TTL_S) {
  const key = await stateKey()
  return await new EncryptJWT(payload)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(`${ttlS}s`)
    .encrypt(key)
}

async function openState(token) {
  const key = await stateKey()
  const { payload } = await jwtDecrypt(token, key) // throws on tamper/expiry
  return payload
}

// RFC 7636 S256 verification: base64url(sha256(verifier)) === challenge.
function verifyPkce(verifier, challenge) {
  if (!verifier || !challenge) return false
  const hash = crypto.createHash('sha256').update(verifier).digest('base64url')
  const a = Buffer.from(hash)
  const b = Buffer.from(challenge)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// Generate an RFC 7636 verifier + its S256 challenge for the us<->IAS leg.
function newPkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// Minimal HTML escaping for values echoed into the consent page.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// ── IAS leg (stubbed in unit tests via the exported boundary) ────────────────
// Exchange the IAS authorization code for tokens using our public-client PKCE
// verifier (no client secret — public client). clientId is the MCP client's own
// id, forwarded from /authorize through the sealed state (NOT server config).
async function idpExchange({ code, redirectUri, codeVerifier, clientId }) {
  const issuer = iasIssuer()
  if (!issuer || !clientId) throw new Error('IAS issuer/client not configured')
  const res = await fetch(`${issuer}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`IAS token exchange: ${res.status}`)
  return await res.json()
}

// Refresh leg (stubbed in unit tests via the exported boundary). We passed IAS's
// refresh_token through to the client verbatim at /token, so the client hands it
// right back here — we relay it to IAS. clientId is the MCP client's own id (public
// client, no secret). No PKCE on refresh.
async function idpRefresh({ refreshToken, clientId }) {
  const issuer = iasIssuer()
  if (!issuer || !clientId) throw new Error('IAS issuer/client not configured')
  const res = await fetch(`${issuer}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`IAS token refresh: ${res.status}`)
  return await res.json()
}

// ── consent page ─────────────────────────────────────────────────────────────
// The three acknowledgement statements are BYTE-IDENTICAL to the other SAP MCP
// tools' screen, substituting only the service name. Styled with SAP Fundamental
// Styles (Horizon) via CDN to match the platform look.
function consentPage({ baseUrl, clientId, redirectUri, txn }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Application Access Request</title>
<link rel="stylesheet" href="https://unpkg.com/fundamental-styles@latest/dist/theming/sap_horizon.css">
<link rel="stylesheet" href="https://unpkg.com/fundamental-styles@latest/dist/fundamental-styles.css">
<style>
  body { font-family: "72", "72full", Arial, sans-serif; background: #f5f6f7; margin: 0; padding: 2rem; }
  .card { max-width: 640px; margin: 0 auto; background: #fff; border-radius: 1rem;
          box-shadow: 0 0.25rem 1rem rgba(0,0,0,.08); padding: 2rem 2.5rem; }
  .shield { text-align: center; font-size: 3rem; color: #256f3a; }
  h1 { text-align: center; font-size: 1.5rem; margin: .25rem 0 1rem; }
  .lead { line-height: 1.5; }
  .panel { background: #eef1f7; border-radius: .5rem; padding: 1rem 1.25rem; margin: 1.25rem 0; }
  .panel .row { display: flex; justify-content: space-between; gap: 1rem; margin: .35rem 0; align-items: center; }
  .panel code { background: #fff; border: 1px solid #d9dde3; border-radius: .35rem;
                padding: .25rem .5rem; font-size: .85rem; word-break: break-all; }
  .acks { border-left: 4px solid #e9730c; background: #fff8f2; border-radius: .35rem;
          padding: 1rem 1.25rem; margin: 1.25rem 0; }
  .acks label { display: flex; gap: .6rem; align-items: flex-start; margin: .6rem 0; line-height: 1.4; }
  .actions { display: flex; gap: 1rem; margin-top: 1.5rem; }
  button { flex: 1; padding: .85rem 1rem; border-radius: 2rem; border: 0; font-size: 1rem;
           cursor: pointer; font-weight: 600; }
  .allow { background: #8bc1a0; color: #0a3d1e; }
  .deny { background: #223047; color: #fff; }
</style>
</head>
<body>
<form class="card" method="POST" action="${esc(baseUrl)}${CONSENT_PATH}">
  <div class="shield">&#128737;&#65039;</div>
  <h1>Application Access Request</h1>
  <p class="lead"><strong>${esc(clientId)}</strong> is requesting access to
     <strong>${esc(SERVICE_NAME)}</strong>. Please ensure you recognise the callback
     address below.</p>
  <div class="panel">
    <div class="row"><span>Application ID:</span><code>${esc(clientId)}</code></div>
    <div class="row"><span>Credentials will be sent to:</span><code>${esc(redirectUri)}</code></div>
  </div>
  <div class="acks">
    <label><input type="checkbox" name="ack_ai" required>
      I acknowledge that ${esc(SERVICE_NAME)} is powered by AI.</label>
    <label><input type="checkbox" name="ack_responsible" required>
      I acknowledge that I remain responsible for code compliance and security,
      must verify all results, continue using mandatory tools and processes.</label>
    <label><input type="checkbox" name="ack_pii" required>
      I acknowledge to not enter any personal data.</label>
  </div>
  <input type="hidden" name="txn" value="${esc(txn)}">
  <div class="actions">
    <button class="allow" type="submit" name="decision" value="allow">&#10753; Allow Access</button>
    <button class="deny" type="submit" name="decision" value="deny">&#10060; Deny</button>
  </div>
</form>
</body>
</html>`
}

// ── endpoint handlers ────────────────────────────────────────────────────────
async function handleAuthorize(req, res, baseUrl) {
  const url = new URL(req.url, baseUrl)
  const q = url.searchParams
  const redirectUri = q.get('redirect_uri')
  const state = q.get('state')
  const clientId = q.get('client_id') || 'unknown-client'

  if (q.get('response_type') !== 'code') {
    return errorRedirect(res, redirectUri, state, 'unsupported_response_type', 'only code is supported')
  }
  if (!redirectUri) {
    return sendJson(res, 400, { error: 'invalid_request', error_description: 'redirect_uri required' })
  }
  // Public client: S256 PKCE is mandatory.
  if (!q.get('code_challenge') || q.get('code_challenge_method') !== 'S256') {
    return errorRedirect(res, redirectUri, state, 'invalid_request', 'S256 code_challenge required')
  }

  // Seal the client authorize context into a transaction token the consent form
  // posts back. Longer TTL — a human is reading the page.
  const txn = await sealState({
    purpose: 'txn',
    client_id: clientId,
    client_redirect_uri: redirectUri,
    client_state: state ?? null,
    client_code_challenge: q.get('code_challenge'),
  }, TXN_TTL_S)

  return sendHtml(res, 200, consentPage({ baseUrl, clientId, redirectUri, txn }))
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

function parseForm(req, rawBody) {
  const ct = (req.headers['content-type'] || '').split(';')[0].trim()
  if (ct === 'application/json') { try { return JSON.parse(rawBody) } catch { return {} } }
  return Object.fromEntries(new URLSearchParams(rawBody))
}

async function handleConsent(req, res, baseUrl) {
  const rawBody = await readBody(req)
  const params = parseForm(req, rawBody)

  let ctx
  try { ctx = await openState(params.txn) } catch {
    return sendJson(res, 400, { error: 'invalid_request', error_description: 'invalid or expired transaction' })
  }
  if (ctx.purpose !== 'txn') {
    return sendJson(res, 400, { error: 'invalid_request', error_description: 'bad transaction' })
  }

  // Deny → bounce to the client with access_denied.
  if (params.decision !== 'allow') {
    return errorRedirect(res, ctx.client_redirect_uri, ctx.client_state, 'access_denied', 'user denied access')
  }

  // Allow requires ALL THREE acknowledgements (defense-in-depth; the form marks
  // them required, but never trust the client).
  const allAcked = params.ack_ai && params.ack_responsible && params.ack_pii
  if (!allAcked) {
    return sendHtml(res, 400, '<!DOCTYPE html><meta charset="utf-8"><p>You must acknowledge all three statements to continue. Please go back and check every box.</p>')
  }

  // Start the real IAS leg with OUR OWN PKCE. The client_id is the MCP client's
  // own id (from its authorize request, sealed in ctx); we forward it to IAS.
  // Carry the client context forward (sealed) so /callback can mint the client's
  // code and /token can verify the client's PKCE.
  const issuer = iasIssuer()
  if (!issuer) {
    return errorRedirect(res, ctx.client_redirect_uri, ctx.client_state, 'server_error', 'IAS not configured')
  }
  const { verifier, challenge } = newPkcePair()
  const idpState = await sealState({
    purpose: 'idp',
    client_id: ctx.client_id,
    client_redirect_uri: ctx.client_redirect_uri,
    client_state: ctx.client_state,
    client_code_challenge: ctx.client_code_challenge,
    idp_code_verifier: verifier,
  })

  return redirect(res, withQuery(`${issuer}/oauth2/authorize`, {
    response_type: 'code',
    client_id: ctx.client_id,
    redirect_uri: `${baseUrl}${CALLBACK_PATH}`,
    scope: 'openid',
    state: idpState,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }))
}

async function handleCallback(req, res, baseUrl) {
  const url = new URL(req.url, baseUrl)
  const q = url.searchParams
  let ctx
  try { ctx = await openState(q.get('state')) } catch {
    return sendJson(res, 400, { error: 'invalid_request', error_description: 'invalid or expired state' })
  }
  if (ctx.purpose !== 'idp') {
    return sendJson(res, 400, { error: 'invalid_request', error_description: 'bad state' })
  }

  const idpError = q.get('error')
  if (idpError) {
    return errorRedirect(res, ctx.client_redirect_uri, ctx.client_state, 'access_denied', q.get('error_description') || idpError)
  }
  const idpCode = q.get('code')
  if (!idpCode) {
    return errorRedirect(res, ctx.client_redirect_uri, ctx.client_state, 'invalid_request', 'missing code')
  }

  let tokens
  try {
    // Call via the exported reference so unit tests can stub this boundary.
    tokens = await module.exports.idpExchange({
      code: idpCode,
      redirectUri: `${baseUrl}${CALLBACK_PATH}`,
      codeVerifier: ctx.idp_code_verifier,
      clientId: ctx.client_id,
    })
  } catch (err) {
    return errorRedirect(res, ctx.client_redirect_uri, ctx.client_state, 'server_error', String(err.message || err))
  }

  // Mint OUR opaque code (sealed), holding the IAS tokens + the client's PKCE
  // challenge for verification at /token.
  const code = await sealState({
    purpose: 'code',
    client_redirect_uri: ctx.client_redirect_uri,
    client_state: ctx.client_state,
    client_code_challenge: ctx.client_code_challenge,
    idp_tokens: tokens,
  })

  return redirect(res, withQuery(ctx.client_redirect_uri, { code, state: ctx.client_state }))
}

async function handleToken(req, res) {
  const rawBody = await readBody(req)
  const params = parseForm(req, rawBody)

  // Refresh grant: the client holds IAS's refresh_token (we passed it through
  // verbatim at the authorization_code exchange). Relay it to IAS. The discovery
  // doc advertises refresh_token in grant_types_supported, so clients WILL use it
  // once the first access_token expires — not handling it 400s every reconnect.
  if (params.grant_type === 'refresh_token') {
    if (!params.refresh_token) {
      return sendJson(res, 400, { error: 'invalid_request', error_description: 'refresh_token required' })
    }
    let t
    try {
      // Via the exported reference so unit tests can stub this boundary.
      t = await module.exports.idpRefresh({
        refreshToken: params.refresh_token,
        clientId: params.client_id,
      })
    } catch (err) {
      return sendJson(res, 400, { error: 'invalid_grant', error_description: String(err.message || err) })
    }
    // Same id_token-as-Bearer rule as the code exchange. IAS may rotate the
    // refresh_token; pass the new one through, else keep the one the client sent.
    return sendJson(res, 200, {
      ...tokenResponse(t),
      refresh_token: t.refresh_token || params.refresh_token,
    })
  }

  if (params.grant_type !== 'authorization_code') {
    return sendJson(res, 400, { error: 'unsupported_grant_type' })
  }
  let ctx
  try { ctx = await openState(params.code) } catch {
    return sendJson(res, 400, { error: 'invalid_grant', error_description: 'invalid or expired code' })
  }
  if (ctx.purpose !== 'code' || !ctx.idp_tokens) {
    return sendJson(res, 400, { error: 'invalid_grant' })
  }

  // Verify the CLIENT's PKCE (client_code_challenge was captured at /authorize).
  if (!verifyPkce(params.code_verifier, ctx.client_code_challenge)) {
    return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
  }

  // Passthrough to the client. IMPORTANT: the client presents `access_token` as
  // its Bearer to the resource (/mcp-auth → CAP `kind:ias` via @sap/xssec). IAS's
  // own access_token from an `openid` authorization_code flow is OPAQUE (the JWT in
  // that flow is the id_token), so @sap/xssec cannot validate it → 401 "server
  // rejected a token it just issued". We therefore hand the client the IAS **id_token**
  // as its Bearer: a signed JWT whose `aud` is this public client's id (0b1e8b56…),
  // which equals the clientid of srv-mcp's bound `tutorials-identity` app (same shared
  // IAS app) — so @sap/xssec validates audience + signature and resolves the user.
  const t = ctx.idp_tokens
  return sendJson(res, 200, tokenResponse(t))
}

// Build the OAuth token response for the client. The Bearer the client will send to
// the resource must be a validatable JWT → use the IAS id_token as `access_token`.
// `expires_in` is scoped to the id_token (we re-issue via refresh when it lapses).
function tokenResponse(t) {
  return {
    access_token: t.id_token,            // JWT Bearer the resource can validate (NOT the opaque IAS access_token)
    token_type: 'Bearer',
    expires_in: t.expires_in,
    id_token: t.id_token,
    refresh_token: t.refresh_token,
    scope: t.scope,
  }
}

// ── middleware entrypoint ────────────────────────────────────────────────────
function mcpConsentHandler(req, res, next) {
  if (!isEnabled()) return next()
  const pathOnly = (req.url || '').split('?')[0]
  if (!pathOnly.startsWith(`${BASE}/`) && pathOnly !== BASE) return next()

  const baseUrl = resolveBaseUrl(req)
  if (!baseUrl) return sendJson(res, 503, { error: 'server_error', error_description: 'cannot resolve base url' })

  const run = (p) => p.catch((err) => {
    console.error('[mcp-consent] handler error:', err && err.message)
    if (!res.headersSent) sendJson(res, 500, { error: 'server_error' })
  })

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (pathOnly === AUTHORIZE_PATH) return run(handleAuthorize(req, res, baseUrl))
    if (pathOnly === CALLBACK_PATH) return run(handleCallback(req, res, baseUrl))
  }
  if (req.method === 'POST') {
    if (pathOnly === CONSENT_PATH) return run(handleConsent(req, res, baseUrl))
    if (pathOnly === TOKEN_PATH) return run(handleToken(req, res))
  }

  // A /mcp-oauth/* path we don't serve — do not leak to the SPA proxy.
  return sendJson(res, 404, { error: 'not_found' })
}

module.exports = {
  mcpConsentHandler,
  // exported for unit tests / stubbing
  idpExchange,
  idpRefresh,
  resolveBaseUrl,
  verifyPkce,
  sealState,
  openState,
  isEnabled,
  BASE,
  AUTHORIZE_PATH,
  CONSENT_PATH,
  CALLBACK_PATH,
  TOKEN_PATH,
  SERVICE_NAME,
}
