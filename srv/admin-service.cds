using { com.sap.developers.ims as ims } from '../db/schema';
using from '../db/views';

@path: '/admin'
@requires: 'Admin'
service AdminService {

  // Full CRUD entity projections
  entity Users as projection on ims.Users;
  entity Tutorials as projection on ims.Tutorials;
  entity Missions as projection on ims.Missions;
  entity Groups as projection on ims.Groups;
  entity Steps as projection on ims.Steps;
  entity Events as projection on ims.Events;
  entity Prizes as projection on ims.Prizes;
  entity PrizeRecords as projection on ims.PrizeRecords;
  entity Tags as projection on ims.Tags;
  entity Accomplishments as projection on ims.Accomplishments;
  entity AccomplishmentRecords as projection on ims.AccomplishmentRecords;
  entity TaskRecords as projection on ims.TaskRecords;
  entity TutorialMeta as projection on ims.TutorialMeta;
  entity TutorialContributors as projection on ims.TutorialContributors;
  entity TutorialRepositories as projection on ims.TutorialRepositories;
  entity ImsConfig as projection on ims.ImsConfig;
  entity StepFailures as projection on ims.StepFailures;
  entity NGDSFailedMessages as projection on ims.NGDSFailedMessages;
  entity DeveloperEnvironmentTabs as projection on ims.DeveloperEnvironmentTabs;
  entity FeaturedTasks as projection on ims.FeaturedTasks;
  entity PrimaryAccounts as projection on ims.PrimaryAccounts;
  entity SecondaryAccounts as projection on ims.SecondaryAccounts;
  entity PrivacyProtectionActions as projection on ims.PrivacyProtectionActions;
  entity ActiveLearnerRecords as projection on ims.ActiveLearnerRecords;
  entity CompletionPaths as projection on ims.CompletionPaths;
  entity CompletionPathItems as projection on ims.CompletionPathItems;
  entity DashboardMonitoredRecords as projection on ims.DashboardMonitoredRecords;
  @readonly entity Tasks as projection on ims.Tasks;

  // --- Admin actions ---

  // GDPR / Privacy
  action anonymizeUser(sapId : String);
  action anonymizeByDsrRequest(sapId : String, dsrRequestNumber : String);

  // Maintenance
  action cleanupStepFailures(olderThanDays : Integer);
  action cleanupUnusedTags();
  action setFeaturedOrder(taskLegacyId : Integer, taskType : String, featuredOrder : Integer);

  // Integration-dependent (stubs in Plan 2, implemented in Plan 3)
  action sendToNgds(taskRecordLegacyId : Integer);
  action syncTutorialMetadata();
  action sendContributorNotifications();

  // --- Statistics & export functions ---

  function getEventStatistics(eventLegacyId : Integer) returns {
    tutorials  : Integer;
    groups     : Integer;
    missions   : Integer;
    uniqueUsers : Integer;
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

  function exportTaskRecords(eventLegacyId : Integer, format : String) returns LargeString;
  function exportAwardMissions(eventLegacyId : Integer) returns LargeString;

  function getAccountMergeStatus(uuid : String) returns {
    primaryUuid     : String;
    status          : String;
    mergedAt        : Timestamp;
    secondaryCount  : Integer;
  };

  function findByAccountNumber(sapId : String) returns many TaskRecords;
}
