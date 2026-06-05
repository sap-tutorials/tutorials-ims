/**
 * Pure helpers for check-hana-rowcounts.cjs — extracted for unit-testing.
 * No HANA / CF / fs side-effects here.
 */
'use strict';

/**
 * Format one diff row. Returns null when nothing changed (so callers can filter).
 */
function fmtRow(name, prev, now) {
  const padName = name.replace(/^COM_SAP_DEVELOPERS_IMS_/, '').padEnd(40);
  if (prev === undefined) return `  + ${padName} ${String(now).padStart(8)} (new)`;
  if (now === undefined)  return `  - ${padName} ${String(prev).padStart(8)} (gone)`;
  const diff = now - prev;
  if (diff === 0) return null;
  const arrow = diff > 0 ? '↑' : '↓';
  const pct = prev === 0 ? '' : ` (${(diff / prev * 100).toFixed(1)}%)`;
  return `  ${arrow} ${padName} ${String(prev).padStart(8)} → ${String(now).padStart(8)} (${diff > 0 ? '+' : ''}${diff})${pct}`;
}

/**
 * Compute tripwire failures: tables that lost rows beyond the threshold.
 * @param {Record<string, number>} prev — snapshot row counts
 * @param {Record<string, number>} now — current row counts
 * @param {number} thresholdPct — allow this much percentage loss before failing (5 = 5%)
 * @param {number} minRowThreshold — ignore tables with fewer than this many rows in snapshot
 * @returns {Array<{name, prev, now, reason}>} list of failing tables (empty = OK)
 */
function tripwireFailures(prev, now, thresholdPct, minRowThreshold) {
  const failures = [];
  for (const [name, prevCount] of Object.entries(prev)) {
    if (prevCount < minRowThreshold) continue;
    const nowCount = now[name];
    if (nowCount === undefined) {
      failures.push({ name, prev: prevCount, now: 0, reason: 'TABLE GONE' });
      continue;
    }
    const allowedFloor = Math.floor(prevCount * (1 - thresholdPct / 100));
    if (nowCount < allowedFloor) {
      failures.push({
        name, prev: prevCount, now: nowCount,
        reason: `dropped ${prevCount - nowCount} rows (>${thresholdPct}% threshold)`,
      });
    }
  }
  return failures;
}

module.exports = { fmtRow, tripwireFailures };
