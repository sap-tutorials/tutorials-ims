import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import cds from '@sap/cds';
import { generateKeyPair, exportPKCS8, importJWK, jwtVerify } from 'jose';
import { __setKeyForTest, __resetKeysForTest } from '../../srv/lib/provenance-keys.js';
import { __setFlagForTest, __resetFlagsForTest } from '../../srv/lib/feature-flags/db-flags.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('provenance endpoint', () => {
  let ContentCurrent, Tutorials;
  beforeAll(async () => {
    ({ ContentCurrent, Tutorials } = cds.entities('com.sap.developers.ims'));
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    __setKeyForTest(await exportPKCS8(privateKey));
  });
  afterAll(() => { __resetKeysForTest(); __resetFlagsForTest(); });
  beforeEach(async () => {
    await DELETE.from(ContentCurrent); await DELETE.from(Tutorials);
    await INSERT.into(Tutorials).entries({ ID: cds.utils.uuid(), slug: 'demo' });
    await INSERT.into(ContentCurrent).entries({ slug: 'demo', contentHash: 'h'.repeat(64), sourceCommit: 'a'.repeat(40) });
  });

  it('404s when flag OFF', async () => {
    __setFlagForTest('PROVENANCE_ENVELOPE_ENABLED', false);
    await expect(project.axios.get('/content/tutorials/demo/provenance')).rejects.toMatchObject({ response: { status: 404 } });
  });

  it('serves a verifiable JWS when flag ON', async () => {
    __setFlagForTest('PROVENANCE_ENVELOPE_ENABLED', true);
    const res = await project.axios.get('/content/tutorials/demo/provenance');
    expect(res.status).toBe(200);
    const jwks = await project.axios.get('/.well-known/tutorial-provenance/jwks.json');
    const pub = await importJWK(jwks.data.keys[0], 'EdDSA');
    const { payload } = await jwtVerify(res.data.jws, pub, { issuer: 'https://developers.sap.com' });
    expect(payload.sub).toBe('demo');
    expect(payload.provenance.sourceCommit).toBe('a'.repeat(40));
  });

  it('404s for unknown slug when flag ON', async () => {
    __setFlagForTest('PROVENANCE_ENVELOPE_ENABLED', true);
    await expect(project.axios.get('/content/tutorials/nope/provenance')).rejects.toMatchObject({ response: { status: 404 } });
  });
});
