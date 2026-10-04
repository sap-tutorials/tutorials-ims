// test/unit/github-oidc-shim.test.js
//
// Unit coverage for the GitHub-OIDC shim (approuter/lib/github-oidc-shim.js +
// github-oidc-keys.js) — the custom OpenID Connect IdP that wraps GitHub so SAP
// IAS can federate it. Mirrors the well-known-oauth.test.js harness: ESM test
// loads the CJS middleware via createRequire; a mockRes() captures writeHead/end.
//
// GitHub network calls (code exchange, /user, /user/emails) are only hit on the
// /callback path; those paths are exercised via the pure helpers + fetch stubs.
// The crypto surface (seal/open state, id_token mint + JWKS verify, PKCE) is
// tested directly — that is the load-bearing security logic.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import { generateKeyPair, exportPKCS8, SignJWT, jwtVerify, createLocalJWKSet } from 'jose'

const require = createRequire(import.meta.url)
const shim = require('../../approuter/lib/github-oidc-shim.js')
const keys = require('../../approuter/lib/github-oidc-keys.js')
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

const BASE_URL = 'https://developers.sap.com'
let TEST_PKCS8 // a throwaway RSA private key, PKCS#8 PEM

const SAVED = {}
function saveEnv(...names) { for (const n of names) SAVED[n] = process.env[n] }
function restoreEnv() { for (const [n, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[n]; else process.env[n] = v } }

beforeEach(async () => {
  saveEnv('GITHUB_OIDC_ENABLED', 'GITHUB_OIDC_SIGNING_KEY', 'GITHUB_OIDC_STATE_SECRET',
    'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_OIDC_IAS_CLIENT_ID', 'GITHUB_OIDC_IAS_CLIENT_SECRET')
  credstore._resetForTests()
  keys._resetForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  if (!TEST_PKCS8) {
    const { privateKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true })
    TEST_PKCS8 = await exportPKCS8(privateKey)
  }
  // Secrets come from env fallback (credstore binding absent in unit env).
  process.env.GITHUB_OIDC_ENABLED = 'true'
  process.env.GITHUB_OIDC_SIGNING_KEY = TEST_PKCS8
  process.env.GITHUB_OIDC_STATE_SECRET = 'unit-test-state-secret-value'
  process.env.GITHUB_CLIENT_ID = 'gh-client-id'
  process.env.GITHUB_CLIENT_SECRET = 'gh-client-secret'
})

afterEach(() => {
  vi.restoreAllMocks()
  credstore._resetForTests()
  keys._resetForTests()
  restoreEnv()
})

describe('feature flag', () => {
  it('is a no-op (calls next) when GITHUB_OIDC_ENABLED is not true', () => {
    process.env.GITHUB_OIDC_ENABLED = 'false'
    const res = mockRes()
    const next = vi.fn()
    shim.gitHubOidcShimHandler(getReq(shim.DISCOVERY_PATH), res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.statusCode).toBeNull()
  })

  it('passes through non-/github-oidc paths to next even when enabled', () => {
    const res = mockRes()
    const next = vi.fn()
    shim.gitHubOidcShimHandler(getReq('/tutorials/foo'), res, next)
    expect(next).toHaveBeenCalledOnce()
  })
})

describe('discovery document', () => {
  it('serves a valid OIDC discovery doc with RS256 + code + S256', () => {
    const res = mockRes()
    shim.gitHubOidcShimHandler(getReq(shim.DISCOVERY_PATH), res, vi.fn())
    expect(res.statusCode).toBe(200)
    const doc = res.json()
    expect(doc.issuer).toBe(BASE_URL)
    expect(doc.authorization_endpoint).toBe(`${BASE_URL}${shim.AUTHORIZE_PATH}`)
    expect(doc.token_endpoint).toBe(`${BASE_URL}${shim.TOKEN_PATH}`)
    expect(doc.jwks_uri).toBe(`${BASE_URL}${shim.JWKS_PATH}`)
    expect(doc.response_types_supported).toEqual(['code'])
    expect(doc.id_token_signing_alg_values_supported).toContain('RS256')
    expect(doc.code_challenge_methods_supported).toEqual(['S256'])
    expect(doc.scopes_supported).toEqual(['openid', 'profile', 'email'])
  })
})

describe('JWKS endpoint', () => {
  it('serves a public JWK that verifies a shim-minted id_token', async () => {
    // Mint an id_token via the shim, then verify it against the JWKS the shim serves.
    const profile = { id: '42', login: 'octocat', name: 'The Octocat', email: 'octo@example.com', emailVerified: true }
    const idToken = await shim.mintIdToken(BASE_URL, 'ias-client', profile, 'nonce-123')

    const res = mockRes()
    shim.gitHubOidcShimHandler(getReq(shim.JWKS_PATH), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(200))
    const jwks = res.json()
    expect(jwks.keys).toHaveLength(1)
    expect(jwks.keys[0].kty).toBe('RSA')
    expect(jwks.keys[0].kid).toBeTruthy()

    const JWKS = createLocalJWKSet(jwks)
    const { payload } = await jwtVerify(idToken, JWKS, { issuer: BASE_URL, audience: 'ias-client' })
    expect(payload.sub).toBe('42')
    expect(payload.preferred_username).toBe('octocat')
    expect(payload.email).toBe('octo@example.com')
    expect(payload.email_verified).toBe(true)
    expect(payload.nonce).toBe('nonce-123')
  })
})

