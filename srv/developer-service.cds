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
}
