// SQLite-specific extension for DevtoberfestSignupAnalytics (issue #2209).
//
// The base view (db/devtoberfest-analytics.cds) exposes only the portable
// integer `weekIndex` because no single date-arithmetic expression is portable
// across SQLite and HANA (only days_between / floor / year / month / day map to
// both). The analytical chart/table group + sort on a real, GROUPABLE STRING
// column `weekStartText` (the week's Monday as an ISO 'YYYY-MM-DD' date) so the
// chart renders one discrete category per week — never a continuous Date axis
// that interpolates an empty tick for every calendar day (the regression a
// Date-typed `weekMonday` dimension caused, #2209). A string ISO date sorts
// chronologically by plain lexical order, so it needs no separate sort key. Each
// dialect supplies it with its own native date expression (see db/hana/native.cds
// for the HANA twin), wired per profile via cds.requires.db.[development].model.
//
// weekStartText recomputes the Mon-anchored week start from `joinedDate`.
// 2018-01-01 is a Monday; floor(days_between(anchor,d)/7)*7 is the whole-week day
// offset, and strftime adds it as days. `strftime` (not `date`) is the outer
// function because CAP treats lowercase date(x,…) as the 1-arg agnostic function
// and silently drops the modifier — strftime is passed through verbatim,
// preserving the '+N days' modifier. Extends the JOIN-free projection (the
// compiler refuses to `extend` a view containing a JOIN).
using { com.sap.developers.ims.DevtoberfestSignupAnalytics } from '../devtoberfest-analytics';

extend projection DevtoberfestSignupAnalytics with {
  strftime('%Y-%m-%d', '2018-01-01', cast(floor(days_between(date'2018-01-01', joinedDate) / 7) * 7 as Integer) || ' days') as weekStartText : String(24)
}
