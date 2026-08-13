'use strict';

// Enrichment for AdminService.DevtoberfestSignupAnalytics (spec 2026-08-13).
//
// The underlying view exposes a portable integer `weekIndex` (Mon–Sun bucket
// counted from the 2018-01-01 Monday anchor) because no CAP-portable ISO-week
// function exists (only days_between / year / month / day translate to both
// HANA and SQLite). This module derives the human-readable calendar Monday and
// ISO 'YYYY-Www' label from weekIndex, and computes a running cumulative total
// — the two things OData $apply cannot produce natively (aggregation gives
// per-group counts, never a window/running sum).
//
// Cumulative is populated ONLY when the read is the pure by-week series (one row
// per week). When the result is sliced by another dimension (region/role/edition)
// weeks repeat and a running total is meaningless, so it is left null.

const WEEK_ANCHOR_UTC = Date.UTC(2018, 0, 1); // 2018-01-01 is a Monday
const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

/** weekIndex (int) -> Date at UTC midnight of that week's Monday. */
export function weekIndexToMonday(weekIndex) {
  return new Date(WEEK_ANCHOR_UTC + weekIndex * WEEK_MS);
}

/** 'YYYY-MM-DD' of the week's Monday. */
export function weekIndexToMondayISO(weekIndex) {
  return weekIndexToMonday(weekIndex).toISOString().slice(0, 10);
}

/**
 * ISO-8601 week-numbering label 'YYYY-Www' for a week's Monday Date.
 * The ISO year is the year of that week's Thursday.
 */
export function isoWeekLabel(monday) {
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const isoYear = thursday.getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / WEEK_MS) + 1;
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * Enrich signup analytics rows in place.
 *  - weekMonday / weekLabel: set on every row carrying a numeric weekIndex.
 *  - cumulativeSignups: running total of `newSignups` over ascending week order,
 *    populated only when the result is one row per week (see module doc).
 * Returns the same array reference (CAP after-READ convention).
 */
export function enrichSignupRows(rows) {
  if (!Array.isArray(rows)) return rows;

  const weekRows = rows.filter((r) => r && typeof r.weekIndex === 'number');
  for (const row of weekRows) {
    row.weekMonday = weekIndexToMondayISO(row.weekIndex);
    row.weekLabel = isoWeekLabel(weekIndexToMonday(row.weekIndex));
  }

  // Pure by-week series ⇔ each week appears exactly once and a measure is present.
  const distinctWeeks = new Set(weekRows.map((r) => r.weekIndex));
  const hasMeasure = weekRows.length > 0 && weekRows.every((r) => typeof r.newSignups === 'number');
  const isByWeekSeries = hasMeasure && distinctWeeks.size === weekRows.length;

  if (isByWeekSeries) {
    const ordered = [...weekRows].sort((a, b) => a.weekIndex - b.weekIndex);
    let running = 0;
    for (const row of ordered) {
      running += row.newSignups;
      row.cumulativeSignups = running;
    }
  }
  return rows;
}
