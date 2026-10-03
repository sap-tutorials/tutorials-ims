// approuter/lib/github-oidc-shim.js
//
// A minimal OpenID Connect IdP that wraps GitHub's OAuth 2.0 so SAP IAS can
// federate GitHub as a "Corporate Identity Provider → OpenID Connect Compliant"
// (the same mechanism LinkedIn / Hugging Face use). GitHub itself is OAuth2-only
// (no discovery doc, no id_token, no JWKS) and therefore cannot be registered in
// IAS directly; this shim supplies the missing OIDC surface and bridges GitHub
// into a REAL XSUAA/IAS session. See the plan + design notes in the PR.
//
// Flow (one browser login):
//   IAS /authorize  → shim /github-oidc/authorize   (validate IAS req, 302 → GitHub)
//   GitHub          → shim /github-oidc/callback     (exchange code, fetch profile,
//                                                      302 → IAS redirect_uri w/ our code)
//   IAS (back-chan) → shim /github-oidc/token        (verify PKCE, mint RS256 id_token)
//   IAS             → shim /github-oidc/jwks         (verify the id_token signature)
//
// Statelessness: the approuter runs multiple instances, so the authorize→token
// correlation (GitHub profile, nonce, PKCE challenge, original IAS redirect) is
// NOT held in memory. It is sealed into an encrypted+authenticated short-TTL JWT
// (A256GCM via GITHUB_OIDC_STATE_SECRET) that travels as the opaque `code`. The
// GitHub access token is used transiently inside /callback and never persisted.
//
// Mounts in the approuter's insertMiddleware.first chain (server.js), BEFORE the
// static/proxy handlers, like well-known-oauth.js — short-circuits its own paths
// (writeHead/end, no next()) and runs before XSUAA (the unauthenticated seam IAS
// needs for the back-channel token/jwks calls).
//
// Feature flag: GITHUB_OIDC_ENABLED (read at CALL time, not module load, so it
// tracks runtime config and is unit-testable). Off ⇒ immediate next(), zero
// behavior change — the default state until the IAS registration lands.
//
// CJS to match approuter/. `jose` + `undici` are already approuter deps.

'use strict'

const crypto = require('node:crypto')
const { SignJWT, EncryptJWT, jwtDecrypt } = require('jose')
const { resolveSecret } = require('./credstore-secret')
const { getSigningMaterial, getJwks, ALG } = require('./github-oidc-keys')

const BASE = '/github-oidc'
const DISCOVERY_PATH = `${BASE}/.well-known/openid-configuration`
const AUTHORIZE_PATH = `${BASE}/authorize`
const CALLBACK_PATH = `${BASE}/callback`
const TOKEN_PATH = `${BASE}/token`
const JWKS_PATH = `${BASE}/jwks`
const USERINFO_PATH = `${BASE}/userinfo`

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize'
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token'
const GITHUB_API = 'https://api.github.com'
const GITHUB_SCOPES = 'read:user user:email'

// The logical issuer we stamp into UserIdentities on the CAP side keys GitHub
// logins on (issuer='https://github.com', subject=<github numeric id>). The
// shim's OWN OIDC issuer (the `iss` of the id_token IAS verifies) is the shim
// base URL, derived per-request — not this constant.
const CODE_TTL_S = 300 // 5 min: authorize→token window
const ID_TOKEN_TTL_S = 300

const STATE_SECRET_ALIAS = 'GITHUB_OIDC_STATE_SECRET'
const CLIENT_ID_ALIAS = 'GITHUB_CLIENT_ID'
const CLIENT_SECRET_ALIAS = 'GITHUB_CLIENT_SECRET'
// The client_id/secret IAS uses to call our /token back-channel (IAS is OUR
// OAuth client). Separate from the GitHub app credentials above.
const IAS_CLIENT_ID_ALIAS = 'GITHUB_OIDC_IAS_CLIENT_ID'
const IAS_CLIENT_SECRET_ALIAS = 'GITHUB_OIDC_IAS_CLIENT_SECRET'

// Read at call time so runtime config / tests take effect without reload.
function isEnabled() {
  return String(process.env.GITHUB_OIDC_ENABLED || '').toLowerCase() === 'true'
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

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' })
  res.end()
}

