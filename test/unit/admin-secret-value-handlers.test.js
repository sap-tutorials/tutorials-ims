// test/unit/admin-secret-value-handlers.test.js
// Phase 2-C (#465). Unit tests for the 4 OData handlers on Secrets.
//
// Mock strategy (selected after spike of vi.mock/vi.spyOn — see commit body):
//   - vi.mock cannot intercept CDS-runtime-loaded modules (admin-service.js
//     resolves `./lib/credstore.js` through CDS's loader, not vitest's).
//     Same applies to jose imported from credstore.js.
//   - Instead we stand up a fake BTP credstore by:
//       1. Generating a real RSA key pair in the test process.
//       2. Setting VCAP_SERVICES with the real PKCS8 private key.
//       3. Stubbing globalThis.fetch (credstore.js uses native fetch).
//       4. Tests that exercise the read path encrypt their plaintext
//          envelope into a real RSA-OAEP-256/A256GCM JWE that the real
//          jose library will decrypt.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { CompactEncrypt, importSPKI } from 'jose';
import cds from '@sap/cds';

// Step 1: generate a real RSA key pair. The private key (PKCS8 PEM) goes
// into VCAP_SERVICES; the public key encrypts read-path JWEs in tests.
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Step 2: VCAP_SERVICES — must be set BEFORE @sap/xsenv is imported anywhere
// (and BEFORE cds.test boots).
process.env.VCAP_SERVICES = JSON.stringify({
  credstore: [{
    name: 'credstore-mock',
    label: 'credstore',
    tags: ['credstore'],
    credentials: {
      url: 'https://mock-credstore.test',
      username: 'mock-user',
      password: 'mock-pass',
      encryption: {
        client_private_key: privateKey,
      },
    },
  }],
});

// Helper: encrypt a plaintext envelope as a real JWE the production
// jose code-path will decrypt. Returns the compact JWE string that
// credstore.js consumes via `await res.text()` in readSecret.
async function makeJwe(plaintext) {
  const pub = await importSPKI(publicKey, 'RSA-OAEP-256');
  return new CompactEncrypt(new TextEncoder().encode(plaintext))
    .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM' })
    .encrypt(pub);
}

// BLOCKING 2 (verified against test/unit/author-service.test.js): module-top
// cds.test('serve', ...) auto-deploys schema + serves the OData runtime.
const project = cds.test('serve', '--project', '.', '--in-memory');

const ADMIN_USER = { id: 'admin@test', roles: ['Admin'] };

// Fetch stub state. Tests set _fetchHandler before invoking a handler that
// will end up calling globalThis.fetch via credstore.js.
let _origFetch;
let _fetchHandler = null;

beforeAll(() => {
  _origFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url, init) => {
    if (!_fetchHandler) {
      throw new Error('fetch called without a handler set in the current test');
    }
    return _fetchHandler(url, init);
  });
});

afterAll(() => {
  globalThis.fetch = _origFetch;
});

beforeEach(async () => {
  const { Secrets } = cds.entities('com.sap.developers.ims');
  await DELETE.from(Secrets);
  _fetchHandler = null;
  globalThis.fetch.mockClear();
});

async function seedSecret({ key, kind = 'salt', rotationDocsUrl = '' } = {}) {
  const { Secrets } = cds.entities('com.sap.developers.ims');
  const ID = cds.utils.uuid();
  await INSERT.into(Secrets).entries({
    ID, key, kind, rotationDocsUrl,
    description: `test ${key}`,
  });
  return { ID, key, kind };
}

// Helper: invoke a bound action. Wraps the verified `tx.send({ event,
// entity, params, data })` pattern (the canonical CAP V4 shape).
async function callAction(eventName, secretId, data = {}) {
  const srv = await cds.connect.to('AdminService');
  return srv.tx({ user: ADMIN_USER }, (tx) =>
    tx.send({ event: eventName, entity: 'AdminService.Secrets', params: [{ ID: secretId }], data })
  );
}

// Simple response factory matching the subset of Response that credstore.js
// uses (status, ok, text(), JSON not used by these paths).
function fakeRes({ status = 200, body = '' } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  };
}

