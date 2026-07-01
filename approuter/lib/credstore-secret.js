// approuter/lib/credstore-secret.js
//
// Thin approuter-side credstore reader for issue #867.
//
// The srv side already resolves secrets from BTP Credential Store via
// srv/lib/secret-resolver.js + srv/lib/credstore.js. Both files depend on
// @sap/cds and @sap/xsenv (~hundreds of KB), which the approuter doesn't
// otherwise carry. This module is a purposely narrow READ-only port:
//   * CJS to match the rest of approuter/ (server.js, bearer-auth.js).
//   * VCAP_SERVICES is parsed directly — @sap/xsenv would just do the same
//     thing but drags in @sap/cds transitively.
//   * No writes — the srv side owns credstore rotation via the admin UI.
//   * Same 3-shape support as srv/lib/credstore.js: basic|mTLS × payload
//     encryption on|off. The DevRel & Community Tools BTP subaccount
//     cutover (2026-06-21) landed us on mTLS + payload-encryption; PROD
//     is still on basic auth. We handle both without a build-time switch.
//
// Cache semantics mirror srv/lib/secret-resolver.js: 5-minute TTL, credstore
// errors fall through to process.env, warn-once per TTL window per alias.
//
// Related memories:
//   [[feedback_credstore_only_no_envsubst_for_new_secrets]]
//   [[feedback_credstore_payload_encryption_default]]
//   [[feedback_node_global_fetch_drops_dispatcher]]
//   [[feedback_credstore_plan_and_config_drift]]

'use strict'

const { fetch: undiciFetch, Agent } = require('undici')
const { compactDecrypt, importPKCS8 } = require('jose')

const DEFAULT_TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 15_000
const NAMESPACE = 'tutorials'

// Alias validation mirrors srv/lib/credstore.js — letters/digits/dot/underscore/
// hyphen, ≤128 chars. Rejects control chars and path-traversal candidates.
const ALIAS_RE = /^[A-Za-z0-9_.-]{1,128}$/

// Module-singleton multiplicity defense via globalThis Symbol — same rationale
// as srv/lib/secret-resolver.js. Vitest workers with the same process can
// otherwise instantiate two divergent caches.
const STATE_KEY = Symbol.for('com.sap.developers.ims:approuter-credstore-secret')
const _state = (globalThis[STATE_KEY] ??= {
  // Map<alias, { value: string|null, expiresAt: number, warnedWindowAt: number }>
  cache: new Map(),
  binding: null,
  privateKey: null,
  undiciAgent: null,
})

function _resetForTests() {
  _state.cache.clear()
  _state.binding = null
  _state.privateKey = null
  _state.undiciAgent = null
}

function _primeForTests(alias, value, { ttlMs = DEFAULT_TTL_MS } = {}) {
  if (value == null) {
    _state.cache.delete(alias)
    return
  }
  _state.cache.set(alias, {
    value,
    expiresAt: Date.now() + ttlMs,
    warnedWindowAt: 0,
  })
}

function entryFor(alias) {
  let e = _state.cache.get(alias)
  if (!e) {
    e = { value: null, expiresAt: 0, warnedWindowAt: 0 }
    _state.cache.set(alias, e)
  }
  return e
}

// Locate the tutorials-credstore binding inside VCAP_SERVICES. We accept the
// standard `credstore` service name, and — as a defensive fallback — any
// service whose credentials shape looks like a credstore binding (has a
// `url` and either `password` or `certificate`+`key`). The mta.yaml resource
// name is `tutorials-credstore`; the marketplace service label is `credstore`.
function getBinding() {
  if (_state.binding) return _state.binding
  const raw = process.env.VCAP_SERVICES
  if (!raw) return null
  let services
  try { services = JSON.parse(raw) } catch (_) { return null }
  const arr = services.credstore
  if (!Array.isArray(arr) || arr.length === 0) return null
  // Prefer the instance whose name/label mentions our alias if there's more
  // than one (shouldn't happen — one credstore per app — but doesn't hurt).
  const preferred = arr.find(s => (s.name || s.instance_name || '').includes('credstore')) ?? arr[0]
  _state.binding = preferred.credentials ?? null
  return _state.binding
}

