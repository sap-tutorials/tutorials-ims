using { com.sap.developers.ims as ims } from '../db/schema';
using from '../db/views';
using from '../db/analytics-builder';

@requires : 'Admin'
service AnalyticsService @(path : '/admin/analytics') {

  @readonly entity Tasks                  as projection on ims.Tasks;
  @readonly entity NavigatorCatalog       as projection on ims.NavigatorCatalog;
  @readonly entity SearchableItems        as projection on ims.SearchableItems;
  @readonly entity CompletionAnalytics    as projection on ims.CompletionAnalytics;
  @readonly entity ActiveLearnersDaily    as projection on ims.ActiveLearnersDaily;

  @readonly @cds.redirection.target entity TaskRecords as projection on ims.TaskRecords;
  @readonly entity Users                  as projection on ims.Users;
  @readonly entity Missions               as projection on ims.Missions;
  @readonly entity Groups                 as projection on ims.Groups;
  @readonly entity Tutorials              as projection on ims.Tutorials;
  @readonly entity Events                 as projection on ims.Events;
  @readonly entity PrizeRecords           as projection on ims.PrizeRecords;
  @readonly entity AccomplishmentRecords  as projection on ims.AccomplishmentRecords;
  // #805 — Observability
  @readonly entity MetricSnapshots        as projection on ims.MetricSnapshots;
  @readonly entity PublishTimings         as projection on ims.PublishTimings;
  @readonly entity CodeCheckSubmissions   as projection on ims.CodeCheckSubmissions {
    ID,
    tutorialSlug,
    stepNumber,
    language,
    verdict,
    modelName,
    promptTokens,
    completionTokens,
    latencyMs,
    errorReason,
    createdAt,
    modifiedAt,
    user
  };

  // [#240] Mirror of CodeCheckSubmissions for AI free-text grading (#209).
  // Excludes question/answer text (PII risk; CodeCheckSubmissions does the same).
  @readonly entity ValidateAnswerSubmissions as projection on ims.ValidateAnswerSubmissions {
    ID,
    tutorialSlug,
    stepNumber,
    questionId,
    verdict,
    modelName,
    promptVersion,
    promptTokens,
    completionTokens,
    latencyMs,
    errorReason,
    createdAt,
    modifiedAt,
    user
  };

  @readonly entity UIEvents               as projection on ims.UIEvent;

  // Issue #172 PR 5 — branch analytics views (Admin path).
  // Service-level `@requires: 'Admin'` (line 5) is the only gate on these
  // entities — no entity-level @restrict. The Mission ObjectPage's custom
  // section consumes this surface (the OP runs as Admin).
  //
  // The same underlying ims.AnalyticsBranchPerformance view is ALSO projected
  // on AuthorService (see srv/author-service.cds) for the lint rule, which
  // runs with a Tutorial.Author-scoped token. CAP combines service @requires
  // + entity @restrict via AND, so a single service surface cannot cover
  // both audiences.
  @readonly entity AnalyticsBranchPerformance as projection on ims.AnalyticsBranchPerformance;
  @readonly entity AnalyticsBranchTopPick     as projection on ims.AnalyticsBranchTopPick;

  function listExposedEntities() returns array of {
    name        : String;
    sqlName     : String;
    label       : String;
    description : String;
    columns     : array of {
      name        : String;
      type        : String;
      hanaType    : String;
      nullable    : Boolean;
      length      : Integer null;
      filterMode  : String;
      filterSample: Boolean;
      pii         : Boolean;
    };
    associations : array of {
      name         : String;
      targetEntity : String;
      cardinality  : String;
      onLocal      : array of String;
      onTarget     : array of String;
    };
  };

  // The handler returns additional fields not declared here (privacy, historyId).
  // CAP/OData passes the extra JSON fields through unchanged. The optional
  // 'source' parameter records which surface drove the query in the history row;
  // omitted by old clients (additive ship), normalized to 'editor' in the handler.
  // 'spec' is the JSON-stringified QuerySpec (Phase 4); null for editor/legacy paths.
  action runSelectQuery(sql : String, source : String null, spec : String null) returns {
    columns  : array of String;
    rows     : array of String;  // each element is a JSON-stringified row array
    metadata : { rowCount : Integer; truncated : Boolean; durationMs : Integer; };
  };

  // ─── Phase 1 additions (2026-05-31) ──────────────────────────────────────

  /** Sample distinct values for an enum-mode column. Annotation-gated. */
  function sampleDistinct(table : String, column : String, limit : Integer) returns {
    values    : array of String;
    truncated : Boolean;
  };

  /** Stream a query result as CSV. Bypasses 5k row cap; capped at 100k rows / 60s. */
  action exportSelectQuery(sql : String) returns LargeBinary;

  // History (read-only, scoped to current user via @restrict below)
  @readonly entity QueryHistory as projection on ims.AnalyticsQueryHistory;

  // Saved queries — admin-creatable, with rename/visibility/duplicate/recordRun actions.
  // @Capabilities.ChangeTracking surfaces edits in the existing changelog Fiori app
  // (db/analytics-builder.cds carries the @cds.changelog flag on the underlying entity);
  // the projection-side capability is what makes the rows show up in /admin/changelog.
  @Capabilities.ChangeTracking : { Supported: true }
  entity SavedQueries as projection on ims.AnalyticsSavedQuery actions {
    action rename(name : String, description : String) returns SavedQueries;
    action setVisibility(visibility : String) returns SavedQueries;
    action duplicate() returns SavedQueries;
    action recordRun(rowCount : Integer, durationMs : Integer) returns SavedQueries;
  };
}

annotate AnalyticsService.SavedQueries with @restrict : [
  { grant : 'READ',                  where : 'visibility = ''shared-admins'' or createdBy = $user' },
  { grant : ['CREATE'] },
  { grant : ['UPDATE','DELETE'],     where : 'createdBy = $user' }
];

annotate AnalyticsService.QueryHistory with @restrict : [
  { grant : 'READ', where : 'createdBy = $user' }
];
