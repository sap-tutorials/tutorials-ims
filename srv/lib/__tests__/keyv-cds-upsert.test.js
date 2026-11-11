// srv/lib/__tests__/keyv-cds-upsert.test.js
//
// Regression guard for issue #3102: cds-caching's KeyvCDS.set() did a
// read-then-create/update (TOCTOU). Under multi-instance CF two instances
// both read "no row", both INSERT the same CacheStore key, and the second
// INSERT violates the PK unique index — which the adapter logs at ERROR
// level (the PROD noise) and the losing write is dropped. The committed
// patches/cds-caching+2.1.0.patch replaces that branch with an atomic
// single-key UPSERT (last-write-wins): no collision, no error log, no lost
// write.
//
// A single in-process SQLite test can't naturally race two HANA instances,
// so we model the TOCTOU window deterministically: stub the adapter's
// db.read to return undefined for the key (the window where a peer's INSERT
// is not yet visible to this reader) while the row already physically
// exists. Old code then takes the INSERT branch and collides; new code
// UPSERTs cleanly.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import cds from '@sap/cds';

const require = createRequire(import.meta.url);
const KeyvCDS = require('cds-caching/lib/support/KeyvCDS.js');

cds.test(import.meta.dirname + '/__fixtures__/keyv-cds-app');

describe('KeyvCDS.set is collision-safe (issue #3102)', () => {
  let entity;
  beforeAll(() => {
    entity = cds.entities('plugin.cds_caching').CacheStore;
  });

  it('serial re-set of the same key overwrites (last-write-wins)', async () => {
    const store = new KeyvCDS({});
    await store.set('dup', 'first', 10_000);
    await store.set('dup', 'second', 10_000);
    expect(await store.get('dup')).toBe('second');
  });

  it('re-set with no TTL overwrites cleanly (expiresAt null)', async () => {
    const store = new KeyvCDS({});
    await store.set('nt', 'a', 10_000);
    await store.set('nt', 'b'); // no ttl
    expect(await store.get('nt')).toBe('b');
    const row = await cds.db.run(SELECT.one.from(entity).where({ ID: 'nt' }));
    expect(row.expiresAt).toBeNull();
  });

  // The decisive test. Reproduces the multi-instance TOCTOU on one process:
  // the row already exists in the DB, but this adapter's read is forced to
  // miss it (the race window). Pre-patch INSERT-branch collides on the PK and
  // logs 'KeyvCDS set error'; post-patch UPSERT persists the value with no
  // error log.
  it('a write into an already-occupied key (race window) does not collide and persists', async () => {
    const key = 'kg:rl:race:win';
    // Peer instance already INSERTed the row.
    await cds.db.run(
      INSERT.into(entity).entries({ ID: key, value: 'peer', expiresAt: Date.now() + 10_000 }),
    );

    const store = new KeyvCDS({});
    const logSpy = vi.spyOn(store.log, 'error').mockImplementation(() => {});
    // Force the read inside set() to miss (TOCTOU window).
    const realRead = cds.db.read.bind(cds.db);
    const readSpy = vi.spyOn(cds.db, 'read').mockImplementation(async (ent, k) => {
      if (k === key) return undefined;
      return realRead(ent, k);
    });

    try {
      await store.set(key, 'mine', 10_000);
    } finally {
      readSpy.mockRestore();
    }

    // Patched (UPSERT): no error logged, value overwritten to 'mine'.
    const setErrors = logSpy.mock.calls.filter((c) => String(c[0]).includes('set error'));
    expect(setErrors).toHaveLength(0);
    const row = await cds.db.run(SELECT.one.from(entity).where({ ID: key }));
    expect(row.value).toBe('mine');
    logSpy.mockRestore();
  });
});