describe('setSecretValue (#465)', () => {
  it('happy-path: writes credstore + stamps lastRotatedAt', async () => {
    // #1018: writer path now issues a POST followed by a GET (read-back
    // verify). The mock returns 201 to the write and a real JWE envelope
    // matching `newval` to the read — same value → guard passes.
    _fetchHandler = async (url, init) => {
      if ((init?.method ?? 'GET') === 'POST') {
        expect(String(url)).toContain('/password');
        const body = JSON.parse(init.body);
        expect(body).toEqual({ name: 'TEST_SET_OK', value: 'newval' });
        return fakeRes({ status: 201 });
      }
      // read-back
      const jwe = await makeJwe(JSON.stringify({ value: 'newval' }));
      return fakeRes({ status: 200, body: jwe });
    };
    const { ID } = await seedSecret({ key: 'TEST_SET_OK' });
    const result = await callAction('setSecretValue', ID, { value: 'newval' });
    expect(result.written).toBe(true);
    expect(result.lastRotatedAt).toBeTruthy();
  });

  it('rejects empty value with 400', async () => {
    const { ID } = await seedSecret({ key: 'TEST_SET_REJECT' });
    await expect(callAction('setSecretValue', ID, { value: '' }))
      .rejects.toMatchObject({ code: 400 });
  });

  // #1018 — silent-write-failure guard. If the credstore returns 2xx to
  // the POST but a subsequent read returns 404 (or a mismatched value),
  // treat the write as unverified and 500 the operation. Regression
  // canary for the 2026-07-06 CONTENT_API_KEY silent-drift outage.
  it('#1018: read-back miss (write claimed OK, read returned null) fails with 500', async () => {
    _fetchHandler = async (url, init) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return fakeRes({ status: 201 });   // write "succeeded"
      }
      return fakeRes({ status: 404 });     // …but value not readable
    };
    const { ID } = await seedSecret({ key: 'TEST_SET_MISS_1018' });
    await expect(callAction('setSecretValue', ID, { value: 'newval' }))
      .rejects.toMatchObject({ code: 500 });
  });

  it('#1018: read-back mismatch (stale value) fails with 500', async () => {
    _fetchHandler = async (url, init) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return fakeRes({ status: 201 });
      }
      const jwe = await makeJwe(JSON.stringify({ value: 'STALE_DIFFERENT_VALUE' }));
      return fakeRes({ status: 200, body: jwe });
    };
    const { ID } = await seedSecret({ key: 'TEST_SET_MISMATCH_1018' });
    await expect(callAction('setSecretValue', ID, { value: 'newval' }))
      .rejects.toMatchObject({ code: 500 });
  });
});

describe('rotateSecretValue (#465)', () => {
  it('self-gen kind (salt): mints 64-char hex + writes', async () => {
    let observedValue = null;
    _fetchHandler = async (url, init) => {
      if ((init?.method ?? 'GET') === 'POST') {
        const body = JSON.parse(init.body);
        observedValue = body.value;
        return fakeRes({ status: 201 });
      }
      // read-back — echo the just-written value so the #1018 guard passes
      const jwe = await makeJwe(JSON.stringify({ value: observedValue }));
      return fakeRes({ status: 200, body: jwe });
    };
    const { ID } = await seedSecret({ key: 'TEST_ROT_SALT', kind: 'salt' });
    const result = await callAction('rotateSecretValue', ID);
    expect(result.rotated).toBe(true);
    expect(result.reason).toBe('self-generated');
    expect(result.newValue).toMatch(/^[0-9a-f]{64}$/);
    expect(observedValue).toBe(result.newValue);
  });

  it('self-gen kind (content-api-key): same shape', async () => {
    let observedValue = null;
    _fetchHandler = async (url, init) => {
      if ((init?.method ?? 'GET') === 'POST') {
        observedValue = JSON.parse(init.body).value;
        return fakeRes({ status: 201 });
      }
      const jwe = await makeJwe(JSON.stringify({ value: observedValue }));
      return fakeRes({ status: 200, body: jwe });
    };
    const { ID } = await seedSecret({ key: 'TEST_ROT_API', kind: 'content-api-key' });
    const result = await callAction('rotateSecretValue', ID);
    expect(result.rotated).toBe(true);
    expect(result.newValue).toMatch(/^[0-9a-f]{64}$/);
  });

  it('vendor-side kind (github-pat): returns rotated:false + rotationDocsUrl', async () => {
    // Vendor-side path never calls fetch — leave handler null so any
    // accidental call would throw and fail the test loudly.
    const { ID } = await seedSecret({
      key: 'TEST_ROT_GH', kind: 'github-pat',
      rotationDocsUrl: 'https://docs.example.com/rotate',
    });
    const result = await callAction('rotateSecretValue', ID);
    expect(result.rotated).toBe(false);
    expect(result.reason).toBe('vendor-side');
    expect(result.rotationDocsUrl).toBe('https://docs.example.com/rotate');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // #1018 — self-gen rotation must also gate on read-back verify.
  it('#1018: self-gen rotation with missing read-back fails with 500', async () => {
    _fetchHandler = async (url, init) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return fakeRes({ status: 201 });
      }
      return fakeRes({ status: 404 });   // read-back can't see the write
    };
    const { ID } = await seedSecret({ key: 'TEST_ROT_MISS_1018', kind: 'salt' });
    await expect(callAction('rotateSecretValue', ID))
      .rejects.toMatchObject({ code: 500 });
  });
});

