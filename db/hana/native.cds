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
  ADD_DAYS(date'2018-01-01', cast(floor(days_between(date'2018-01-01', joinedDate) / 7) * 7 as Integer)) as weekMonday : Date
}
