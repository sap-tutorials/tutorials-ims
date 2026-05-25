using { com.sap.developers.ims as ims } from '../db/schema';
using from '../db/views';

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
      name     : String;
      type     : String;
      nullable : Boolean;
      length   : Integer null;
    };
  };

  action runSelectQuery(sql : String) returns {
    columns  : array of String;
    rows     : array of String;  // each element is a JSON-stringified row array
    metadata : { rowCount : Integer; truncated : Boolean; durationMs : Integer; };
  };
}
