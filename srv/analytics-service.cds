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
  action runSelectQuery(sql : String, source : String null) returns {
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
