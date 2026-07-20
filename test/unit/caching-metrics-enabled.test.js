/**
 * #1222 — config guard: cds-caching metrics persistence is RE-ENABLED in the
 * [hybrid] and [production] profiles, while store stays 'cds'.
 *
 * History: #1215 disabled `metrics.enabled` because on HANA cds-caching's
 * hourly-stats accumulation read back the existing row via a flattened
 * table-name SELECT (`SELECT.one.from("plugin_cds_caching_Metrics")`), which
 * yields UPPERCASE column keys (`HITS`, not `hits`). `existingHourly.hits +
 * stats.hits` was then `undefined + n = NaN`, and hdb's INT writer threw
 * "Wrong input for INT type" on every flush — counters stuck at 0.
 *
 * cds-caching 2.0.2 fixes it (issue mikezaschka/cds-caching#27): the readback
 * now uses the resolved CSN entity (`SELECT.one.from(Metrics)`) so CAP
 * normalizes column keys across databases, AND `_calculateUpdatedStats`
 * coerces every counter with `Number(existingHourly.<col>) || 0`. Either half
 * alone stops the NaN → INT-bind throw. See
 * StatisticsPersistenceManager.js:41 and :174-186 in cds-caching@2.0.2.
 *
 * This guard now asserts metrics stays ON (drift catch: don't silently revert
 * to the #1215 disable). Reads package.json directly so it runs in CI without a
 * HANA binding. If a regression forces metrics back off, flip these expectations
 * and reference the new issue.
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

describe('#1222 — cds-caching metrics persistence re-enabled on 2.0.2', () => {
  it('depends on cds-caching >= 2.0.2 (the metrics INT-bind fix)', () => {
    const spec = pkg.dependencies['cds-caching'];
    expect(spec).toBeTruthy();
    // Pinned/ranged spec must resolve to at least 2.0.2.
    const min = spec.replace(/^[^\d]*/, '');
    const [maj, minr, pat] = min.split('.').map((n) => parseInt(n, 10));
    const atLeast202 =
      maj > 2 || (maj === 2 && (minr > 0 || (minr === 0 && pat >= 2)));
    expect(atLeast202).toBe(true);
  });

  it('base profile keeps store:memory (local dev + unit tests)', () => {
    expect(caching.store).toBe('memory');
  });

  for (const profile of ['[hybrid]', '[production]']) {
    describe(`${profile} profile`, () => {
      it('retains store:cds for multi-instance coherence', () => {
        expect(caching[profile]?.store).toBe('cds');
      });

      it('enables metrics persistence (fixed upstream in 2.0.2)', () => {
        expect(caching[profile]?.metrics?.enabled).toBe(true);
      });
    });
  }
});
