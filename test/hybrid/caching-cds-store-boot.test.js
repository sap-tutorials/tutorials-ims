/**
 * #1182 — hybrid boot smoke test for the cds-caching CDS-DB store.
 *
 * Boots the full srv under the [hybrid] profile (store:'cds') against a real
 * HANA container via `cds bind`, then exercises a set/get/delete round-trip
 * through the caching service. Proves:
 *   1. srv boots with store:'cds' (the resolve-guard fix keeps CF boot clean;
 *      here it's a no-op since hybrid compiles from source, but the same config
 *      that crash-looped on CF now boots).
 *   2. KeyvCDS resolves plugin.cds_caching.CacheStore from the served model and
 *      the CDS-backed store actually persists to HANA.
 *
 * #1222 — metrics.enabled is RE-ENABLED in [hybrid]/[production] on
 * cds-caching 2.0.2. The #1215 disable worked around the HANA INT-bind error:
 * the stats-accumulation path read back the hourly row via a flattened
 * table-name SELECT, returning UPPERCASE column keys (`HITS` not `hits`), so
 * `existingHourly.hits + stats.hits` was `undefined + n = NaN` → hdb threw
 * "Wrong input for INT type" on every flush and counters stuck at 0. 2.0.2
 * fixes it (mikezaschka/cds-caching#27): readback via the resolved CSN entity +
 * `Number(existingHourly.<col>) || 0` coercion. The store stays 'cds' for
 * multi-instance cache coherence.
 *
 * Run with: cf login + cds bind --exec -- npx vitest run --project hybrid \
 *   test/hybrid/caching-cds-store-boot.test.js
 */
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('#1182 — cds-caching CDS-DB store hybrid boot', () => {
  it('caching service is configured with store:cds under hybrid', () => {
    const cfg = cds.env.requires.caching;
    expect(cfg).toBeTruthy();
    expect(cfg.store).toBe('cds');
  });

  it('#1222 — metrics persistence is enabled (fixed upstream in cds-caching 2.0.2)', () => {
    const cfg = cds.env.requires.caching;
    // metrics.enabled is re-enabled under hybrid/production now that the
    // UPPERCASE-column accumulation bug is fixed in cds-caching 2.0.2.
    expect(cfg.metrics?.enabled).toBe(true);
  });

  it('CacheStore entity is present in the served model', () => {
    const def = cds.model?.definitions?.['plugin.cds_caching.CacheStore'];
    expect(def).toBeTruthy();
    expect(def.kind).toBe('entity');
  });

  it('set/get/delete round-trips through the CDS-backed store', async () => {
    const cache = await cds.connect.to('caching');
    const key = `_1182_boot_probe_${process.pid}`;
    await cache.set(key, { ok: true, n: 42 }, { ttl: 10_000 });
    const v = await cache.get(key);
    expect(v).toEqual({ ok: true, n: 42 });
    await cache.delete(key);
    const gone = await cache.get(key);
    expect(gone).toBeUndefined();
  });
});
