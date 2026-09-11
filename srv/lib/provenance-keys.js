import { importPKCS8, exportJWK, calculateJwkThumbprint } from 'jose';

// Test overrides live on globalThis so all module instances in the same process
// share them — this avoids the Windows module-duplication issue where
// cds.test('serve') may load a second copy of this file (different file:// URL)
// that wouldn't see a module-local variable set by the test. Same pattern as
// globalThis.__imsFeatureFlagsState__ in feature-flags/db-flags.js.
const _g = (globalThis.__provenanceKeysState__ ??= { testPem: undefined, cache: undefined });

function readPem() {
  if (_g.testPem !== undefined) return _g.testPem;
  return process.env.PROVENANCE_SIGNING_KEY || null;
}

async function load() {
  if (_g.cache !== undefined) return _g.cache;
  const pem = readPem();
  if (!pem) { _g.cache = null; return _g.cache; }
  try {
    const key = await importPKCS8(pem, 'EdDSA', { extractable: true });
    const priv = await exportJWK(key);
    const jwk = { kty: priv.kty, crv: priv.crv, x: priv.x }; // public-only
    const kid = await calculateJwkThumbprint(jwk);
    _g.cache = { key, kid, jwk: { ...jwk, use: 'sig', alg: 'EdDSA', kid } };
  } catch (e) {
    console.warn('[provenance-keys] failed to load signing key, disabling:', e.message);
    _g.cache = null;
  }
  return _g.cache;
}

export async function getSigningKey() {
  const c = await load();
  return c ? { key: c.key, kid: c.kid } : null;
}

export async function getJwks() {
  const c = await load();
  return { keys: c ? [c.jwk] : [] };
}

export function __setKeyForTest(pem) { _g.testPem = pem; _g.cache = undefined; }
export function __resetKeysForTest() { _g.testPem = undefined; _g.cache = undefined; }
