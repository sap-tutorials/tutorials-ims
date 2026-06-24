// srv/lib/credstore.js
// BTP Credential Store integration. Phase 2-C (#465).
//
// Layered above @sap/xsenv (binding lookup) + undici fetch (so we can pass
// an mTLS-configured Agent via the dispatcher option) + jose (JWE-decrypt
// for reads AND JWE-encrypt for writes when the binding has payload
// encryption enabled).
//
// Three independent binding-shape variants this module handles, all of
// which now coexist across BTP subaccounts:
//
//   1. Basic auth, payload encryption DISABLED  — legacy subaccounts.
//      Body is plain JSON, response is JWE (decrypt only).
//   2. mTLS auth, payload encryption DISABLED   — transitional.
//      Body is plain JSON, response is JWE, dispatcher carries the
//      client cert.
//   3. mTLS auth, payload encryption ENABLED    — new BTP-subaccount
//      default (DevRel & Community Tools cutover, 2026-06-21). Body
//      MUST be a JWE compact-serialization string encrypted with the
//      binding's `encryption.server_public_key`, Content-Type
//      'application/jose', and a mandatory `iat` protected header
//      (<2 min old). Response is also JWE.
//
// PR #586 fixed (1) → (2) basic-auth → mTLS. PR #588 fixed the global-
// fetch dispatcher-drop. This change fixes (2) → (3) — without it the
// credstore returns 415 'wrong_content_type_for_jwe' on every POST
// because we were still sending Content-Type: application/json with a
// plain JSON body against a payload-encryption-enabled binding.
//
// The `client_private_key` in the binding is also delivered as a raw
// base64-DER PKCS#8 string in mTLS bindings (no PEM headers), but the
// PR-#465 unit-test fixture supplies it already PEM-wrapped. The PEM
// detection in getPrivateKey() handles both.

import { getServices } from '@sap/xsenv';
import { CompactEncrypt, compactDecrypt, importPKCS8, importSPKI } from 'jose';
import { fetch as undiciFetch } from 'undici';
import cds from '@sap/cds';

const LOG = cds.log('credstore');
const NAMESPACE = 'tutorials';   // single namespace per env (Phase 2-C spec)

// Cache stored on globalThis so module-singleton multiplicity (Vitest+CDS on
// Windows) doesn't produce divergent caches across instances. Same pattern as
// srv/lib/runtime-config/*-settings.js after #491 final-review fix. The memory
// [feedback_module_singletons_in_vitest_cds] has fired 4× already — preempting here.
const STATE_KEY = Symbol.for('com.sap.developers.ims:credstore');
const _state = (globalThis[STATE_KEY] ??= {
  binding: null, privateKey: null, publicKey: null, undiciAgent: null,
});

function getBinding() {
  if (_state.binding) return _state.binding;
  const services = getServices({ credstore: { tag: 'credstore' } });
  _state.binding = services.credstore;
  return _state.binding;
}

