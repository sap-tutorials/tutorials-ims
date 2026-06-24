// test/unit/lib/credstore.test.js
// Phase 2-C (#465). Unit tests for BTP Credential Store integration lib.
//
// Mocks native fetch. JWE round-trip uses a fixture key + JWE blob generated
// via jose's generateKeyPair -> exportPKCS8 -> CompactEncrypt at test-authoring
// time (see plan Task 7.1). The fixtures are SAFE to commit: synthetic 2048-bit
// RSA key with no production secret value (`test-secret-value`).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Fixtures generated once via:
//   import { generateKeyPair, exportPKCS8, exportSPKI, CompactEncrypt, importSPKI } from 'jose';
// See plan docs/superpowers/plans/2026-06-20-issue-465-encrypted-secrets-credstore.md
// Task 7 Step 7.1 for the exact generation script.
const FIXTURE_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDVPO88Mb278Gk/
C28Rjh1OLd/OLhhg3je7sx9G5cyUtWbBJmytK1/a1klpKTbsF94rkRcyOLN/7D2z
SFqbk5kTDCrPGUrYb5ho4NK4ZDY7W1f2Sc58g1aoMfY6D1JP5uSOUwKiBNclxHGZ
sie54yrR/WSCcUnQ5XbETQoRVHDu1pRF19E+UfwIHbJhLbWPEyVVFeECctao8ot4
JtwSJTijqldcZ/WKmaaSpKN2LU5gdIqFNETd7qP17iwb90Y6Y4PbLkkzIwL9qmc7
euoThPb6KNUIUMQR/GCZTlN7x1fN/6pEmfr3Pj0zycsDXQb/uNAkTHuZ1h3FHyYk
2hgM0WFtAgMBAAECggEAF7PSAN4jkbIvtLUL58bk/YVuYO/xQEU7KzdGJP6Srr36
OcKQZnBRk5TprJGK/BPMG4oharDwTOog0p6aibwOkhYyZPpR/jxrU88XxSzIdXEa
FjOOivsbZQ9GqB3/X4fSBHr4KjPBCX7sRLIPpeM5JYXVyAUZOCnleXz5v0LkWbvW
5Kna8u8rO/KW0we7xPtRnjjjs7zKblydN2uYt94rkpVq9XGPz2BehyNa4a4huGdc
aTMDHy8ygpVa8GZcnCKk1XTFzXfr6fDmsDgGjn7+sQlx5TgeDGFTML+0sU1mVwDh
Oap8VtcAbqQ+kKPJCV6CUBtNaWDCip7feTndOvHcyQKBgQDt4xxKSGhEcZeVWKa3
IRmIKfQ21FYdaxSWA4EDuSkCa1lesJBA930reopPHgSvMda8lUGNaf3zILbxwdUa
r0Qc1GoERxqQTTW7PXbl0ekEyThMAfcQV7qndvj56OALh67nPAdkeyDoxF4RPWGD
nwRseNHhL3aZNQV6EYHxqGlYVQKBgQDleV0tDrOQ+wJ0F9sfMR1txzbJp25ccbDi
9gVCYXnUIUf2+wQ/YymglN6YqLQWASGTVgd95G+QU1YC7uDrhhak+CTWwJ/3apLj
q54zanx2CuBI1RS8RqKx3a21HkOnmCT8DLQB8jSsDDoAXCYrVUOsjxJIpsspCj0u
BKAmAypcuQKBgFejY7i6FC+i6YVLs5+jwhQ34JCSiWctG9hoUg9dF46cncAUrBBD
HQn3ixy6ol8orUOseQnwEm6PjtZh4nCCQUWdu7D3wQGIcFMawcLJIl9xAhx+XNbY
extW6UKoWGHnCriFlPOfqPAX58/SHSqwWqDbofaj1b17mxjtekHdGXJBAoGBAKg7
3Mq+v3jn/Xl9T+FDUc78wTb/8BIIK+WI9nwfGIEj0S3KA+gw3ADlg3gqHrUPKT1q
Ud3DDuOhpSpLVUx2pr1VSzTCTcTHNl+Bn18Uj6C/AoWC6kvKAVcjLUneoT0Kdvru
mT3gAyurXw6KgFU+knm8/muTFNjGr+m/7GVR5snJAoGAUk+j7Bb5SlGlCJ0hyh7d
5MbXP+lEq+bfMKeUHghynYYdWPj6X1jPgoH4Iio0p5fXEmyfwgny3LS97j8BWHz4
IFlDvxaSeFmcHydIMaqFlw7IV9CD+iEp7pVyj52qiHOr3z15Sla/UqetIvB4+G8T
DyiiQg2P7xKbW9LP9Ciw9Yo=
-----END PRIVATE KEY-----
`;
const FIXTURE_JWE = `eyJhbGciOiJSU0EtT0FFUC0yNTYiLCJlbmMiOiJBMjU2R0NNIn0.RnxXz7HY2NWHY77PP8rKwegFObB_hv4lUHduQfFS4QrDUHNRSJg5odDm-0NpYip95tPjBEMGBqsS6UVVzBFL-ITASrPMSZEtqy8U8ms4cFkYw0Yp3HuQnBFu5z8-yki64FBJOTbMOYieEgMhpjEXO88024_MmCHL6Ue4vpb3RYETSF1SbZBcukuXpiFG7YV7E3_i-jWtleaG2FgYH4Lx-JYAjKH2TJlsIvo796z6USdIZVqnRRPfcYM6geL33-vbtR9ApOEXftQRdrrepoTOpAS2XlkyTrm2leJWEkgdeTCCVbYpQJmvIu5t9VOYghyg3LztHyeadnIjbO0cKxBpXw.sGMx9pWTrcFNJBBJ.rqseKoBGelduFMMdVngoqahN8IRj_XNC3g1AB2k.vwUmUCIRQVvxVCYGiap6xQ`;

// Set fake binding BEFORE importing credstore -- xsenv reads VCAP_SERVICES
// on first getServices() call. Must be in place before dynamic import below.
process.env.VCAP_SERVICES = JSON.stringify({
  credstore: [{
    tags: ['credstore'],
    credentials: {
      url: 'https://credstore.example.com',
      username: 'testuser',
      password: 'testpass',
      encryption: {
        client_private_key: FIXTURE_PEM,
      },
    },
  }],
});

// Import AFTER setting VCAP_SERVICES.
const { readSecret, writeSecret, deleteSecret, _resetForTests } =
  await import('../../../srv/lib/credstore.js');

beforeEach(() => {
  _resetForTests();
  vi.unstubAllGlobals();
});

describe('readSecret (#465)', () => {
  it('returns null on 404 (entry doesn\'t exist)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 404, ok: false, text: () => Promise.resolve(''),
    }));
    const result = await readSecret('MISSING_KEY');
    expect(result).toBeNull();
  });

  it('throws on non-200/404 (network error, auth failure)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 401, ok: false, text: () => Promise.resolve('unauthorized'),
    }));
    await expect(readSecret('SOMEKEY')).rejects.toThrow(/credstore read SOMEKEY: 401/);
  });

  it('JWE-decrypt round-trip with fixture private key + JWE blob', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200, ok: true,
      text: () => Promise.resolve(FIXTURE_JWE),
    }));
    const result = await readSecret('TEST_KEY');
    expect(result).toBe('test-secret-value');
  });

  it('throws on invalid alias (security guard)', async () => {
    await expect(readSecret('BAD KEY')).rejects.toThrow(/invalid alias/);
    await expect(readSecret('')).rejects.toThrow(/invalid alias/);
    await expect(readSecret('X'.repeat(200))).rejects.toThrow(/invalid alias/);
  });
});

describe('writeSecret (#465)', () => {
  it('POSTs to /password with namespace + Basic auth headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await writeSecret('TEST_KEY', 'new-value');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://credstore.example.com/password');
    expect(opts.method).toBe('POST');
    expect(opts.headers['sapcp-credstore-namespace']).toBe('tutorials');
    expect(opts.headers.Authorization).toMatch(/^Basic /);
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ name: 'TEST_KEY', value: 'new-value' });
  });

  it('rejects empty or non-string value (security guard)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(writeSecret('TEST_KEY', '')).rejects.toThrow(/empty or non-string/);
    await expect(writeSecret('TEST_KEY', null)).rejects.toThrow(/empty or non-string/);
    await expect(writeSecret('TEST_KEY', 42)).rejects.toThrow(/empty or non-string/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Fixture keypair for the payload-encryption write path. Generated once via
// jose's generateKeyPair('RSA-OAEP-256', { modulusLength: 2048 }). Safe to
// commit — synthetic, used only by these tests, never touches a real binding.
const FIXTURE_SERVER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAypw0Amn0OygTh03EhJ87
d4EPY2iV8tUYaCbJIz6mvJFcNx+/8edSkTRyypIR0ezh54b0ERn5+AagSxe4DWob
q/zm1vhYTf/RYkafVb8I+KmTeV4InUA0TOsDsCVUXFJFMP6qDl3vO/TMkXkcAWSq
oGmPtA3aR6+HdS85NfXnTMVb7Q/l5xZVMl0GSTMX0Po6iJpwk7eMHKOj/qB55XMO
FqGr4BO49v3bs9KEPE2k+MrwSRgqZfao9YUD6NuKt3sELm8B6+EFVueTr8Vl07Cq
jaPLKCIig6a293uvLpidgi5SyMxh7tyQOeJIQ/OCovJdzLTmzVR2kIriw/Cfspdb
nQIDAQAB
-----END PUBLIC KEY-----`;
const FIXTURE_SERVER_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDKnDQCafQ7KBOH
TcSEnzt3gQ9jaJXy1RhoJskjPqa8kVw3H7/x51KRNHLKkhHR7OHnhvQRGfn4BqBL
F7gNahur/ObW+FhN/9FiRp9Vvwj4qZN5XgidQDRM6wOwJVRcUkUw/qoOXe879MyR
eRwBZKqgaY+0DdpHr4d1Lzk19edMxVvtD+XnFlUyXQZJMxfQ+jqImnCTt4wco6P+
oHnlcw4WoavgE7j2/duz0oQ8TaT4yvBJGCpl9qj1hQPo24q3ewQubwHr4QVW55Ov
xWXTsKqNo8soIiKDprb3e68umJ2CLlLIzGHu3JA54khD84Ki8l3MtObNVHaQiuLD
8J+yl1udAgMBAAECggEAWkz+HSlN8eOtuHsfoCA758o8qoiddCong5vtv2iX9akv
mV3sNYts0Ey48LHjgVV7Za5PLyQNtc52OKGspUXqaWABHkR3TuQ6VPu23geTnwgt
M0WGv1czOCjybtpkW/VK40hNULPrASTc2+VHZxOPvIjvxEb8R0DjNYZDkFo1qY/t
ovGmdA8Xb13LMtEZcC0EGLfL5t7HpudD7Yj3MS6RUfl0oZiDZaREa2q+RLCljx77
CXeTj/LeDJI1/g6/4B1Ld1Y2CdRybBiV+doMX2aPfz/frjVroDE01E97wceqgD3R
BcwwX/0kCHflNEun53v18sjID8wwmqqX9YtgzMXj/QKBgQDkPMKVNUPhjrp725xd
jCqA2jYXlIpJnDAiJFyjs1EmVOG+tiRNmKJZwJ4TNxCD76OB9SWKjwgOdFd75nq1
a64jlQnENNgUMvf9tvrrI/bFkS2EfZfZHi+8SYfKJYd1H9toEYdt+QZGQlDDWD2M
RsGWffDqOW73xmBnuo1ZY15ghwKBgQDjQWu5ahtXUT0ULpHp6OdaEE8dYlTckwYT
fiShBVJycLdAyyEUJMlyr2bf7jBo4Tf1k5ku5YnfwdkmuMtfxDIXshH1T82l/4vC
KIEVgYnJlxtjvK6AtAfPpEPpys0FSsnkPgv5VNJEEDJ0U/k8feZSLGTVKLbSOm+7
SZWP13WfuwKBgQCK19uXYTvWLzmKt2I8FlSU5ioZ1ib5+KXfXzdr7l3jb6eUmMEk
40GAUAjZr5nAaTuSh0s7Kx+/i07c9KyZSNQ6mSPD1FHOl+L82R9zhAFO1q5V9wE0
94QairCsbIAm5CZY/LDiWadTfmwbKcbnWvPRVPQFyMKUwH1NHNN4GVcEaQKBgGv8
3FmhCBj365Q5hPCn0bfEZDPMVBL0ckC1AmbZhpIG6a2KWM+fo3Ix0yq5nptX2iWB
25qjTF7dWHjD+zAopL0JyurM3yXwRtMeOCimA3mdqlA8ipdx9PxATF0+FypanZEt
wrbaDYh2QeNxO8/464dEvS1lSWqghhNzJfTSJ3ydAoGBAIFHB+ED52JqDopuzTi2
ofxacxFqbpWeey9kK+t+ZijPyCEyFCeSRJwP2uhYjm1OMK0T0ZC+DWxPmNotVa3V
lxv6KSSp/9CCvYjBmzo2Cnk1u188L14Tj8yrA+TzHEb1iUhut3xfMQylGTXhjdP7
dwRwdN3CBAx/muPrVuxFpSUB
-----END PRIVATE KEY-----`;

describe('writeSecret with payload encryption enabled (post-#588 follow-up)', () => {
  // Mutate VCAP_SERVICES to a payload-encryption-enabled binding shape and
  // reset the credstore module's cached binding so it re-reads. The module
  // itself is the same instance (vitest doesn't allow dynamic re-imports
  // with cache-busting query strings under its Vite-style import handling);
  // _resetForTests() is the public seam.
  const ORIGINAL_VCAP = process.env.VCAP_SERVICES;
  beforeEach(() => {
    process.env.VCAP_SERVICES = JSON.stringify({
      credstore: [{
        tags: ['credstore'],
        credentials: {
          url: 'https://credstore.example.com',
          username: 'testuser',
          password: 'testpass',
          encryption: {
            client_private_key: FIXTURE_PEM,
            server_public_key: FIXTURE_SERVER_PUBLIC_KEY,
          },
          parameters: {
            encryption: { payload: 'enabled' },
          },
        },
      }],
    });
    // @sap/xsenv caches the parsed services on first call. Force re-read by
    // clearing the credstore module's cache; @sap/xsenv reads from
    // process.env.VCAP_SERVICES fresh each time when called with explicit
    // {tag} (no internal cache for that path).
    _resetForTests();
  });
  afterEach(() => {
    process.env.VCAP_SERVICES = ORIGINAL_VCAP;
    _resetForTests();
  });

  it('encrypts the body as a JWE compact string with Content-Type: application/jose', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 201, ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await writeSecret('TEST_KEY', 'my-secret-value');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://credstore.example.com/password');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/jose');

    // JWE compact serialization is 5 base64url segments separated by '.'
    expect(typeof opts.body).toBe('string');
    expect(opts.body.split('.').length).toBe(5);

    // Decrypt with the fixture private key and verify the plaintext envelope.
    const { compactDecrypt, importPKCS8 } = await import('jose');
    const privKey = await importPKCS8(FIXTURE_SERVER_PRIVATE_KEY_PEM, 'RSA-OAEP-256');
    const { plaintext, protectedHeader } = await compactDecrypt(opts.body, privKey, {
      keyManagementAlgorithms: ['RSA-OAEP-256'],
      contentEncryptionAlgorithms: ['A256GCM'],
    });
    expect(protectedHeader.alg).toBe('RSA-OAEP-256');
    expect(protectedHeader.enc).toBe('A256GCM');
    // Mandatory `iat` header, within 2 minutes of now.
    expect(typeof protectedHeader.iat).toBe('number');
    expect(Math.abs(Math.floor(Date.now() / 1000) - protectedHeader.iat)).toBeLessThan(120);

    const envelope = JSON.parse(new TextDecoder().decode(plaintext));
    expect(envelope).toEqual({ name: 'TEST_KEY', value: 'my-secret-value' });
  });

  it('surfaces the credstore 415 error verbatim when the body would be malformed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 415, ok: false,
      text: () => Promise.resolve('{"errorCode":"wrong_content_type_for_jwe"}'),
    }));
    await expect(writeSecret('TEST_KEY', 'v')).rejects.toThrow(
      /credstore write TEST_KEY: 415 .*wrong_content_type_for_jwe/,
    );
  });

  it('accepts raw base64-DER keys without PEM headers (live-binding shape)', async () => {
    // mTLS bindings in new BTP subaccounts ship encryption.* keys as bare
    // base64 strings (no PEM headers). Verify both keys are PEM-wrapped
    // internally so jose can import them.
    const stripPem = (pem) =>
      pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, '');
    process.env.VCAP_SERVICES = JSON.stringify({
      credstore: [{
        tags: ['credstore'],
        credentials: {
          url: 'https://credstore.example.com',
          username: 'testuser',
          password: 'testpass',
          encryption: {
            client_private_key: stripPem(FIXTURE_PEM),
            server_public_key: stripPem(FIXTURE_SERVER_PUBLIC_KEY),
          },
          parameters: { encryption: { payload: 'enabled' } },
        },
      }],
    });
    _resetForTests();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 201, ok: true }));
    await expect(writeSecret('TEST_KEY', 'value-for-raw-keys')).resolves.toBe(true);
    // If we got here without throwing on importSPKI / importPKCS8, the
    // ensurePem wrapping worked.
  });
});

describe('deleteSecret (#465)', () => {
  it('returns true on 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true }));
    expect(await deleteSecret('TEST_KEY')).toBe(true);
  });

  it('returns true on 404 (idempotent)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 404, ok: false, text: () => Promise.resolve(''),
    }));
    expect(await deleteSecret('MISSING_KEY')).toBe(true);
  });
});
