using { com.sap.developers.ims as ims } from '../db/schema';
using from '../db/views';
using from '../app/admin-annotations';

@path: '/admin'
@requires: 'Admin'
service AdminService {

  // Full CRUD entity projections
  entity Users as projection on ims.Users;
  @cds.redirection.target: true
  @Capabilities.ChangeTracking : { Supported: true }
  entity Tutorials as projection on ims.Tutorials {
    *,
    cast(legacyId as String) as legacyIdStr : String,
    meta : Association to TutorialMeta on meta.tutorial.ID = ID
  };
  // Filtered picklist for redirectTo value help — only ACTIVE tutorials can be redirect targets
  @readonly
  @cds.redirection.target: false
  entity TutorialPickList as projection on ims.Tutorials {
    ID, legacyId, cast(legacyId as String) as legacyIdStr : String, title, slug, primaryTag
  } where status = 'ACTIVE' or status is null;
  // Distinct non-null Owner picklist for Tutorials filter value-help (#95)
  @readonly
  @cds.redirection.target: false
  entity TutorialOwnerPickList as
    select distinct key owner from ims.TutorialMeta where owner is not null;
  entity Missions as projection on ims.Missions { *, virtual null as publishedFieldControl : Integer, cast(legacyId as String) as legacyIdStr : String };
  entity Groups as projection on ims.Groups { *, virtual null as publishedFieldControl : Integer, cast(legacyId as String) as legacyIdStr : String };
  entity Steps as projection on ims.Steps;
  entity Events as projection on ims.Events { *, cast(legacyId as String) as legacyIdStr : String };
  entity Prizes as projection on ims.Prizes { *, cast(legacyId as String) as legacyIdStr : String };
  entity PrizeRecords as projection on ims.PrizeRecords;
  @Capabilities.ChangeTracking : { Supported: true }
  entity Tags as projection on ims.Tags { *, cast(legacyId as String) as legacyIdStr : String };
  entity Accomplishments as projection on ims.Accomplishments { *, cast(legacyId as String) as legacyIdStr : String };
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
  entity FailedEmails as projection on ims.FailedEmails;
  entity PrimaryAccounts as projection on ims.PrimaryAccounts;
  entity SecondaryAccounts as projection on ims.SecondaryAccounts;
  entity PrivacyProtectionActions as projection on ims.PrivacyProtectionActions;
  @readonly entity ActiveLearnerRecords as projection on ims.ActiveLearnerRecords;
  entity CompletionPaths as projection on ims.CompletionPaths;
  entity CompletionPathItems as projection on ims.CompletionPathItems {
    *,
    coalesce(tutorial.title, group.title, checkpointTitle) as taskName : String(500),
    case when taskType = 'TUTORIAL'   then false else true end as hideTutorial   : Boolean,
    case when taskType = 'GROUP'      then false else true end as hideGroup      : Boolean,
    case when taskType = 'CHECKPOINT' then false else true end as hideCheckpoint : Boolean,
    case when taskType = 'TUTORIAL'   then true else false end as showTutorial   : Boolean,
    case when taskType = 'GROUP'      then true else false end as showGroup      : Boolean,
    case when taskType = 'CHECKPOINT' then true else false end as showCheckpoint : Boolean
  };
  entity GroupTags as projection on ims.GroupTags;
  entity GroupPathItems as projection on ims.GroupPathItems;
  entity MissionTags as projection on ims.MissionTags;
  @readonly entity TimeZones as projection on ims.TimeZones;

  @odata.singleton
  @requires: 'Admin'
  entity ChatSettings as projection on ims.ChatSettings actions {
    action seedEmbeddings() returns {
      queued     : Boolean;
      activeSlugs: Integer;
    };
  };

  // Code list entities for enum dropdowns (no DB table needed)
  @readonly @cds.persistence.skip entity ExperienceLevels { key code : String(255); }
  @readonly @cds.persistence.skip entity TaskStatuses     { key code : String(50); }
  @readonly @cds.persistence.skip entity MissionTypes     { key code : String(20); }
  @readonly @cds.persistence.skip entity TaskTypes        { key code : String(20); }

  // Analytics-specific code lists (label included for human-readable dropdowns).
  // taskType differs from TaskTypes above: analytics records carry TUTORIAL,
  // MISSION, GROUP — never CHECKPOINT — because completion is recorded against
  // the parent task, not the checkpoint step.
  @readonly @cds.persistence.skip entity AnalyticsTaskTypes { key code : String(20);  label : String(50); }
  @readonly @cds.persistence.skip entity AnalyticsLevels    { key code : String(50);  label : String(50); }

  @readonly entity Tasks as projection on ims.Tasks;

  @readonly
  entity CompletionAnalytics as projection on ims.CompletionAnalytics;
  @readonly
  @cds.redirection.target: true
  entity PipelineLog as projection on ims.PipelineLog
    where pipelineType != 'SCHEDULED_JOB';

  @readonly entity JobExecutionLog as projection on ims.PipelineLog
    where pipelineType = 'SCHEDULED_JOB';

  @readonly entity PipelineLogItems as projection on ims.PipelineLogItems;
  @readonly entity JobLogItems      as projection on ims.JobLogItems;

  @readonly entity TutorialFeedback          as projection on ims.TutorialFeedback;
  @readonly entity TutorialFeedbackAggregate as projection on ims.TutorialFeedbackAggregate;

  // --- Admin actions ---

  // GDPR / Privacy
  action anonymizeUser(sapId : String);
  action anonymizeByDsrRequest(sapId : String, dsrRequestNumber : String);

  // Maintenance
  action cleanupStepFailures(olderThanDays : Integer);
  action cleanupUnusedTags();
  action setFeaturedOrder(taskLegacyId : Integer, taskType : String, featuredOrder : Integer);

  // Tutorial review & notification management
  action reviewTutorial(tutorialId : UUID) returns {
    reviewedDate         : Timestamp;
    notificationNumber   : Integer;
  };
  action snoozeTutorial(tutorialId : UUID, days : Integer) returns {
    lastNotificationDate : Timestamp;
    notificationNumber   : Integer;
  };

  // Integration-dependent (stubs in Plan 2, implemented in Plan 3)
  action sendToNgds(taskRecordLegacyId : Integer) returns {
    success : Boolean;
    error   : String;
  };
  action syncTutorialMetadata() returns {
    synced  : Integer;
    message : String;
  };
  action sendContributorNotifications() returns {
    notified : Integer;
  };
  action updateNotificationRecipients(emails : String) returns { updated : Boolean };
  action toggleNotifications(enabled : Boolean) returns { enabled : Boolean };
  function getNotificationConfig() returns { enabled : Boolean; recipients : String };

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
  function exportMissionCompletions(startDate : Timestamp, endDate : Timestamp, missionLegacyId : Integer) returns LargeString;

  function getAccountMergeStatus(uuid : String) returns {
    primaryUuid     : String;
    status          : String;
    mergedAt        : Timestamp;
    secondaryCount  : Integer;
  };

  function findByAccountNumber(sapId : String) returns many TaskRecords;

  function findMissingSlugs() returns many {
    taskLegacyId : Integer;
    taskType     : String;
    pathName     : String;
    missionTitle : String;
  };

  // --- Board / overall statistics ---
  function getBoardStatistics() returns {
    totalUsers              : Integer;
    totalTutorials          : Integer;
    totalGroups             : Integer;
    totalMissions           : Integer;
    avgTutorialCompletion   : Decimal;
    avgGroupCompletion      : Decimal;
    avgMissionCompletion    : Decimal;
    tutorialsUpToDate       : Integer;
    tutorialsNeedReview     : Integer;
  };

  // --- Tag Import ---

  type TagImportRow {
    name              : String(255);
    titlePath         : String(255);
    status            : String(20);    // 'new' | 'conflict' | 'invalid'
    existingId        : UUID;
    existingTitlePath : String(255);
    reason            : String(500);
  }

  type TagImportSummary {
    total    : Integer;
    new_     : Integer;                // 'new' is a CDS reserved word
    conflict : Integer;
    invalid  : Integer;
  }

  type TagImportParseWarning {
    line   : Integer;
    name   : String(255);
    reason : String(500);
  }

  type TagImportPreview {
    token         : String(64);
    summary       : TagImportSummary;
    rows          : many TagImportRow;
    parseWarnings : many TagImportParseWarning;
  }

  type TagImportResult {
    inserted : Integer;
    updated  : Integer;
    skipped  : Integer;
    total    : Integer;
  }

  action previewTagImport(payload: LargeString, format: String) returns TagImportPreview;
  action commitTagImport(token: String, strategy: String) returns TagImportResult;
}
