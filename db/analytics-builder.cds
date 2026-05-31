// db/analytics-builder.cds
// Analytics Builder Phase 1 entities (2026-05-31).
// Two entities sharing one shape via aspect. AnalyticsQueryHistory is auto-
// written on every runSelectQuery; AnalyticsSavedQuery is created via the
// "Save as…" admin action. Both are admin-only (gated by AnalyticsService).

namespace com.sap.developers.ims;

using { managed } from '@sap/cds/common';

aspect AnalyticsQueryShape {
  spec        : LargeString;             // JSON-stringified QuerySpec (v1 schema)
  sql         : LargeString;             // Rendered SQL at run time
  rowCount    : Integer;
  durationMs  : Integer;
  truncated   : Boolean default false;
  privacyMode : String(16);              // 'raw' | 'k-anon'
}

@PersonalData : { EntitySemantics: 'Other' }
entity AnalyticsQueryHistory : managed, AnalyticsQueryShape {
  key ID      : UUID;
  source      : String(16);              // 'builder' | 'editor' | 'joule' | 'replay'
}

@PersonalData    : { EntitySemantics: 'Other' }
@cds.changelog   : true
entity AnalyticsSavedQuery : managed, AnalyticsQueryShape {
  key ID      : UUID;
  name        : String(120) not null;
  description : String(500);
  visibility  : String(16) default 'private';   // 'private' | 'shared-admins'
  lastRunAt   : Timestamp;
}