// Append query params to a URL (preserves any already present).
function withQuery(url, params) {
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
  }
  return u.toString()
}

// Build an error redirect back to IAS per OAuth 2.0 §4.1.2.1.
function errorRedirect(res, redirectUri, state, error, description) {
  if (!redirectUri) return sendJson(res, 400, { error, error_description: description })
  return redirect(res, withQuery(redirectUri, { error, error_description: description, state }))
}

// ── stateless code/state sealing ─────────────────────────────────────────────
// The 32-byte A256GCM key is derived from the configured secret via SHA-256 so
// an operator can supply any sufficiently-random string as the alias value.
async function stateKey() {
  const secret = await resolveSecret(STATE_SECRET_ALIAS, { logTag: '[github-oidc]' })
  if (!secret) throw new Error(`${STATE_SECRET_ALIAS} not configured`)
  return crypto.createHash('sha256').update(secret).digest()
}

// Seal the IAS authorize context (used as the `state` we hand GitHub, so it
// survives the GitHub round-trip without server-side storage).
async function sealState(payload) {
  const key = await stateKey()
  return await new EncryptJWT(payload)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(`${CODE_TTL_S}s`)
    .encrypt(key)
}

async function openState(token) {
  const key = await stateKey()
  const { payload } = await jwtDecrypt(token, key) // throws on tamper/expiry
  return payload
}

// ── GitHub calls ─────────────────────────────────────────────────────────────
async function exchangeGithubCode(code, clientId, clientSecret, redirectUri) {
  const res = await fetch(GITHUB_TOKEN, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`github token exchange: ${res.status}`)
  const json = await res.json()
  if (json.error || !json.access_token) throw new Error(`github token exchange: ${json.error || 'no access_token'}`)
  return json.access_token
}

async function fetchGithubProfile(accessToken) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'tutorials-github-oidc-shim',
  }
  const userRes = await fetch(`${GITHUB_API}/user`, { headers, signal: AbortSignal.timeout(15_000) })
  if (!userRes.ok) throw new Error(`github /user: ${userRes.status}`)
  const user = await userRes.json()

  // Email: /user.email is often null (privacy). Pull the verified primary from
  // /user/emails. NEVER key identity on email downstream (noreply synthetics) —
  // the subject is the numeric id; email is advisory.
  let email = null
  let emailVerified = false
  try {
    const emailsRes = await fetch(`${GITHUB_API}/user/emails`, { headers, signal: AbortSignal.timeout(15_000) })
    if (emailsRes.ok) {
      const emails = await emailsRes.json()
      const primary = Array.isArray(emails) ? emails.find(e => e.primary && e.verified) : null
      if (primary) { email = primary.email; emailVerified = true }
    }
  } catch { /* email is best-effort */ }

  return {
    id: String(user.id), // GitHub numeric user id — the stable OIDC subject
    login: user.login, // handle → Users.githubLogin
    name: user.name || user.login || null,
    email,
    emailVerified,
  }
}

// ── OIDC documents ───────────────────────────────────────────────────────────
function discoveryDocument(baseUrl) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}${AUTHORIZE_PATH}`,
    token_endpoint: `${baseUrl}${TOKEN_PATH}`,
    userinfo_endpoint: `${baseUrl}${USERINFO_PATH}`,
    jwks_uri: `${baseUrl}${JWKS_PATH}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: [ALG],
    scopes_supported: ['openid', 'profile', 'email'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'preferred_username', 'email', 'email_verified', 'name'],
  }
}

// RFC 7636 S256 verification: base64url(sha256(verifier)) === challenge.
function verifyPkce(verifier, challenge) {
  if (!verifier || !challenge) return false
  const hash = crypto.createHash('sha256').update(verifier).digest('base64url')
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(challenge))
}

async function mintIdToken(baseUrl, aud, profile, nonce) {
  const { privateKey, kid } = await getSigningMaterial()
  return await new SignJWT({
    preferred_username: profile.login,
    email: profile.email ?? undefined,
    email_verified: profile.email ? profile.emailVerified : undefined,
    name: profile.name ?? undefined,
    nonce: nonce ?? undefined,
  })
    .setProtectedHeader({ alg: ALG, kid })
    .setIssuer(baseUrl)
    .setSubject(profile.id)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(`${ID_TOKEN_TTL_S}s`)
    .sign(privateKey)
}

