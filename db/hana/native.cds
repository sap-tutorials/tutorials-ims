// HANA-specific extension for DevtoberfestSignupAnalytics (issue #2209).
//
// HANA twin of db/sqlite/native.cds — supplies the real, GROUPABLE STRING
// `weekStartText` the analytical chart/table group + sort on. See that file's
// header for why the week axis is a string ISO date (one discrete bar per week,
// no interpolated empty-day ticks) and why it recomputes the Mon-anchored week
// start from `joinedDate`.
//
// HANA has the native ADD_DAYS(date, n) function; floor(days_between(anchor,d)/7)*7
// is the whole-week day offset from the 2018-01-01 Monday anchor. TO_VARCHAR with
// 'YYYY-MM-DD' yields the same ISO Monday date the SQLite twin produces, so the
// axis reads and SORTS identically in prod (HANA) and unit tests (SQLite) — plain
// lexical order is chronological. Wired per profile via
// cds.requires.db.[hybrid|production].model. Extends the JOIN-free projection (the
// compiler refuses to `extend` a view containing a JOIN).
using { com.sap.developers.ims.DevtoberfestSignupAnalytics } from '../devtoberfest-analytics';

extend projection DevtoberfestSignupAnalytics with {
  TO_VARCHAR(ADD_DAYS(date'2018-01-01', cast(floor(days_between(date'2018-01-01', joinedDate) / 7) * 7 as Integer)), 'YYYY-MM-DD') as weekStartText : String(24)
}
