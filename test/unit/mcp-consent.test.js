// test/unit/mcp-consent.test.js
//
// Unit coverage for the MCP consent-proxy authorization server
// (approuter/lib/mcp-consent.js) — the self-hosted /authorize layer that renders
// the "Application Access Request" consent screen before brokering the real
// IAS public-PKCE authorize-code flow. Mirrors github-oidc-shim.test.js: ESM
// test loads the CJS middleware via createRequire; mockRes() captures
// writeHead/end. Two independent PKCE legs (client<->us, us<->IAS) are the
// load-bearing security surface and are tested directly.
//
// IAS network calls (the us<->IAS token exchange) are only hit on /callback;
// that leg is stubbed via a spy on the exported idpExchange boundary.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'

const require = createRequire(import.meta.url)
const consent = require('../../approuter/lib/mcp-consent.js')
const credstore = require('../../approuter/lib/credstore-secret.js')

function mockRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    headersSent: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this },
    end(payload) { this.body = payload; return this },
    json() { return JSON.parse(this.body) },
  }
}

function getReq(url) {
  return { method: 'GET', url, headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'developers.sap.com' } }
}

// A POST request whose body streams the given string (the handler reads req as
// an async iterable, same as the shim's readBody()).
function postReq(url, body, contentType = 'application/x-www-form-urlencoded') {
  async function* gen() { yield Buffer.from(body, 'utf8') }
  const it = gen()
  return {
    method: 'POST',
    url,
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'developers.sap.com', 'content-type': contentType },
    [Symbol.asyncIterator]() { return it },
  }
}

const BASE_URL = 'https://developers.sap.com'

// A valid S256 PKCE pair the client (mcp-remote) would generate.
const CLIENT_VERIFIER = 'client-verifier-' + 'a'.repeat(50)
const CLIENT_CHALLENGE = crypto.createHash('sha256').update(CLIENT_VERIFIER).digest('base64url')

