'use strict';

// Enrichment for AdminService.DevtoberfestSignupAnalytics (spec 2026-08-13;
// readable-week axis reworked for issue #2047).
//
// The view now exposes a REAL, groupable `weekMonday : Date` (the calendar Monday
// of each Mon–Sun bucket), supplied per dialect (db/sqlite/native.cds via
// strftime, db/hana/native.cds via ADD_DAYS) so the analytical chart can group on
// a human-readable time axis instead of the raw integer `weekIndex`. This module
// derives the two things OData $apply still cannot produce natively:
//   - weekLabel: the ISO 'YYYY-Www' string (no portable ISO-week SQL function), and
//   - cumulativeSignups: a running total (a window/running sum, not a per-group
//     aggregate).
//
// It keys off `weekMonday` when the row carries it (the chart / by-week table),
// and falls back to deriving the Monday from the portable integer `weekIndex`
// when a read groups by weekIndex alone — stamping `weekMonday` onto the row so
// both grouping shapes yield the same enriched fields.
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
 * Resolve a row's week Monday as a UTC-midnight Date, from `weekMonday` (real
 * DB column — string 'YYYY-MM-DD' or Date) or, failing that, the portable
 * integer `weekIndex`. Returns null when neither is present (e.g. grand-total
 * or a slice grouped by region only). Pure.
 */
function rowMonday(row) {
  const wm = row.weekMonday;
  if (wm != null) {
    if (wm instanceof Date) return new Date(Date.UTC(wm.getUTCFullYear(), wm.getUTCMonth(), wm.getUTCDate()));
    const iso = String(wm).slice(0, 10); // 'YYYY-MM-DD'
    const t = Date.parse(`${iso}T00:00:00Z`);
    if (!Number.isNaN(t)) return new Date(t);
  }
  if (typeof row.weekIndex === 'number') return weekIndexToMonday(row.weekIndex);
  return null;
}

/**
 * Enrich signup analytics rows in place.
 *  - weekMonday / weekLabel: set on every row that resolves to a week Monday
 *    (weekMonday is stamped from weekIndex when a read grouped by weekIndex alone).
 *  - cumulativeSignups: running total of `newSignups` over ascending week order,
 *    populated only when the result is one row per week (see module doc).
 * Returns the same array reference (CAP after-READ convention).
 */
export function enrichSignupRows(rows) {
  if (!Array.isArray(rows)) return rows;

  const weekRows = [];
  for (const row of rows) {
    if (!row) continue;
    const monday = rowMonday(row);
    if (!monday) continue;
    row.weekMonday = monday.toISOString().slice(0, 10);
    row.weekLabel = isoWeekLabel(monday);
    weekRows.push({ row, ms: monday.getTime() });
  }

  // Pure by-week series ⇔ each week appears exactly once and a measure is present.
  const distinctWeeks = new Set(weekRows.map((w) => w.ms));
  const hasMeasure = weekRows.length > 0 && weekRows.every((w) => typeof w.row.newSignups === 'number');
  const isByWeekSeries = hasMeasure && distinctWeeks.size === weekRows.length;

  if (isByWeekSeries) {
    const ordered = [...weekRows].sort((a, b) => a.ms - b.ms);
    let running = 0;
    for (const { row } of ordered) {
      running += row.newSignups;
      row.cumulativeSignups = running;
    }
  }
  return rows;
}
