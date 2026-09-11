import { importPKCS8, exportJWK, calculateJwkThumbprint } from 'jose';

let _testPem; // when set (incl. null), overrides env — for tests only
let _cache;   // memoized { key, kid, jwk } | null

function readPem() {
  if (_testPem !== undefined) return _testPem;
  return process.env.PROVENANCE_SIGNING_KEY || null;
}

async function load() {
  if (_cache !== undefined) return _cache;
  const pem = readPem();
  if (!pem) { _cache = null; return _cache; }
  try {
    const key = await importPKCS8(pem, 'EdDSA', { extractable: true });
    const priv = await exportJWK(key);
    const jwk = { kty: priv.kty, crv: priv.crv, x: priv.x }; // public-only
    const kid = await calculateJwkThumbprint(jwk);
    _cache = { key, kid, jwk: { ...jwk, use: 'sig', alg: 'EdDSA', kid } };
  } catch (e) {
    console.warn('[provenance-keys] failed to load signing key, disabling:', e.message);
    _cache = null;
  }
  return _cache;
}

export async function getSigningKey() {
  const c = await load();
  return c ? { key: c.key, kid: c.kid } : null;
}

export async function getJwks() {
  const c = await load();
  return { keys: c ? [c.jwk] : [] };
}

export function __setKeyForTest(pem) { _testPem = pem; _cache = undefined; }
export function __resetKeysForTest() { _testPem = undefined; _cache = undefined; }
