// test/unit/lib/credstore.test.js
// Phase 2-C (#465). Unit tests for BTP Credential Store integration lib.
//
// Mocks native fetch. JWE round-trip uses a fixture key + JWE blob generated
// via jose's generateKeyPair -> exportPKCS8 -> CompactEncrypt at test-authoring
// time (see plan Task 7.1). The fixtures are SAFE to commit: synthetic 2048-bit
// RSA key with no production secret value (`test-secret-value`).

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
