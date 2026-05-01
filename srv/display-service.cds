using { com.sap.developers.ims as ims } from '../db/schema';

@protocol: ['odata', 'websocket']
@path: '/display'
@requires: 'DisplayApp'
service DisplayService {

  @readonly entity Events as projection on ims.Events;
  @readonly entity DashboardMonitoredRecords as projection on ims.DashboardMonitoredRecords;

  function getEventBuckets(eventLegacyId : Integer) returns many {
    bucketName  : String;
    count       : Integer;
    percentage  : Decimal;
  };

  function getEventBurnup(eventLegacyId : Integer) returns many {
    day         : Date;
    count       : Integer;
    cumulative  : Integer;
  };

  function getEventTrackStats(eventLegacyId : Integer) returns many {
    missionLegacyId : Integer;
    title           : String;
    uniqueUsers     : Integer;
    completions     : Integer;
  };

  function getCompletionSpeed(eventLegacyId : Integer) returns many {
    taskLegacyId    : Integer;
    title           : String;
    avgMinutes      : Decimal;
    completions     : Integer;
  };

  function getLeaderboard(eventLegacyId : Integer, top : Integer) returns many {
    userLegacyId : Integer;
    displayName  : String;
    completions  : Integer;
    points       : Integer;
  };

  event tutorialCompleted {
    bucketName    : String;
    completeDate  : String;
    tutorialTitle : String;
    userName      : String;
  }
}
