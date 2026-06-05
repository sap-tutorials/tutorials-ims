// db/schema-ext.cds
using { com.sap.developers.ims as ims } from './schema';
using from './views';

// Order of missions within their parent group
extend ims.Missions with {
  groupOrder : Integer default 0;
}

// Association-based tag reference for value help support
extend ims.TaskBase with {
  primaryTagRef : Association to ims.Tags;
}

// Analytics Explorer — exposed view/entity allowlist.
// Two-place change to add a new exposed entity: this annotation +
// a corresponding @readonly projection in srv/analytics-service.cds.

annotate ims.Tasks                  with @analytics : { exposed: true, label: 'Tasks (denormalized)' };
annotate ims.NavigatorCatalog       with @analytics : { exposed: true, label: 'Navigator catalog' };
annotate ims.SearchableItems        with @analytics : { exposed: true, label: 'Searchable items' };
annotate ims.CompletionAnalytics    with @analytics : { exposed: true, label: 'Completion analytics' };
annotate ims.ActiveLearnersDaily    with @analytics : { exposed: true, label: 'Active learners (daily)' };
annotate ims.TaskRecords            with @analytics : { exposed: true, label: 'Task records' };
annotate ims.Users                  with @analytics : { exposed: true, label: 'Users' };
annotate ims.Missions               with @analytics : { exposed: true, label: 'Missions' };
annotate ims.Groups                 with @analytics : { exposed: true, label: 'Groups' };
annotate ims.Tutorials              with @analytics : { exposed: true, label: 'Tutorials' };
annotate ims.Events                 with @analytics : { exposed: true, label: 'Events' };
annotate ims.PrizeRecords           with @analytics : { exposed: true, label: 'Prize records' };
annotate ims.AccomplishmentRecords  with @analytics : { exposed: true, label: 'Accomplishment records' };
annotate ims.CodeCheckSubmissions   with @analytics : { exposed: true, label: 'Code check submissions' };
annotate ims.UIEvent                with @analytics : { exposed: true, label: 'UI events (A/B telemetry)' };

// Declare $apply capability for the analytics-exposed surface so the OData
// protocol layer accepts groupby+aggregate from the Analytics Explorer SPA.
// 'topcount' and 'concat' are intentionally omitted: HANA has no TOPCOUNT
// SQL function, and CAP's OData→HANA translator emits literal topcount(...)
// which fails with [SqlError: invalid name of function or procedure: TOPCOUNT].
// Use orderby(measure desc)/top(N) instead for the same effect.
annotate ims.Tasks                  with @Aggregation.ApplySupported : { Transformations : ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'] };
annotate ims.NavigatorCatalog       with @Aggregation.ApplySupported : { Transformations : ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'] };
annotate ims.SearchableItems        with @Aggregation.ApplySupported : { Transformations : ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'] };
annotate ims.CompletionAnalytics    with @Aggregation.ApplySupported : { Transformations : ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'] };
annotate ims.ActiveLearnersDaily    with @Aggregation.ApplySupported : { Transformations : ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'] };
annotate ims.TaskRecords            with @Aggregation.ApplySupported : { Transformations : ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'] };
annotate ims.Users                  with @Aggregation.ApplySupported : { Transformations : ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'] };
annotate ims.Missions               with @Aggregation.ApplySupported : { Transformations : ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'] };
annotate ims.Groups                 with @Aggregation.ApplySupported : { Transformations : ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'] };
annotate ims.Tutorials              with @Aggregation.ApplySupported : { Transformations : ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'] };
annotate ims.Events                 with @Aggregation.ApplySupported : { Transformations : ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'] };
annotate ims.PrizeRecords           with @Aggregation.ApplySupported : { Transformations : ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'] };
annotate ims.AccomplishmentRecords  with @Aggregation.ApplySupported : { Transformations : ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'] };
annotate ims.CodeCheckSubmissions   with @Aggregation.ApplySupported : { Transformations : ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'] };
annotate ims.UIEvent                with @Aggregation.ApplySupported : { Transformations : ['aggregate', 'groupby', 'filter', 'top', 'skip', 'orderby'] };

// Analytics Builder Phase 1 entities (AnalyticsQueryHistory, AnalyticsSavedQuery)
// live in db/analytics-builder.cds — kept separate so this annotation file
// stays focused on extending existing entities.

// ─── Analytics filter modes (Phase 1, 2026-05-31) ────────────────────────
// Schema-driven UI hints for the analytics builder filter chip popover.
// Default for unannotated columns: 'free' (text input, no DB sampling).
// Column names verified against db/schema.cds + db/views.cds at write time.

annotate ims.Tasks with {
  status     @analytics.filter: { mode: 'enum', sample: true };
  taskType   @analytics.filter: { mode: 'enum', sample: true };
  createdAt  @analytics.filter: { mode: 'date' };
  modifiedAt @analytics.filter: { mode: 'date' };
};

annotate ims.TaskRecords with {
  status         @analytics.filter: { mode: 'enum', sample: true };
  taskType       @analytics.filter: { mode: 'enum', sample: true };
  completionDate @analytics.filter: { mode: 'date' };
};

annotate ims.Missions with {
  slug @analytics.filter: { mode: 'enum', sample: true };
};

annotate ims.Events with {
  name      @analytics.filter: { mode: 'enum', sample: true };
  startDate @analytics.filter: { mode: 'date' };
  endDate   @analytics.filter: { mode: 'date' };
};

// PII flags: client-side redaction in Joule sampleRows before send to LLM.
annotate ims.Users with {
  email       @analytics.pii: true;
  firstName   @analytics.pii: true;
  lastName    @analytics.pii: true;
  displayName @analytics.pii: true;
};

annotate ims.CodeCheckSubmissions with {
  verdict      @analytics.filter: { mode: 'enum', sample: true };
  language     @analytics.filter: { mode: 'enum', sample: true };
  tutorialSlug @analytics.filter: { mode: 'free' };
  createdAt    @analytics.filter: { mode: 'date' };
};

// UIEvent indexes (#204): three secondary indexes on the UIEvent telemetry
// table to keep the A/B-test queries cheap as event volume grows. Original
// .hdbindex attempt closed-#227 was reverted in PR #249 because it used
// invalid HDI design-time syntax. This rework uses @sql.append, which CAP
// injects verbatim into the generated DDL after the table CREATE — the
// CAP-native path for native database clauses (see CAP March 2022 release
// notes on @sql.append).
//
// Validation: cds build --production emits the appended SQL into the
// .hdbmigrationtable file as separate CREATE INDEX statements (verified
// against gen/db/src/...UIEvent.hdbmigrationtable on this branch).
annotate ims.UIEvent with @sql.append: ```sql
  ;
  CREATE INDEX "IDX_UIEVENT_SESSION" ON "com_sap_developers_ims_UIEvent" ("sessionId");
  CREATE INDEX "IDX_UIEVENT_SURFACE_TS" ON "com_sap_developers_ims_UIEvent" ("surface", "TIMESTAMP");
  CREATE INDEX "IDX_UIEVENT_TYPE_TS" ON "com_sap_developers_ims_UIEvent" ("eventType", "TIMESTAMP")
```;