// PEM-wrap a base64 DER blob if the caller delivered it without headers.
// mTLS-provisioned bindings ship `encryption.client_private_key` and
// `encryption.server_public_key` as raw base64 DER (no PEM frame); legacy
// basic-auth bindings + the PR-#465 unit-test fixture ship them already
// PEM-wrapped. jose's importPKCS8 / importSPKI require PEM with headers,
// so we normalize before calling them.
function ensurePem(raw, label /* 'PRIVATE KEY' | 'PUBLIC KEY' */) {
  if (typeof raw !== 'string') return raw;
  if (raw.includes('-----BEGIN ')) return raw;
  const wrapped = raw.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`;
}

async function getPrivateKey() {
  if (_state.privateKey) return _state.privateKey;
  const binding = getBinding();
  const raw = binding.encryption?.client_private_key;
  if (!raw) {
    throw new Error('credstore binding missing encryption.client_private_key');
  }
  // jose's importPKCS8 expects PEM with proper headers. The second arg here
  // sets key.algorithm metadata for jose's introspection — it does NOT
  // restrict what compactDecrypt accepts. The actual algorithm-confusion
  // defense lives at the compactDecrypt call site in readSecret() below,
  // via keyManagementAlgorithms + contentEncryptionAlgorithms options.
  _state.privateKey = await importPKCS8(ensurePem(raw, 'PRIVATE KEY'), 'RSA-OAEP-256');
  return _state.privateKey;
}

// Cached server-side encryption public key used to JWE-encrypt POST bodies
// when payload encryption is enabled on the binding. Symmetric to
// getPrivateKey() — same PEM-or-raw normalization, same algorithm metadata.
async function getPublicKey() {
  if (_state.publicKey) return _state.publicKey;
  const binding = getBinding();
  const raw = binding.encryption?.server_public_key;
  if (!raw) {
    throw new Error('credstore binding has payload encryption enabled but is missing encryption.server_public_key');
  }
  _state.publicKey = await importSPKI(ensurePem(raw, 'PUBLIC KEY'), 'RSA-OAEP-256');
  return _state.publicKey;
}

function authHeader() {
  // Credstore can be provisioned with two auth styles depending on subaccount
  // defaults:
  //   - `basic` — binding ships `username` + `password`; legacy default.
  //   - `mtls`  — binding ships `username` + `certificate` + `key`; `password`
  //     is absent. New BTP subaccounts default to this. The TLS handshake
  //     authenticates via the client cert; the username still rides as an
  //     identity hint in the Authorization header (no secret part).
  // Diagnosed 2026-06-23 in the DevRel & Community Tools subaccount cutover:
  // `tutorials-credstore` is mTLS-provisioned, so `b.password` is undefined
  // and `Basic <base64-of-username:undefined>` was rejected → every Secrets
  // save 500'd in the admin UI.
  const b = getBinding();
  const secret = isMtlsBinding() ? '' : (b.password ?? '');
  const token = Buffer.from(`${b.username}:${secret}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

/** Detect whether the current binding is mTLS-provisioned. New BTP
 *  subaccounts default to mTLS; legacy ones default to basic auth. We treat
 *  presence of `password` as the unambiguous signal — basic-auth bindings
 *  always ship one, mTLS bindings never do. */
function isMtlsBinding() {
  const b = getBinding();
  if (b.parameters?.authentication?.type) return b.parameters.authentication.type === 'mtls';
  return !b.password;
}

/** Detect whether the binding requires JWE-encrypted POST/PUT/DELETE bodies.
 *  Independent of the auth flavor — a basic-auth binding CAN have payload
 *  encryption enabled, and an mTLS binding CAN have it disabled (though new
 *  subaccounts default to mTLS + payload-encryption-enabled). We treat the
 *  explicit `parameters.encryption.payload === 'enabled'` flag as authoritative
 *  and fall back to presence of `encryption.server_public_key` (which is
 *  ONLY provisioned when encryption is enabled) for older binding shapes
 *  that don't surface the parameters block. */
function isPayloadEncryptionEnabled() {
  const b = getBinding();
  if (b.parameters?.encryption?.payload === 'enabled') return true;
  if (b.parameters?.encryption?.payload === 'disabled') return false;
  return !!b.encryption?.server_public_key;
}

/** JWE-encrypt a JSON envelope using the binding's server_public_key.
 *  Always emits compact serialization (the only serialization the credstore
 *  accepts; flattened JSON serialization triggers `wrong_content_type_for_jwe`
 *  even with Content-Type: application/jose). The `iat` protected header is
 *  MANDATORY — the credstore rejects payloads older than 2 minutes. */
async function encryptPayloadJwe(plaintextObj) {
  const key = await getPublicKey();
  return await new CompactEncrypt(
    new TextEncoder().encode(JSON.stringify(plaintextObj)),
  )
    .setProtectedHeader({
      alg: 'RSA-OAEP-256',
      enc: 'A256GCM',
      iat: Math.floor(Date.now() / 1000),
    })
    .encrypt(key);
}

const FETCH_TIMEOUT_MS = 15_000;

/** Wrap a credstore fetch call with a timeout. AbortError becomes a
 *  readable 'credstore <op> ${alias}: timeout' instead of a bare throw. */
async function credFetch(url, init, opLabel) {
  try {
    const opts = { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    if (isMtlsBinding()) {
      // mTLS path — credstore in new BTP subaccounts authenticates via a
      // client cert during the TLS handshake instead of HTTP basic auth.
      // undici's Agent accepts `connect: { cert, key }` for this. We MUST
      // call undici's fetch directly (imported above as undiciFetch) —
      // Node's global fetch wrapper strips the `dispatcher` option for
      // browser-spec compatibility, silently dropping the client cert.
      // PR #586 missed this and shipped using global fetch; the request
      // went out without a client cert, the credstore TLS handshake
      // failed, and the admin Secrets-save 500'd against every mTLS
      // binding (the new BTP subaccount default since the DevRel &
      // Community Tools cutover on 2026-06-21).
      if (!_state.undiciAgent) {
        const b = getBinding();
        if (!b.certificate || !b.key) {
          throw new Error('credstore binding declares mtls but is missing certificate or key');
        }
        const { Agent: UndiciAgent } = await import('undici');
        _state.undiciAgent = new UndiciAgent({
          connect: { cert: b.certificate, key: b.key },
          keepAliveTimeout: 30_000,
        });
      }
      opts.dispatcher = _state.undiciAgent;
      return await undiciFetch(url, opts);
    }
    // Basic-auth path — legacy bindings without mTLS. Native global fetch
    // is fine here (no dispatcher needed).
    return await fetch(url, opts);
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new Error(`credstore ${opLabel}: timeout after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

// Aliases come from admin input. Allow letters/digits/dot/underscore/hyphen,
// max 128 chars. Rejects path-traversal candidates and weird control chars.
const ALIAS_RE = /^[A-Za-z0-9_.-]{1,128}$/;
function assertAlias(alias) {
  if (typeof alias !== 'string' || !ALIAS_RE.test(alias)) {
    throw new Error('credstore: invalid alias');
  }
}

/** Read a secret value by alias. Returns the plaintext value, or null if
 *  the entry doesn't exist (404). Throws on any other error so caller can
 *  surface it. */
export async function readSecret(alias) {
  assertAlias(alias);
  const b = getBinding();
  const url = `${b.url}/password?name=${encodeURIComponent(alias)}`;
  const res = await credFetch(url, {
    headers: {
      ...authHeader(),
      'sapcp-credstore-namespace': NAMESPACE,
      Accept: 'application/jose',
    },
  }, `read ${alias}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`credstore read ${alias}: ${res.status}`);
  const jwe = await res.text();
  const key = await getPrivateKey();
  const { plaintext } = await compactDecrypt(jwe, key, {
    keyManagementAlgorithms: ['RSA-OAEP-256'],
    contentEncryptionAlgorithms: ['A256GCM'],
  });
  // Credstore wraps the value in a JSON envelope: { value: "...", ... }
  const envelope = JSON.parse(new TextDecoder().decode(plaintext));
  if (typeof envelope.value !== 'string') {
    throw new Error(`credstore read ${alias}: malformed envelope (missing value)`);
  }
  return envelope.value;
}

/** Write a secret value by alias. Creates the entry if missing, updates if
 *  present. JSON.stringify on the body handles values containing quotes,
 *  newlines, Unicode natively. Returns true on success.
 *
 *  Body encoding:
 *  - Payload-encryption-disabled bindings (legacy): plain JSON,
 *    Content-Type: application/json.
 *  - Payload-encryption-enabled bindings (new BTP-subaccount default):
 *    JWE compact-serialization, Content-Type: application/jose. The
 *    plaintext is the same `{name, value}` envelope; we just encrypt it
 *    with the binding's server_public_key first. */
export async function writeSecret(alias, value) {
  assertAlias(alias);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('credstore: empty or non-string value rejected');
  }
  const b = getBinding();
  const url = `${b.url}/password`;
  const envelope = { name: alias, value };

  let body;
  let contentType;
  if (isPayloadEncryptionEnabled()) {
    body = await encryptPayloadJwe(envelope);
    contentType = 'application/jose';
  } else {
    body = JSON.stringify(envelope);
    contentType = 'application/json';
  }

  const res = await credFetch(url, {
    method: 'POST',
    headers: {
      ...authHeader(),
      'sapcp-credstore-namespace': NAMESPACE,
      'Content-Type': contentType,
    },
    body,
  }, `write ${alias}`);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`credstore write ${alias}: ${res.status} ${detail.slice(0, 200)}`);
  }
  LOG.info(`credstore: wrote secret ${alias}`);
  return true;
}

/** Delete a secret by alias. Returns true on success OR 404 (idempotent). */
export async function deleteSecret(alias) {
  assertAlias(alias);
  const b = getBinding();
  const url = `${b.url}/password?name=${encodeURIComponent(alias)}`;
  const res = await credFetch(url, {
    method: 'DELETE',
    headers: { ...authHeader(), 'sapcp-credstore-namespace': NAMESPACE },
  }, `delete ${alias}`);
  if (res.status === 404) return true;       // idempotent delete
  if (!res.ok) throw new Error(`credstore delete ${alias}: ${res.status}`);
  LOG.info(`credstore: deleted secret ${alias}`);
  return true;
}

/** Test-only: clear cached binding so unit tests can swap mocks. */
export function _resetForTests() {
  _state.binding = null;
  _state.privateKey = null;
  _state.publicKey = null;
  _state.undiciAgent = null;
}
