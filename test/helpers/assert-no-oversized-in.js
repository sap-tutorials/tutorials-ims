// Shared regression guard for the "Failed to set parameters, maximum packet
// size exceeded" HANA failure — see memory note cqn-where-in-hana-packet-cap.md
// and the prior fixes shipped in #1063 (kg-featured-topics), #1103 (build-
// concepts payload), and the "packet-size sweep" that centralized this helper.
//
// Usage:
//
//   import { instrumentInLimit } from '../../helpers/assert-no-oversized-in.js';
//
//   const guard = instrumentInLimit(tx, { limit: 500 });
//   try {
//     await codeUnderTest(tx, /* enough rows to overflow if regressed */);
//   } finally {
//     guard.restore();
//   }
//   expect(guard.oversized, `...`).toEqual([]);
//
// The instrumentation wraps `tx.run` and inspects every CQN it sees for a
// `where` clause containing a bound `in`-list ≥ `limit`. Each violation is
// captured with { col, listLen, from } for diagnostic clarity. Restoring is
// idempotent — safe to call multiple times.
//
// The 500-item ceiling is arbitrary but matches:
//   - the chunk size used by srv/jobs/cleanup.js deleteInChunks
//   - the smallest observed HANA failure point in production (5,946-item
//     `slug IN (…)` on /build/concepts in July 2026)
// Trip the guard at 500 rather than at the actual HANA ceiling so tests fail
// on regressions long before production would.

/**
 * Wrap `tx.run` so it records any CQN SELECT/DELETE/UPDATE whose WHERE clause
 * carries a bound `in`-list ≥ `limit`. Returns a guard object with:
 *   - `oversized` — array of {col, listLen, from} entries populated as the
 *     wrapped code runs
 *   - `restore()` — put the original `tx.run` back
 *
 * @param {object} tx        A CAP transaction (from `cds.tx(...)` or similar)
 * @param {object} [opts]
 * @param {number} [opts.limit=500]  IN-list size at which to record a violation
 * @returns {{oversized: Array<{col:string,listLen:number,from:string|undefined}>, restore: () => void}}
 */
export function instrumentInLimit(tx, opts = {}) {
  const limit = opts.limit ?? 500;
  const oversized = [];
  const origRun = tx.run.bind(tx);

  tx.run = async (q, ...rest) => {
    try {
      // CQN `where` is a token array like [{ref:['col']}, 'in', {list:[...]}].
      // Same shape appears on SELECT / DELETE / UPDATE. Peek at all three.
      const where =
        q?.SELECT?.where ??
        q?.DELETE?.where ??
        q?.UPDATE?.where;
      if (Array.isArray(where)) {
        for (let i = 0; i < where.length; i++) {
          if (where[i] === 'in' && where[i + 1]?.list) {
            const listLen = where[i + 1].list.length;
            if (listLen >= limit) {
              const col = where[i - 1]?.ref?.join('.') || '?';
              const from =
                q?.SELECT?.from?.ref?.[0] ??
                q?.DELETE?.from?.ref?.[0] ??
                q?.UPDATE?.entity?.ref?.[0];
              oversized.push({ col, listLen, from });
            }
          }
        }
      }
    } catch { /* diagnostic-only; never let instrumentation swallow errors */ }
    return origRun(q, ...rest);
  };

  return {
    oversized,
    restore() { tx.run = origRun; },
  };
}
