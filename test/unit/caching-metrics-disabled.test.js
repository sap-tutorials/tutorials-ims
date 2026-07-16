/**
 * #1215 — config-drift guard: cds-caching metrics persistence must stay OFF
 * in the [hybrid] and [production] profiles, while store stays 'cds'.
 *
 * Why: on HANA, cds-caching's hourly-stats accumulation reads back the existing
 * row via a flattened table-name SELECT (`SELECT.one.from("plugin_cds_caching_Metrics")`),
 * which yields UPPERCASE column keys (`HITS`, not `hits`). The plugin then does
 * `existingHourly.hits + stats.hits` → `undefined + n = NaN`, and hdb's INT
 * writer throws "Wrong input for INT type" on every flush interval (Writer.js
 * throws only on isNaN). Result: 22 hourly rows persisted with every counter
 * stuck at 0 (CREATE path succeeds, UPDATE path always throws) plus an
 * error-level log line per interval polluting `cf logs tutorials-srv`.
 *
 * This is invisible to unit/hybrid tests that use store:'memory' (which never
 * hits the SELECT-then-accumulate path), so it only surfaced on real HANA
 * post-#1182. Disabling metrics loses nothing — the counters were already
 * non-functional — and keeps store:'cds' for multi-instance cache coherence.
 *
 * Re-enable metrics only after the upstream casing bug is fixed AND this guard
 * is updated in the same change. Reads package.json directly so it runs in CI
 * without a HANA binding.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
);
const caching = pkg.cds.requires.caching;

describe('#1215 — cds-caching metrics persistence stays disabled', () => {
  it('base profile keeps store:memory (local dev + unit tests)', () => {
    expect(caching.store).toBe('memory');
  });

  for (const profile of ['[hybrid]', '[production]']) {
    describe(`${profile} profile`, () => {
      it('retains store:cds for multi-instance coherence', () => {
        expect(caching[profile]?.store).toBe('cds');
      });

      it('does NOT enable metrics (avoids the HANA INT-bind error)', () => {
        // metrics.enabled must be absent or falsy until the upstream
        // cds-caching UPPERCASE-column accumulation bug is fixed.
        expect(caching[profile]?.metrics?.enabled).toBeFalsy();
      });
    });
  }
});
