// HANA-specific extension for DevtoberfestSignupAnalytics (issue #2047).
//
// HANA twin of db/sqlite/native.cds — supplies the real, GROUPABLE
// `weekMonday : Date` the analytical chart uses as its readable time axis. See
// that file's header for why weekMonday is dialect-specific and why it recomputes
// the Mon-anchored week start from `joinedDate`.
//
// HANA has the native ADD_DAYS(date, n) function; floor(days_between(anchor,d)/7)*7
// is the whole-week day offset from the 2018-01-01 Monday anchor. Wired per profile
// via cds.requires.db.[hybrid|production].model. Extends the JOIN-free projection
// (the compiler refuses to `extend` a view containing a JOIN).
using { com.sap.developers.ims.DevtoberfestSignupAnalytics } from '../devtoberfest-analytics';

extend projection DevtoberfestSignupAnalytics with {
  ADD_DAYS(date'2018-01-01', cast(floor(days_between(date'2018-01-01', joinedDate) / 7) * 7 as Integer)) as weekMonday : Date,
  // Readable week-axis label (issue #2047, "readable week" rework). HANA can format
  // month/weekday names, so this renders e.g. "Mon 07 Sep 2026". It is text-arranged
  // onto weekMonday (@UI.TextArrangement: #TextOnly) so the chart/table show this
  // string while grouping+sorting on the real Date. The SQLite twin falls back to the
  // ISO Monday date (no name formatter). See app/admin-annotations.cds.
  TO_VARCHAR(ADD_DAYS(date'2018-01-01', cast(floor(days_between(date'2018-01-01', joinedDate) / 7) * 7 as Integer)), 'DY DD MON YYYY') as weekStartText : String(24)
}
