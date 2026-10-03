// approuter/lib/github-oidc-keys.js
//
// RSA keypair management for the GitHub-OIDC shim (the custom OpenID Connect
// IdP that wraps GitHub so SAP IAS can federate it — see github-oidc-shim.js).
//
// The shim mints RS256 `id_token`s that IAS verifies against the shim's JWKS.
// The signing key is a credstore secret (alias GITHUB_OIDC_SIGNING_KEY), an
// RSA private key in PKCS#8 PEM. We derive the public JWK from it on demand for
// the /github-oidc/jwks endpoint so there is a single source of truth (the
// private key) and no second secret to rotate in lockstep.
//
// CJS to match the rest of approuter/ (server.js, well-known-oauth.js,
// credstore-secret.js). `jose` is already an approuter dependency (used by
// credstore-secret.js for JWE decrypt).
//
// Related:
//   [[feedback_credstore_only_no_envsubst_for_new_secrets]]
//   approuter/lib/credstore-secret.js — the resolveSecret() this builds on

'use strict'

const { importPKCS8, exportJWK, calculateJwkThumbprint } = require('jose')
const { resolveSecret } = require('./credstore-secret')

const SIGNING_KEY_ALIAS = 'GITHUB_OIDC_SIGNING_KEY'
const ALG = 'RS256'

// Module-singleton cache (same globalThis-Symbol defense as credstore-secret.js:
// vitest workers in one process could otherwise hold divergent key material).
const STATE_KEY = Symbol.for('com.sap.developers.ims:github-oidc-keys')
const _state = (globalThis[STATE_KEY] ??= {
  // { privateKey: KeyLike, publicJwk: object, kid: string } | null
  material: null,
})

function _resetForTests() {
  _state.material = null
}

// Normalize a stored key into PEM. Credstore round-trips values as plain
// strings; a key pasted without the armor (or with escaped newlines) still
// needs to parse. Mirrors credstore-secret.js ensurePem().
function ensurePem(raw) {
  if (typeof raw !== 'string') return raw
  const s = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw
  if (s.includes('-----BEGIN ')) return s
  const wrapped = s.match(/.{1,64}/g).join('\n')
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----`
}

// Load (once) the shim signing key from credstore and derive its public JWK +
// stable `kid` (RFC 7638 JWK thumbprint). Throws if the secret is absent —
// callers (the shim endpoints) translate that into a 503, never a crash.
async function getSigningMaterial() {
  if (_state.material) return _state.material

  const pem = await resolveSecret(SIGNING_KEY_ALIAS, { logTag: '[github-oidc]' })
  if (!pem) {
    throw new Error(`${SIGNING_KEY_ALIAS} not configured (credstore + env both empty)`)
  }

  // extractable: true is required so exportJWK can derive the public JWK for
  // the /github-oidc/jwks endpoint. The private key never leaves this process
  // (loaded from credstore); only the public members are ever exported.
  const privateKey = await importPKCS8(ensurePem(pem), ALG, { extractable: true })
  // exportJWK on a private key yields the private JWK; strip to the public
  // members only for the JWKS document.
  const fullJwk = await exportJWK(privateKey)
  const publicJwk = { kty: fullJwk.kty, n: fullJwk.n, e: fullJwk.e }
  const kid = await calculateJwkThumbprint(publicJwk)

  _state.material = {
    privateKey,
    kid,
    publicJwk: { ...publicJwk, kid, use: 'sig', alg: ALG },
  }
  return _state.material
}

// The JWKS document body served at /github-oidc/jwks.
async function getJwks() {
  const { publicJwk } = await getSigningMaterial()
  return { keys: [publicJwk] }
}

module.exports = {
  getSigningMaterial,
  getJwks,
  SIGNING_KEY_ALIAS,
  ALG,
  // exported for unit tests
  ensurePem,
  _resetForTests,
}