const SAVED = {}
function saveEnv(...names) { for (const n of names) SAVED[n] = process.env[n] }
function restoreEnv() { for (const [n, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[n]; else process.env[n] = v } }

beforeEach(() => {
  saveEnv('MCP_CONSENT_ENABLED', 'MCP_CONSENT_STATE_SECRET', 'MCP_IAS_ISSUER', 'MCP_IAS_CLIENT_ID')
  credstore._resetForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  process.env.MCP_CONSENT_ENABLED = 'true'
  process.env.MCP_CONSENT_STATE_SECRET = 'unit-test-consent-state-secret'
  process.env.MCP_IAS_ISSUER = 'https://tenant.accounts.ondemand.com'
  process.env.MCP_IAS_CLIENT_ID = 'ias-public-client'
})

afterEach(() => {
  vi.restoreAllMocks()
  credstore._resetForTests()
  restoreEnv()
})

// Build a sealed authorize-context code as /callback would mint it, so the
// /token tests can run without the IAS round-trip.
async function sealedCode(overrides = {}) {
  return await consent.sealState({
    purpose: 'code',
    client_redirect_uri: 'http://localhost:18766/mcp-callback',
    client_state: 'client-state',
    client_code_challenge: CLIENT_CHALLENGE,
    idp_tokens: { access_token: 'idp-at', token_type: 'Bearer', expires_in: 3600, id_token: 'idp-id-token' },
    ...overrides,
  })
}

describe('feature flag', () => {
  it('is a no-op (calls next) when MCP_CONSENT_ENABLED is not true', () => {
    process.env.MCP_CONSENT_ENABLED = 'false'
    const res = mockRes()
    const next = vi.fn()
    consent.mcpConsentHandler(getReq(consent.AUTHORIZE_PATH), res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.statusCode).toBeNull()
  })

  it('passes through non-/mcp-oauth paths to next even when enabled', () => {
    const res = mockRes()
    const next = vi.fn()
    consent.mcpConsentHandler(getReq('/tutorials/foo'), res, next)
    expect(next).toHaveBeenCalledOnce()
  })
})

describe('authorize endpoint — consent page', () => {
  function authorizeUrl(params = {}) {
    const q = new URLSearchParams(Object.assign({
      response_type: 'code',
      client_id: 'joule-work-desktop',
      redirect_uri: 'http://localhost:18766/mcp-callback',
      state: 'client-state',
      code_challenge: CLIENT_CHALLENGE,
      code_challenge_method: 'S256',
    }, params))
    return `${consent.AUTHORIZE_PATH}?${q}`
  }

  it('renders an HTML consent page (200 text/html)', async () => {
    const res = mockRes()
    consent.mcpConsentHandler(getReq(authorizeUrl()), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(200))
    expect(res.headers['Content-Type']).toMatch(/text\/html/)
  })

  it('shows the client_id (Application ID) and the redirect_uri (callback) for verification', async () => {
    const res = mockRes()
    consent.mcpConsentHandler(getReq(authorizeUrl()), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(200))
    expect(res.body).toContain('joule-work-desktop')
    expect(res.body).toContain('http://localhost:18766/mcp-callback')
  })

  it('renders the three verbatim AI acknowledgement statements for SAP Developers MCP', async () => {
    const res = mockRes()
    consent.mcpConsentHandler(getReq(authorizeUrl()), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(200))
    expect(res.body).toContain('SAP Developers MCP is powered by AI')
    expect(res.body).toContain('I remain responsible for code compliance and security')
    expect(res.body).toContain('not enter any personal data')
  })

  it('rejects a non-code response_type via error redirect to the client', async () => {
    const res = mockRes()
    consent.mcpConsentHandler(getReq(authorizeUrl({ response_type: 'token' })), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(302))
    const loc = new URL(res.headers.Location)
    expect(loc.origin + loc.pathname).toBe('http://localhost:18766/mcp-callback')
    expect(loc.searchParams.get('error')).toBe('unsupported_response_type')
    expect(loc.searchParams.get('state')).toBe('client-state')
  })

  it('400s (does not open-redirect) when redirect_uri is missing', async () => {
    const res = mockRes()
    consent.mcpConsentHandler(getReq(authorizeUrl({ redirect_uri: '' })), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(400))
  })

  it('requires an S256 code_challenge (public client — no plaintext/none)', async () => {
    const res = mockRes()
    consent.mcpConsentHandler(getReq(authorizeUrl({ code_challenge: '', code_challenge_method: '' })), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(302))
    const loc = new URL(res.headers.Location)
    expect(loc.searchParams.get('error')).toBe('invalid_request')
  })
})

describe('consent endpoint — Deny', () => {
  it('redirects to the client redirect_uri with access_denied', async () => {
    const txn = await consent.sealState({
      purpose: 'txn',
      client_redirect_uri: 'http://localhost:18766/mcp-callback',
      client_state: 'client-state',
      client_code_challenge: CLIENT_CHALLENGE,
    })
    const body = new URLSearchParams({ decision: 'deny', txn }).toString()
    const res = mockRes()
    consent.mcpConsentHandler(postReq(consent.CONSENT_PATH, body), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(302))
    const loc = new URL(res.headers.Location)
    expect(loc.origin + loc.pathname).toBe('http://localhost:18766/mcp-callback')
    expect(loc.searchParams.get('error')).toBe('access_denied')
    expect(loc.searchParams.get('state')).toBe('client-state')
  })
})

describe('consent endpoint — Allow', () => {
  async function txnToken() {
    return await consent.sealState({
      purpose: 'txn',
      client_redirect_uri: 'http://localhost:18766/mcp-callback',
      client_state: 'client-state',
      client_code_challenge: CLIENT_CHALLENGE,
    })
  }

  it('rejects Allow when not all three acknowledgements are checked', async () => {
    const txn = await txnToken()
    const body = new URLSearchParams({ decision: 'allow', txn, ack_ai: 'on', ack_responsible: 'on' /* ack_pii missing */ }).toString()
    const res = mockRes()
    consent.mcpConsentHandler(postReq(consent.CONSENT_PATH, body), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(400))
    expect(res.body).toMatch(/acknowledge/i)
  })

  it('on Allow with all three acks, 302-redirects to the IAS authorize endpoint with our own PKCE', async () => {
    const txn = await txnToken()
    const body = new URLSearchParams({ decision: 'allow', txn, ack_ai: 'on', ack_responsible: 'on', ack_pii: 'on' }).toString()
    const res = mockRes()
    consent.mcpConsentHandler(postReq(consent.CONSENT_PATH, body), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(302))
    const loc = new URL(res.headers.Location)
    expect(loc.origin + loc.pathname).toBe('https://tenant.accounts.ondemand.com/oauth2/authorize')
    expect(loc.searchParams.get('client_id')).toBe('ias-public-client')
    expect(loc.searchParams.get('response_type')).toBe('code')
    expect(loc.searchParams.get('redirect_uri')).toBe(`${BASE_URL}${consent.CALLBACK_PATH}`)
    // our own (us<->IAS) PKCE challenge, NOT the client's
    expect(loc.searchParams.get('code_challenge')).toBeTruthy()
    expect(loc.searchParams.get('code_challenge')).not.toBe(CLIENT_CHALLENGE)
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256')
    // the sealed state carries the client context forward
    const opened = await consent.openState(loc.searchParams.get('state'))
    expect(opened.client_redirect_uri).toBe('http://localhost:18766/mcp-callback')
    expect(opened.client_code_challenge).toBe(CLIENT_CHALLENGE)
    expect(opened.idp_code_verifier).toBeTruthy() // our verifier, held for /callback
  })
})

describe('callback endpoint', () => {
  it('exchanges the IAS code and 302s back to the client with our opaque code', async () => {
    const idpState = await consent.sealState({
      purpose: 'idp',
      client_redirect_uri: 'http://localhost:18766/mcp-callback',
      client_state: 'client-state',
      client_code_challenge: CLIENT_CHALLENGE,
      idp_code_verifier: 'our-idp-verifier',
    })
    const spy = vi.spyOn(consent, 'idpExchange').mockResolvedValue({
      access_token: 'idp-at', token_type: 'Bearer', expires_in: 3600, id_token: 'idp-id-token',
    })
    const q = new URLSearchParams({ code: 'ias-code', state: idpState })
    const res = mockRes()
    consent.mcpConsentHandler(getReq(`${consent.CALLBACK_PATH}?${q}`), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(302))
    expect(spy).toHaveBeenCalledOnce()
    const loc = new URL(res.headers.Location)
    expect(loc.origin + loc.pathname).toBe('http://localhost:18766/mcp-callback')
    expect(loc.searchParams.get('state')).toBe('client-state')
    const code = loc.searchParams.get('code')
    expect(code).toBeTruthy()
    const opened = await consent.openState(code)
    expect(opened.purpose).toBe('code')
    expect(opened.idp_tokens.id_token).toBe('idp-id-token')
  })

  it('redirects access_denied to the client when IAS returns an error', async () => {
    const idpState = await consent.sealState({
      purpose: 'idp',
      client_redirect_uri: 'http://localhost:18766/mcp-callback',
      client_state: 'client-state',
    })
    const q = new URLSearchParams({ error: 'access_denied', error_description: 'user cancelled at IAS', state: idpState })
    const res = mockRes()
    consent.mcpConsentHandler(getReq(`${consent.CALLBACK_PATH}?${q}`), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(302))
    const loc = new URL(res.headers.Location)
    expect(loc.searchParams.get('error')).toBe('access_denied')
    expect(loc.searchParams.get('state')).toBe('client-state')
  })

  it('400s on an invalid/expired state', async () => {
    const q = new URLSearchParams({ code: 'ias-code', state: 'not-a-sealed-token' })
    const res = mockRes()
    consent.mcpConsentHandler(getReq(`${consent.CALLBACK_PATH}?${q}`), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(400))
    expect(res.json().error).toBe('invalid_request')
  })
})

describe('token endpoint — client PKCE verification + passthrough', () => {
  it('returns the IAS tokens when the client code_verifier matches', async () => {
    const code = await sealedCode()
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://localhost:18766/mcp-callback',
      code_verifier: CLIENT_VERIFIER,
      client_id: 'joule-work-desktop',
    }).toString()
    const res = mockRes()
    consent.mcpConsentHandler(postReq(consent.TOKEN_PATH, body), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(200))
    const tok = res.json()
    expect(tok.id_token).toBe('idp-id-token')
    expect(tok.access_token).toBe('idp-at')
    expect(tok.token_type).toBe('Bearer')
  })

  it('400 invalid_grant when the client code_verifier does not match', async () => {
    const code = await sealedCode()
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code,
      redirect_uri: 'http://localhost:18766/mcp-callback',
      code_verifier: 'wrong-verifier',
    }).toString()
    const res = mockRes()
    consent.mcpConsentHandler(postReq(consent.TOKEN_PATH, body), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(400))
    expect(res.json().error).toBe('invalid_grant')
  })

  it('400 unsupported_grant_type for non authorization_code grants', async () => {
    const body = new URLSearchParams({ grant_type: 'client_credentials' }).toString()
    const res = mockRes()
    consent.mcpConsentHandler(postReq(consent.TOKEN_PATH, body), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(400))
    expect(res.json().error).toBe('unsupported_grant_type')
  })
})