describe('id_token minting', () => {
  it('omits email/email_verified when GitHub gives no verified email', async () => {
    const profile = { id: '7', login: 'ghost', name: null, email: null, emailVerified: false }
    const idToken = await shim.mintIdToken(BASE_URL, 'aud', profile, null)
    const jwks = await keys.getJwks()
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), { issuer: BASE_URL, audience: 'aud' })
    expect(payload.sub).toBe('7')
    expect(payload.preferred_username).toBe('ghost')
    expect(payload.email).toBeUndefined()
    expect(payload.email_verified).toBeUndefined()
  })
})

describe('PKCE S256 verification', () => {
  it('accepts a matching verifier/challenge pair', () => {
    const verifier = 'a'.repeat(64)
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    expect(shim.verifyPkce(verifier, challenge)).toBe(true)
  })
  it('rejects a mismatched verifier', () => {
    const challenge = crypto.createHash('sha256').update('a'.repeat(64)).digest('base64url')
    expect(shim.verifyPkce('b'.repeat(64), challenge)).toBe(false)
  })
  it('rejects when either side is missing', () => {
    expect(shim.verifyPkce('', 'x')).toBe(false)
    expect(shim.verifyPkce('x', '')).toBe(false)
  })
})

describe('stateless code/state sealing', () => {
  it('round-trips a sealed payload', async () => {
    const sealed = await shim.sealState({ ias_redirect_uri: 'https://ias/cb', ias_state: 's1', purpose: 'code' })
    const opened = await shim.openState(sealed)
    expect(opened.ias_redirect_uri).toBe('https://ias/cb')
    expect(opened.ias_state).toBe('s1')
    expect(opened.purpose).toBe('code')
  })
  it('rejects a tampered token', async () => {
    const sealed = await shim.sealState({ foo: 'bar' })
    const tampered = sealed.slice(0, -4) + (sealed.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA')
    await expect(shim.openState(tampered)).rejects.toThrow()
  })
  it('rejects a token sealed with a different secret', async () => {
    const sealed = await shim.sealState({ foo: 'bar' })
    credstore._resetForTests()
    process.env.GITHUB_OIDC_STATE_SECRET = 'a-totally-different-secret'
    await expect(shim.openState(sealed)).rejects.toThrow()
  })
})

describe('authorize endpoint', () => {
  it('302-redirects to GitHub with our client_id + scopes + sealed state', async () => {
    const q = new URLSearchParams({
      response_type: 'code', client_id: 'ias-client', redirect_uri: 'https://ias.example/cb',
      state: 'ias-state', nonce: 'n1', code_challenge: 'chal', code_challenge_method: 'S256',
    })
    const res = mockRes()
    shim.gitHubOidcShimHandler(getReq(`${shim.AUTHORIZE_PATH}?${q}`), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(302))
    const loc = new URL(res.headers.Location)
    expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(loc.searchParams.get('client_id')).toBe('gh-client-id')
    expect(loc.searchParams.get('scope')).toBe('read:user user:email')
    expect(loc.searchParams.get('redirect_uri')).toBe(`${BASE_URL}${shim.CALLBACK_PATH}`)
    // state handed to GitHub is our sealed context, reopenable
    const opened = await shim.openState(loc.searchParams.get('state'))
    expect(opened.ias_redirect_uri).toBe('https://ias.example/cb')
    expect(opened.ias_nonce).toBe('n1')
    expect(opened.ias_code_challenge).toBe('chal')
  })

  it('rejects a non-code response_type via error redirect', async () => {
    const q = new URLSearchParams({ response_type: 'token', redirect_uri: 'https://ias.example/cb', state: 'st' })
    const res = mockRes()
    shim.gitHubOidcShimHandler(getReq(`${shim.AUTHORIZE_PATH}?${q}`), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(302))
    const loc = new URL(res.headers.Location)
    expect(loc.origin + loc.pathname).toBe('https://ias.example/cb')
    expect(loc.searchParams.get('error')).toBe('unsupported_response_type')
    expect(loc.searchParams.get('state')).toBe('st')
  })
})

describe('callback endpoint', () => {
  it('redirects back to IAS with access_denied when GitHub returns an error', async () => {
    const state = await shim.sealState({ ias_redirect_uri: 'https://ias.example/cb', ias_state: 'st' })
    const q = new URLSearchParams({ error: 'access_denied', error_description: 'user cancelled', state })
    const res = mockRes()
    shim.gitHubOidcShimHandler(getReq(`${shim.CALLBACK_PATH}?${q}`), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(302))
    const loc = new URL(res.headers.Location)
    expect(loc.origin + loc.pathname).toBe('https://ias.example/cb')
    expect(loc.searchParams.get('error')).toBe('access_denied')
    expect(loc.searchParams.get('state')).toBe('st')
  })

  it('400s on an invalid/expired state', async () => {
    const q = new URLSearchParams({ code: 'gh-code', state: 'not-a-valid-sealed-token' })
    const res = mockRes()
    shim.gitHubOidcShimHandler(getReq(`${shim.CALLBACK_PATH}?${q}`), res, vi.fn())
    await vi.waitFor(() => expect(res.statusCode).toBe(400))
    expect(res.json().error).toBe('invalid_request')
  })
})