// ── endpoint handlers ────────────────────────────────────────────────────────
async function handleAuthorize(req, res, baseUrl) {
  const url = new URL(req.url, baseUrl)
  const q = url.searchParams
  const redirectUri = q.get('redirect_uri')
  const state = q.get('state')
  // Validate the IAS request. We only support code + S256 PKCE.
  if (q.get('response_type') !== 'code') {
    return errorRedirect(res, redirectUri, state, 'unsupported_response_type', 'only code is supported')
  }
  const iasClientId = await resolveSecret(IAS_CLIENT_ID_ALIAS, { logTag: '[github-oidc]' })
  if (iasClientId && q.get('client_id') !== iasClientId) {
    return errorRedirect(res, redirectUri, state, 'unauthorized_client', 'unknown client_id')
  }
  if (!redirectUri) return sendJson(res, 400, { error: 'invalid_request', error_description: 'redirect_uri required' })

  const githubClientId = await resolveSecret(CLIENT_ID_ALIAS, { logTag: '[github-oidc]' })
  if (!githubClientId) return sendJson(res, 503, { error: 'server_error', error_description: 'github client not configured' })

  // Seal the IAS context so /callback can continue statelessly.
  const sealed = await sealState({
    ias_redirect_uri: redirectUri,
    ias_state: state ?? null,
    ias_nonce: q.get('nonce') ?? null,
    ias_code_challenge: q.get('code_challenge') ?? null,
    ias_code_challenge_method: q.get('code_challenge_method') ?? null,
    aud: q.get('client_id') ?? null,
  })

  // Hand `sealed` to GitHub as its `state`; GitHub returns it to /callback.
  return redirect(res, withQuery(GITHUB_AUTHORIZE, {
    client_id: githubClientId,
    redirect_uri: `${baseUrl}${CALLBACK_PATH}`,
    scope: GITHUB_SCOPES,
    state: sealed,
    allow_signup: 'true',
  }))
}

