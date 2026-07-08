// test/unit/secret-presence.test.js
// #1018 — unit tests for the shared credstore-presence probe used by:
//   1) srv/jobs/secret-expiry-check.js daily cron
//   2) srv/admin-service.js secretWarnings() popover function
//   3) srv/admin-service.js Secrets after('READ') hook
//
// Uses the same fake-credstore harness as admin-secret-value-handlers.test.js:
// generate a real RSA key pair, seed VCAP_SERVICES, stub globalThis.fetch.
// Real JWEs are constructed for the read path so the production jose code
// runs against them.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { CompactEncrypt, importSPKI } from 'jose';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

process.env.VCAP_SERVICES = JSON.stringify({
  credstore: [{
    name: 'credstore-mock',
    label: 'credstore',
    tags: ['credstore'],
    credentials: {
      url: 'https://mock-credstore.test',
      username: 'mock-user',
      password: 'mock-pass',
      encryption: { client_private_key: privateKey },
    },
  }],
});

async function makeJwe(plaintext) {
  const pub = await importSPKI(publicKey, 'RSA-OAEP-256');
  return new CompactEncrypt(new TextEncoder().encode(plaintext))
    .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM' })
    .encrypt(pub);
}

function fakeRes({ status = 200, body = '' } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  };
}

let _origFetch;
let _fetchHandler = null;

// Dynamic import so process.env.VCAP_SERVICES is set before credstore.js's
// binding lookup runs.
let checkSecretPresence, _resetForTests, invalidatePresence;

beforeAll(async () => {
  _origFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url, init) => {
    if (!_fetchHandler) {
      throw new Error('fetch called without a handler set in the current test');
    }
    return _fetchHandler(url, init);
  });
  const mod = await import('../../srv/lib/secret-presence.js');
  checkSecretPresence = mod.checkSecretPresence;
  invalidatePresence = mod.invalidatePresence;
  _resetForTests = mod._resetForTests;
});

afterAll(() => {
  globalThis.fetch = _origFetch;
});

beforeEach(() => {
  _resetForTests();
  _fetchHandler = null;
  globalThis.fetch.mockClear();
});

describe('checkSecretPresence (#1018)', () => {
  it('returns true when readSecret returns a non-null value', async () => {
    _fetchHandler = async () => {
      const jwe = await makeJwe(JSON.stringify({ value: 'present-value' }));
      return fakeRes({ status: 200, body: jwe });
    };
    expect(await checkSecretPresence('PRESENT_KEY')).toBe(true);
  });

  it('returns false when readSecret returns null (404)', async () => {
    _fetchHandler = async () => fakeRes({ status: 404 });
    expect(await checkSecretPresence('MISSING_KEY')).toBe(false);
  });

  it('returns false when readSecret throws (transport error)', async () => {
    _fetchHandler = async () => fakeRes({ status: 500 });
    expect(await checkSecretPresence('BROKEN_KEY')).toBe(false);
  });

  it('caches per-alias — second call within TTL does not re-fetch', async () => {
    let callCount = 0;
    _fetchHandler = async () => {
      callCount += 1;
      const jwe = await makeJwe(JSON.stringify({ value: 'cached' }));
      return fakeRes({ status: 200, body: jwe });
    };
    expect(await checkSecretPresence('CACHED_KEY')).toBe(true);
    expect(await checkSecretPresence('CACHED_KEY')).toBe(true);
    expect(callCount).toBe(1);
  });

  it('force:true bypasses cache — cron uses this', async () => {
    let callCount = 0;
    _fetchHandler = async () => {
      callCount += 1;
      const jwe = await makeJwe(JSON.stringify({ value: 'x' }));
      return fakeRes({ status: 200, body: jwe });
    };
    await checkSecretPresence('FORCE_KEY');
    await checkSecretPresence('FORCE_KEY', { force: true });
    expect(callCount).toBe(2);
  });

  it('invalidatePresence flushes the cache for one alias', async () => {
    let callCount = 0;
    _fetchHandler = async () => {
      callCount += 1;
      const jwe = await makeJwe(JSON.stringify({ value: 'x' }));
      return fakeRes({ status: 200, body: jwe });
    };
    await checkSecretPresence('FLUSH_KEY');
    invalidatePresence('FLUSH_KEY');
    await checkSecretPresence('FLUSH_KEY');
    expect(callCount).toBe(2);
  });

  it('never throws — malformed JWE (transport-encoding error) → present:false', async () => {
    _fetchHandler = async () => fakeRes({ status: 200, body: 'not-a-valid-jwe' });
    await expect(checkSecretPresence('MALFORMED_KEY')).resolves.toBe(false);
  });
});
