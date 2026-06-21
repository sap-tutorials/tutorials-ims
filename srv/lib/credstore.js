// srv/lib/credstore.js
// BTP Credential Store integration. Phase 2-C (#465).
//
// Layered above @sap/xsenv (binding lookup) + native fetch + jose (JWE-decrypt).
// Single chokepoint for all credstore I/O — keeps the security audit surface
// small and makes mocking trivial in unit tests.

import { getServices } from '@sap/xsenv';
import { compactDecrypt, importPKCS8 } from 'jose';
import cds from '@sap/cds';

const LOG = cds.log('credstore');
const NAMESPACE = 'tutorials';   // single namespace per env (Phase 2-C spec)

// Cache stored on globalThis so module-singleton multiplicity (Vitest+CDS on
// Windows) doesn't produce divergent caches across instances. Same pattern as
// srv/lib/runtime-config/*-settings.js after #491 final-review fix. The memory
// [feedback_module_singletons_in_vitest_cds] has fired 4× already — preempting here.
const STATE_KEY = Symbol.for('com.sap.developers.ims:credstore');
const _state = (globalThis[STATE_KEY] ??= { binding: null, privateKey: null });

function getBinding() {
  if (_state.binding) return _state.binding;
  const services = getServices({ credstore: { tag: 'credstore' } });
  _state.binding = services.credstore;
  return _state.binding;
}
async function getPrivateKey() {
  if (_state.privateKey) return _state.privateKey;
  const binding = getBinding();
  const pem = binding.encryption?.client_private_key;
  if (!pem) {
    throw new Error('credstore binding missing encryption.client_private_key');
  }
  // jose's importPKCS8 expects PEM with proper headers. The second arg here
  // sets key.algorithm metadata for jose's introspection — it does NOT
  // restrict what compactDecrypt accepts. The actual algorithm-confusion
  // defense lives at the compactDecrypt call site in readSecret() below,
  // via keyManagementAlgorithms + contentEncryptionAlgorithms options.
  _state.privateKey = await importPKCS8(pem, 'RSA-OAEP-256');
  return _state.privateKey;
}

function authHeader() {
  const b = getBinding();
  const token = Buffer.from(`${b.username}:${b.password}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

const FETCH_TIMEOUT_MS = 15_000;

/** Wrap a credstore fetch call with a timeout. AbortError becomes a
 *  readable 'credstore <op> ${alias}: timeout' instead of a bare throw. */
async function credFetch(url, init, opLabel) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
 *  newlines, Unicode natively. Returns true on success. */
export async function writeSecret(alias, value) {
  assertAlias(alias);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('credstore: empty or non-string value rejected');
  }
  const b = getBinding();
  const url = `${b.url}/password`;
  const body = { name: alias, value };
  const res = await credFetch(url, {
    method: 'POST',
    headers: {
      ...authHeader(),
      'sapcp-credstore-namespace': NAMESPACE,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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
}