async function handleCallback(req, res, baseUrl) {
  const url = new URL(req.url, baseUrl)
  const q = url.searchParams
  const sealed = q.get('state')
  const ghError = q.get('error')

  let ctx
  try { ctx = await openState(sealed) } catch {
    return sendJson(res, 400, { error: 'invalid_request', error_description: 'invalid or expired state' })
  }
  if (ghError) {
    return errorRedirect(res, ctx.ias_redirect_uri, ctx.ias_state, 'access_denied', q.get('error_description') || ghError)
  }
  const ghCode = q.get('code')
  if (!ghCode) return errorRedirect(res, ctx.ias_redirect_uri, ctx.ias_state, 'invalid_request', 'missing code')

  const githubClientId = await resolveSecret(CLIENT_ID_ALIAS, { logTag: '[github-oidc]' })
  const githubClientSecret = await resolveSecret(CLIENT_SECRET_ALIAS, { logTag: '[github-oidc]' })
  if (!githubClientId || !githubClientSecret) {
    return errorRedirect(res, ctx.ias_redirect_uri, ctx.ias_state, 'server_error', 'github client not configured')
  }

  let profile
  try {
    const accessToken = await exchangeGithubCode(ghCode, githubClientId, githubClientSecret, `${baseUrl}${CALLBACK_PATH}`)
    profile = await fetchGithubProfile(accessToken)
  } catch (err) {
    return errorRedirect(res, ctx.ias_redirect_uri, ctx.ias_state, 'server_error', String(err.message || err))
  }

  // Re-seal with the fetched profile; this becomes the authorization `code` IAS
  // presents to /token. PKCE challenge travels along for verification there.
  const code = await sealState({
    profile,
    ias_nonce: ctx.ias_nonce,
    ias_code_challenge: ctx.ias_code_challenge,
    aud: ctx.aud,
    purpose: 'code',
  })

  return redirect(res, withQuery(ctx.ias_redirect_uri, { code, state: ctx.ias_state }))
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

function parseTokenParams(req, rawBody) {
  const ct = (req.headers['content-type'] || '').split(';')[0].trim()
  if (ct === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(rawBody))
  if (ct === 'application/json') { try { return JSON.parse(rawBody) } catch { return {} } }
  return Object.fromEntries(new URLSearchParams(rawBody))
}

async function handleToken(req, res, baseUrl) {
  const rawBody = await readBody(req)
  const params = parseTokenParams(req, rawBody)

  if (params.grant_type !== 'authorization_code') {
    return sendJson(res, 400, { error: 'unsupported_grant_type' })
  }

  // Authenticate IAS as our client (secret in body or Basic header).
  const expectSecret = await resolveSecret(IAS_CLIENT_SECRET_ALIAS, { logTag: '[github-oidc]' })
  if (expectSecret) {
    let presented = params.client_secret
    const authz = req.headers.authorization || ''
    if (!presented && authz.startsWith('Basic ')) {
      const decoded = Buffer.from(authz.slice(6), 'base64').toString('utf8')
      presented = decoded.slice(decoded.indexOf(':') + 1)
    }
    if (!presented || presented.length !== expectSecret.length ||
        !crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expectSecret))) {
      return sendJson(res, 401, { error: 'invalid_client' })
    }
  }

  let ctx
  try { ctx = await openState(params.code) } catch {
    return sendJson(res, 400, { error: 'invalid_grant', error_description: 'invalid or expired code' })
  }
  if (ctx.purpose !== 'code' || !ctx.profile) {
    return sendJson(res, 400, { error: 'invalid_grant' })
  }

  // Verify PKCE if IAS supplied a challenge at /authorize.
  if (ctx.ias_code_challenge) {
    if (!verifyPkce(params.code_verifier, ctx.ias_code_challenge)) {
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
    }
  }

  let idToken
  try {
    idToken = await mintIdToken(baseUrl, ctx.aud, ctx.profile, ctx.ias_nonce)
  } catch (err) {
    return sendJson(res, 503, { error: 'server_error', error_description: String(err.message || err) })
  }

  return sendJson(res, 200, {
    access_token: crypto.randomUUID(), // opaque; userinfo is driven by the id_token
    token_type: 'Bearer',
    expires_in: ID_TOKEN_TTL_S,
    id_token: idToken,
  })
}

// ── middleware entrypoint ────────────────────────────────────────────────────
function gitHubOidcShimHandler(req, res, next) {
  if (!isEnabled()) return next()
  const pathOnly = (req.url || '').split('?')[0]
  if (!pathOnly.startsWith(`${BASE}/`) && pathOnly !== BASE) return next()

  const baseUrl = resolveBaseUrl(req)
  if (!baseUrl) return sendJson(res, 503, { error: 'server_error', error_description: 'cannot resolve base url' })

  const run = (p) => p.catch((err) => {
    console.error('[github-oidc] handler error:', err && err.message)
    if (!res.headersSent) sendJson(res, 500, { error: 'server_error' })
  })

  if ((req.method === 'GET' || req.method === 'HEAD')) {
    if (pathOnly === DISCOVERY_PATH) return sendJson(res, 200, discoveryDocument(baseUrl))
    if (pathOnly === JWKS_PATH) return run(getJwks().then(j => sendJson(res, 200, j)))
    if (pathOnly === AUTHORIZE_PATH) return run(handleAuthorize(req, res, baseUrl))
    if (pathOnly === CALLBACK_PATH) return run(handleCallback(req, res, baseUrl))
    if (pathOnly === USERINFO_PATH) return sendJson(res, 400, { error: 'use_id_token', error_description: 'userinfo not served; claims are in the id_token' })
  }
  if (req.method === 'POST' && pathOnly === TOKEN_PATH) return run(handleToken(req, res, baseUrl))

  // A /github-oidc/* path we don't serve — do not leak to the SPA proxy.
  return sendJson(res, 404, { error: 'not_found' })
}

module.exports = {
  gitHubOidcShimHandler,
  // exported for unit tests
  resolveBaseUrl,
  discoveryDocument,
  verifyPkce,
  sealState,
  openState,
  mintIdToken,
  isEnabled,
  BASE,
  DISCOVERY_PATH,
  AUTHORIZE_PATH,
  CALLBACK_PATH,
  TOKEN_PATH,
  JWKS_PATH,
}