describe('clearSecretValue (#465)', () => {
  it('happy-path: deletes credstore entry', async () => {
    let observed = null;
    _fetchHandler = async (url, init) => {
      observed = { url: String(url), method: init.method };
      return fakeRes({ status: 200 });
    };
    const { ID } = await seedSecret({ key: 'TEST_CLEAR' });
    const result = await callAction('clearSecretValue', ID);
    expect(result.cleared).toBe(true);
    expect(observed.method).toBe('DELETE');
    expect(observed.url).toContain('name=TEST_CLEAR');
  });
});

describe('revealSecretValue (#465)', () => {
  it('happy-path: returns value + expiresAt ~30s ahead', async () => {
    // Encrypt the plaintext envelope as a real RSA-OAEP-256 / A256GCM JWE
    // — the production jose decrypt path then verifies it.
    const jwe = await makeJwe(JSON.stringify({ value: 'secret-plaintext' }));
    _fetchHandler = async () => fakeRes({ status: 200, body: jwe });
    const { ID } = await seedSecret({ key: 'TEST_REVEAL' });
    const result = await callAction('revealSecretValue', ID);
    expect(result.value).toBe('secret-plaintext');
    const delta = new Date(result.expiresAt).getTime() - Date.now();
    expect(delta).toBeGreaterThan(25_000);
    expect(delta).toBeLessThanOrEqual(30_000);
  });

  it('when no value stored: rejects with 404', async () => {
    _fetchHandler = async () => fakeRes({ status: 404 });
    const { ID } = await seedSecret({ key: 'TEST_NO_VAL' });
    await expect(callAction('revealSecretValue', ID))
      .rejects.toMatchObject({ code: 404 });
  });
});

// Regression test for the 2026-06-22 DEV bootstrap crash. When the Secrets
// metadata row was added via "Add Tracked Secret" in /admin-ui/#secrets-display,
// POST /admin/Secrets returned 502 because @cap-js/audit-logging crashed in
// addDataSubjectForDetailsEntity() — the stale @PersonalData.IsPotentiallyPersonal
// field annotations on Secrets implied a DataSubject parent that doesn't exist.
// Removing those annotations (keeping EntitySemantics: 'Other') silences the
// crash. This test exercises the AdminService projection path that the UI
// uses (NOT the raw entity INSERT path the other tests in this file use),
// so the audit-logging plugin's CRUD interceptor fires.
describe('Secrets entity CREATE (#465 regression)', () => {
  it('POST /admin/Secrets succeeds without crashing audit-logging', async () => {
    const srv = await cds.connect.to('AdminService');
    const created = await srv.tx({ user: ADMIN_USER }, (tx) =>
      tx.create('Secrets').entries({
        key: 'TEST_NEW_SECRET',
        description: 'created via projection — should not crash audit-logging',
        kind: 'salt',
        rotationOwner: 'admin@test',
      })
    );
    expect(created).toBeDefined();
    // CAP 10 returns InsertResult (iterable of created keys), not the full
    // row. Read back explicitly to verify the row landed. Old shapes handled
    // for back-compat: row/array-of-rows, and the historical mock that
    // returned the payload.
    let row;
    if (created?.key) {
      row = created;
    } else if (Array.isArray(created) && created[0]?.key) {
      row = created[0];
    } else {
      const db = await cds.connect.to('db');
      const { Secrets } = cds.entities('com.sap.developers.ims');
      row = await SELECT.one.from(Secrets).where({ key: 'TEST_NEW_SECRET' });
    }
    expect(row?.key).toBe('TEST_NEW_SECRET');
  });
});
