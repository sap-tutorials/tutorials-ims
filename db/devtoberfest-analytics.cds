namespace com.sap.developers.ims;

using { com.sap.developers.ims as ims } from './schema';

// --- Devtoberfest signups analytics -------------------------------------
//
// Per-signup fact view feeding the admin "Devtoberfest Signups" Analytical
// List Page (spec 2026-08-13). One row per EventRegistrations row (i.e. one
// row per (user, event) signup), flattened into groupable scalar dimensions
// so Fiori Elements can drive native OData V4 $apply aggregation over it
// (group by week / edition / region / role, aggregate $count) without any
// association navigation.
//
// Scope: eventType = 'DEVTOBERFEST' only — captures signups across ALL
// Devtoberfest editions. The ALP filter bar defaults the edition to the
// active event (resolved server-side in the read handler).
//
// weekIndex: portable ISO-aligned week bucket. 2018-01-01 is a Monday, so
//   floor(days_between(anchorMonday, joinedDate) / 7)
// numbers each Mon–Sun week from that anchor. Uses only the portable
// days_between / floor functions (CAP "Standard Functions" — translate to
// both HANA and SQLite), so it groups identically in prod (HANA) and unit
// tests (in-memory SQLite). The Monday date + 'YYYY-Www' label for each
// bucket is derived from weekIndex in the read handler (srv/admin-service.js)
// — see weekIndexToMonday(). region/role come from the optional
// UserLearningPreferences (left join): null for most users, surfaced as a
// "Not set" bucket in the UI, by design.
view DevtoberfestSignupAnalytics as
  select from ims.EventRegistrations as reg
    inner join ims.Events                   as evt  on evt.ID  = reg.event.ID
    left  join ims.UserLearningPreferences  as pref on pref.user.ID = reg.user.ID
  {
    key reg.ID                                            as ID,
        reg.joinedAt                                      as joinedAt,
        cast(reg.joinedAt as Date)                        as joinedDate      : Date,
        floor(days_between(date'2018-01-01', cast(reg.joinedAt as Date)) / 7) as weekIndex : Integer,
        evt.ID                                            as event_ID,
        evt.name                                          as eventName       : String(255),
        evt.eventType                                     as eventType       : String(20),
        cast(evt.startDate as Date)                       as eventStartDate  : Date,
        coalesce(pref.preferredEventRegion, 'Not set')    as region          : String(16),
        coalesce(pref.role, 'Not set')                    as role            : String(20),
        1                                                 as signups         : Integer
  }
  where evt.eventType = 'DEVTOBERFEST';