describe('stateless sealing', () => {
  it('round-trips a sealed payload', async () => {
    const sealed = await consent.sealState({ purpose: 'txn', client_state: 's1' })
    const opened = await consent.openState(sealed)
    expect(opened.purpose).toBe('txn')
    expect(opened.client_state).toBe('s1')
  })
  it('rejects a token sealed with a different secret', async () => {
    const sealed = await consent.sealState({ foo: 'bar' })
    credstore._resetForTests()
    process.env.MCP_CONSENT_STATE_SECRET = 'a-totally-different-secret'
    await expect(consent.openState(sealed)).rejects.toThrow()
  })
})

describe('PKCE S256 verification', () => {
  it('accepts a matching verifier/challenge pair', () => {
    expect(consent.verifyPkce(CLIENT_VERIFIER, CLIENT_CHALLENGE)).toBe(true)
  })
  it('rejects a mismatched verifier', () => {
    expect(consent.verifyPkce('nope', CLIENT_CHALLENGE)).toBe(false)
  })
  it('rejects when either side is missing', () => {
    expect(consent.verifyPkce('', 'x')).toBe(false)
    expect(consent.verifyPkce('x', '')).toBe(false)
  })
})

describe('unknown /mcp-oauth path', () => {
  it('404s rather than leaking to the SPA proxy', async () => {
    const res = mockRes()
    consent.mcpConsentHandler(getReq('/mcp-oauth/nope'), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(404))
  })
})
