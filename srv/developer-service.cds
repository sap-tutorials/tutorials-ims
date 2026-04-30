using { com.sap.developers.ims as ims } from '../db/schema';

@path: '/api'
@requires: 'DeveloperApp'
service DeveloperService {

  // Exposed entities (restricted projections)
  @readonly entity Tutorials as projection on ims.Tutorials excluding {
    meta, contributors, repositories
  };

  entity TaskRecords as projection on ims.TaskRecords;

  // Frontend endpoints (slug-based, used by tutorials-poc UI)
  action completeStep(slug : String, stepNumber : Integer) returns {
    completedSteps : array of Integer;
    points         : Integer;
  };

  function getProgress(slug : String) returns {
    completedSteps : array of Integer;
    points         : Integer;
    badges         : many {
      name : String;
      icon : String;
    };
  };

  // Legacy IMS-compatible endpoints (legacyId-based)
  action createTaskRecord(
    taskLegacyId : Integer,
    taskType     : String,
    eventLegacyId : Integer
  ) returns TaskRecords;

  function findTaskProgressByUserAndTasksIds(
    userLegacyId  : Integer,
    taskLegacyIds : array of Integer
  ) returns many TaskRecords;

  function countCompletedMissionsTotal(userLegacyId : Integer) returns Integer;
  function countCompletedMissionsPercent(userLegacyId : Integer) returns Decimal;

  // Slug mapping (used by frontend components and build pipeline)
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
}
