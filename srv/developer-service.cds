using { com.sap.developers.ims as ims } from '../db/schema';

@path: '/api'
@requires: 'any'
service DeveloperService {

  // Exposed entities (restricted projections)
  @(requires: 'authenticated-user')
  @readonly entity Tutorials as projection on ims.Tutorials excluding {
    meta, contributors, repositories
  };

  @(requires: 'authenticated-user')
  entity TaskRecords as projection on ims.TaskRecords;

  @(requires: 'any')
  @readonly
  entity ChatConfig as projection on ims.ChatSettings { ID, enabled, bannerText };

  // Frontend endpoints (slug-based, used by tutorials-poc UI)
  @(requires: 'authenticated-user')
  action completeStep(slug : String, stepNumber : Integer) returns {
    completedSteps : array of Integer;
    points         : Integer;
  };

  @(requires: 'authenticated-user')
  function getProgress(slug : String) returns {
    completedSteps : array of Integer;
    points         : Integer;
    badges         : many {
      name : String;
      icon : String;
    };
  };

  // Legacy IMS-compatible endpoints (legacyId-based)
  @(requires: 'authenticated-user')
  action createTaskRecord(
    taskLegacyId : Integer,
    taskType     : String,
    eventLegacyId : Integer
  ) returns TaskRecords;

  @(requires: 'authenticated-user')
  function findTaskProgressByUserAndTasksIds(
    userLegacyId  : Integer,
    taskLegacyIds : array of Integer
  ) returns many TaskRecords;

  @(requires: 'authenticated-user')
  function countCompletedMissionsTotal(userLegacyId : Integer) returns Integer;
  @(requires: 'authenticated-user')
  function countCompletedMissionsPercent(userLegacyId : Integer) returns Decimal;

  // Slug mapping (used by frontend components and build pipeline)
  @(requires: 'authenticated-user')
  function getSlugMapping() returns {
    flat    : many { legacyId : Integer; slug : String; entityType : String; title : String };
    grouped : {
      tutorials : many { legacyId : Integer; slug : String; title : String };
      missions  : many { legacyId : Integer; slug : String; title : String };
      paths     : many { legacyId : Integer; slug : String; title : String };
    };
    keyed   : many { compositeKey : String; slug : String; title : String };
  };

  // App Space progress (replaces AEM /bin/sapdx/tutorials/v3/progress/series)
  @(requires: 'authenticated-user')
  function getEventProgress(missionLegacyId : Integer) returns {
    eventId : Integer;
    type    : String;
    paths   : many {
      id          : Integer;
      title       : String;
      description : String;
      items       : many {
        imsId          : Integer;
        title          : String;
        type           : String;
        status         : String;
        progress       : Integer;
        experience     : String;
        timeToComplete : Integer;
        url            : String;
        description    : String;
        recordId       : Integer;
      };
    };
  };

  // App Space progress by event ID (frontend default: latest event)
  @(requires: 'authenticated-user')
  function getAppSpaceProgress(eventLegacyId : Integer) returns {
    eventId   : Integer;
    eventName : String;
    type      : String;
    paths     : many {
      id          : Integer;
      title       : String;
      description : String;
      items       : many {
        imsId          : Integer;
        title          : String;
        type           : String;
        status         : String;
        progress       : Integer;
        experience     : String;
        timeToComplete : Integer;
        url            : String;
        description    : String;
        recordId       : Integer;
      };
    };
  };
}