function ensurePem(raw, label /* 'PRIVATE KEY' */) {
  if (typeof raw !== 'string') return raw
  if (raw.includes('-----BEGIN ')) return raw
  const wrapped = raw.match(/.{1,64}/g).join('\n')
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`
}

async function getPrivateKey() {
  if (_state.privateKey) return _state.privateKey
  const b = getBinding()
  if (!b) throw new Error('credstore binding missing (tutorials-credstore not bound)')
  const raw = b.encryption && b.encryption.client_private_key
  if (!raw) throw new Error('credstore binding missing encryption.client_private_key')
  _state.privateKey = await importPKCS8(ensurePem(raw, 'PRIVATE KEY'), 'RSA-OAEP-256')
  return _state.privateKey
}

function isMtlsBinding() {
  const b = getBinding()
  if (!b) return false
  if (b.parameters && b.parameters.authentication && b.parameters.authentication.type) {
    return b.parameters.authentication.type === 'mtls'
  }
  return !b.password
}

function authHeader() {
  const b = getBinding()
  if (!b) return {}
  const secret = isMtlsBinding() ? '' : (b.password ?? '')
  const token = Buffer.from(`${b.username}:${secret}`).toString('base64')
  return { Authorization: `Basic ${token}` }
}

async function credFetch(url, init, opLabel) {
  const opts = Object.assign({}, init, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  try {
    if (isMtlsBinding()) {
      // undici's Agent carries the client cert + key. Global fetch would
      // silently strip the dispatcher option (see PR #588 /
      // [[feedback_node_global_fetch_drops_dispatcher]]).
      if (!_state.undiciAgent) {
        const b = getBinding()
        if (!b.certificate || !b.key) {
          throw new Error('credstore binding declares mtls but is missing certificate or key')
        }
        _state.undiciAgent = new Agent({
          connect: { cert: b.certificate, key: b.key },
          keepAliveTimeout: 30_000,
        })
      }
      opts.dispatcher = _state.undiciAgent
      return await undiciFetch(url, opts)
    }
    return await fetch(url, opts)
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new Error(`credstore ${opLabel}: timeout after ${FETCH_TIMEOUT_MS}ms`)
    }
    throw err
  }
}

function assertAlias(alias) {
  if (typeof alias !== 'string' || !ALIAS_RE.test(alias)) {
    throw new Error('credstore: invalid alias')
  }
}

/**
 * Read a secret value by alias from the credstore. Returns the plaintext
 * value, or null if the entry doesn't exist (404). Throws on any other
 * error — resolveSecret() catches these and falls back to process.env.
 */
async function readSecret(alias) {
  assertAlias(alias)
  const b = getBinding()
  if (!b) throw new Error('credstore binding missing (tutorials-credstore not bound)')
  const url = `${b.url}/password?name=${encodeURIComponent(alias)}`
  const res = await credFetch(url, {
    headers: Object.assign({}, authHeader(), {
      'sapcp-credstore-namespace': NAMESPACE,
      Accept: 'application/jose',
    }),
  }, `read ${alias}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`credstore read ${alias}: ${res.status}`)
  const jwe = await res.text()
  const key = await getPrivateKey()
  const { plaintext } = await compactDecrypt(jwe, key, {
    keyManagementAlgorithms: ['RSA-OAEP-256'],
    contentEncryptionAlgorithms: ['A256GCM'],
  })
  const envelope = JSON.parse(new TextDecoder().decode(plaintext))
  if (typeof envelope.value !== 'string') {
    throw new Error(`credstore read ${alias}: malformed envelope (missing value)`)
  }
  return envelope.value
}

// Indirection so unit tests can stub the credstore boundary via
// `vi.spyOn(module.exports, 'readSecret')`. resolveSecret calls the exported
// reference, not the local `readSecret` closure, so tests see the mock.
// (Direct-use callers should still call resolveSecret, not readSecret; the
// export is present mostly for test ergonomics + parity with the srv side.)
function _readSecretForResolve(alias) {
  return module.exports.readSecret(alias)
}

/**
 * Resolve a secret value by alias.
 *
 * Resolution order:
 *   1) In-memory cache (TTL = `opts.ttlMs` or 5 minutes)
 *   2) BTP Credential Store (via `readSecret` above)
 *   3) process.env[alias]
 *   4) null
 *
 * Credstore errors are NOT thrown — they're warned once per TTL window per
 * alias then the env fallback is tried. Matches srv/lib/secret-resolver.js
 * so the operational contract is symmetric across srv and approuter.
 *
 * @param {string} alias — credstore alias / env-var name (same string)
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]  — cache TTL, default 5 min
 * @param {string} [opts.logTag] — prefix for warning ("[rebuild]")
 * @returns {Promise<string|null>}
 */
async function resolveSecret(alias, opts) {
  const options = opts || {}
  const ttlMs = options.ttlMs != null ? options.ttlMs : DEFAULT_TTL_MS
  const logTag = options.logTag != null ? options.logTag : '[credstore-secret]'
  const entry = entryFor(alias)

  if (entry.value && Date.now() < entry.expiresAt) return entry.value

  let value = null
  try {
    value = await _readSecretForResolve(alias)
  } catch (err) {
    const now = Date.now()
    if (now - entry.warnedWindowAt > ttlMs) {
      console.warn(`${logTag} credstore lookup failed for ${alias} (falling back to env): ${(err && err.message) || err}`)
      entry.warnedWindowAt = now
    }
  }
  if (!value) value = process.env[alias] || null
  if (value) {
    entry.value = value
    entry.expiresAt = Date.now() + ttlMs
  }
  return value
}

function invalidateSecret(alias) {
  _state.cache.delete(alias)
}

module.exports = {
  resolveSecret,
  invalidateSecret,
  readSecret,        // exported for direct-use tests; production code should call resolveSecret
  _resetForTests,
  _primeForTests,
}
