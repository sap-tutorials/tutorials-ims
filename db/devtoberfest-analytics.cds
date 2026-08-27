namespace com.sap.developers.ims;

using { com.sap.developers.ims as ims } from './schema';

// --- Devtoberfest signups analytics -------------------------------------
//
// Two-layer view feeding the admin "Devtoberfest Signups" Analytical List Page
// (spec 2026-08-13; readable-week axis added for issue #2047).
//
//  1. DevtoberfestSignupFacts — the per-signup fact view (one row per
//     EventRegistrations row) with the association joins, flattened into
//     groupable scalar dimensions so Fiori Elements can drive native OData V4
//     $apply aggregation (group by week / edition / region / role, aggregate
//     $count) without any association navigation. Scope: eventType =
//     'DEVTOBERFEST' only — signups across ALL Devtoberfest editions.
//
//  2. DevtoberfestSignupAnalytics — the public analytical view the service
//     projects on. It is a plain, JOIN-free projection of the facts so the
//     per-dialect models (db/sqlite/native.cds, db/hana/native.cds) can
//     `extend projection` it with a real, GROUPABLE `weekMonday : Date` — the
//     CDS compiler refuses to extend a view that contains a JOIN, hence the
//     split. A real weekMonday is needed because the analytical chart's X-axis
//     must group on a real column; a read-time virtual cannot sit on a $apply
//     axis, which is why the raw integer weekIndex used to leak through (#2047).
//
// weekIndex: portable ISO-aligned week bucket. 2018-01-01 is a Monday, so
//   floor(days_between(anchorMonday, joinedDate) / 7)
// numbers each Mon–Sun week from that anchor. Uses only the portable
// days_between / floor functions (CAP "Standard Functions" — translate to both
// HANA and SQLite), so it groups identically in prod (HANA) and unit tests
// (in-memory SQLite). weekMonday (the calendar Monday date) is derived per
// dialect from weekIndex's inputs; the 'YYYY-Www' weekLabel is derived in the
// read handler (srv/lib/devtoberfest-signup-enrich.js) because no portable
// ISO-week function exists. region/role come from the optional
// UserLearningPreferences (left join): null for most users, surfaced as a
// "Not set" bucket in the UI, by design.
view DevtoberfestSignupFacts as
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

// JOIN-free public projection (see header) — extended per dialect with weekMonday.
view DevtoberfestSignupAnalytics as select from DevtoberfestSignupFacts { * };
