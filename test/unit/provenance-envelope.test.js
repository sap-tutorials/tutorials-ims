import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { generateKeyPair, exportPKCS8, importJWK, jwtVerify, decodeJwt } from 'jose';
import { buildEnvelope, __clearEnvelopeCacheForTest } from '../../srv/lib/provenance-envelope.js';
import { getJwks, __setKeyForTest, __resetKeysForTest } from '../../srv/lib/provenance-keys.js';

let pem;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  pem = await exportPKCS8(privateKey);
});
afterEach(() => { __resetKeysForTest(); __clearEnvelopeCacheForTest(); });

const base = {
  slug: 'my-tutorial', contentHash: 'c'.repeat(64), sourceCommit: 'a'.repeat(40),
  builtAt: '2026-09-10T00:00:00.000Z',
  report: { status: 'DONE', openHighCount: 0, openMediumCount: 0, runAt: '2026-09-05T00:00:00.000Z', model: 'gpt-x' },
  now: Date.UTC(2026, 8, 11),
};

describe('buildEnvelope', () => {
  it('returns null when no signing key (fail-open)', async () => {
    __setKeyForTest(null);
    expect(await buildEnvelope(base)).toBeNull();
  });

  it('signs a verifiable JWS with two distinct claim groups', async () => {
    __setKeyForTest(pem);
    const { jws, claims } = await buildEnvelope(base);
    const pub = await importJWK((await getJwks()).keys[0], 'EdDSA');
    const { payload } = await jwtVerify(jws, pub, { issuer: 'https://developers.sap.com', currentDate: new Date(base.now) });
    expect(payload.sub).toBe('my-tutorial');
    expect(payload.contentHash).toBe(base.contentHash);
    expect(payload.provenance).toMatchObject({ sourceRepo: 'sap-tutorials/Tutorials', sourceCommit: base.sourceCommit, builtAt: base.builtAt });
    expect(payload.freshness).toMatchObject({ confidence: 'high', lastScanned: base.report.runAt, openHighCount: 0, detectorModel: 'gpt-x' });
    expect(payload.exp - payload.iat).toBe(86400);
    expect(claims.freshness.confidence).toBe('high');
  });

  it('tampered payload fails verification', async () => {
    __setKeyForTest(pem);
    const { jws } = await buildEnvelope(base);
    const pub = await importJWK((await getJwks()).keys[0], 'EdDSA');
    const [h, , s] = jws.split('.');
    const forged = Buffer.from(JSON.stringify({ ...decodeJwt(jws), contentHash: 'f'.repeat(64) })).toString('base64url');
    await expect(jwtVerify(`${h}.${forged}.${s}`, pub)).rejects.toThrow();
  });

  it('emits unknown confidence + null sourceCommit honestly', async () => {
    __setKeyForTest(pem);
    const { claims } = await buildEnvelope({ ...base, sourceCommit: null, report: null });
    expect(claims.freshness.confidence).toBe('unknown');
    expect(claims.provenance.sourceCommit).toBeNull();
  });
});
