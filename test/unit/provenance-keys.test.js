import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { generateKeyPair, exportPKCS8, jwtVerify, importJWK } from 'jose';
import { getSigningKey, getJwks, __setKeyForTest, __resetKeysForTest } from '../../srv/lib/provenance-keys.js';

let pem;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  pem = await exportPKCS8(privateKey);
});
afterEach(() => __resetKeysForTest());

describe('provenance-keys', () => {
  it('returns null signer when no key configured', async () => {
    __setKeyForTest(null);
    expect(await getSigningKey()).toBeNull();
    expect((await getJwks()).keys).toEqual([]);
  });

  it('loads an Ed25519 signer and publishes a matching public JWK', async () => {
    __setKeyForTest(pem);
    const signer = await getSigningKey();
    expect(signer).not.toBeNull();
    expect(signer.kid).toMatch(/.+/);
    const jwks = await getJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', use: 'sig', alg: 'EdDSA', kid: signer.kid });
    expect(jwks.keys[0].d).toBeUndefined(); // never leak the private scalar
    // round-trip: sign with signer, verify with the published public JWK
    const { SignJWT } = await import('jose');
    const jws = await new SignJWT({ t: 1 }).setProtectedHeader({ alg: 'EdDSA', kid: signer.kid }).sign(signer.key);
    const pub = await importJWK(jwks.keys[0], 'EdDSA');
    const { payload } = await jwtVerify(jws, pub);
    expect(payload.t).toBe(1);
  });
});
