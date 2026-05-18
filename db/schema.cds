namespace com.sap.developers.ims;

using { managed, cuid } from '@sap/cds/common';

// Sequence-backed business ID for backward compatibility with legacy integer IDs
aspect LegacyKeyed {
  legacyId : Integer @readonly;
}

// Shared fields for all task types
type ExperienceLevel : String(255) enum { beginner; intermediate; advanced; }
type TaskStatus      : String(50)  enum { ACTIVE; INACTIVE; }
type MissionType     : String(20)  enum { SEQUENTIAL; SET; }
type TaskType        : String(20)  enum { TUTORIAL; GROUP; CHECKPOINT; }

aspect TaskBase : cuid, managed, LegacyKeyed {
  title                     : String(255) @mandatory;
  description               : LargeString;
  status                    : TaskStatus @assert.range;
  deletionReason            : String(500);
  primaryTag                : String(255);
  experienceTag             : ExperienceLevel @assert.range;
  averageTimeToComplete     : Integer;
}

entity Tutorials : TaskBase {
  slug                      : String(255) @mandatory;
  mdFileUrl                 : String(1000);
  featuredOrder             : Integer;
  redirectTo                : Association to Tutorials;
  steps                     : Composition of many Steps on steps.tutorial = $self;
  tags                      : Association to many TutorialTags on tags.tutorial = $self;
  meta                      : Composition of many TutorialMeta on meta.tutorial = $self;
  contributors              : Composition of many TutorialContributors on contributors.tutorial = $self;
  repositories              : Composition of many TutorialRepositories on repositories.tutorial = $self;
}

entity Missions : TaskBase {
  slug                      : String(255);
  communityMissionId        : String(255);
  missionType               : MissionType @assert.range;
  published                 : Boolean default true;
  primaryTagRef             : Association to Tags;
  group                     : Association to Groups;
  event                     : Association to Events;
  completionPaths           : Composition of many CompletionPaths on completionPaths.mission = $self;
  tags                      : Composition of many MissionTags on tags.mission = $self;
}

entity Groups : TaskBase {
  published                 : Boolean default true;
  primaryTagRef             : Association to Tags;
  missions                  : Association to many Missions on missions.group = $self;
  tags                      : Composition of many GroupTags on tags.group = $self;
}

entity Steps : TaskBase {
  tutorial                  : Association to Tutorials;
  stepOrder                 : Integer;
}

entity Checkpoints : TaskBase { }

entity Users : cuid, managed, LegacyKeyed {
  uuid                      : String(36) @mandatory;
  sapId                     : String(255);
  firstName                 : String(255);
  lastName                  : String(255);
  email                     : String(255);
  displayName               : String(255);
  avatarUrl                 : String(1000);
  taskRecords               : Composition of many TaskRecords on taskRecords.user = $self;
  prizeRecords              : Composition of many PrizeRecords on prizeRecords.user = $self;
  accomplishments           : Composition of many AccomplishmentRecords on accomplishments.user = $self;
  metadata                  : Composition of many UserMetaData on metadata.user = $self;
  environmentTabs           : Composition of many DeveloperEnvironmentTabs on environmentTabs.user = $self;
}

entity TaskRecords : cuid, managed, LegacyKeyed {
  user                      : Association to Users @mandatory;
  taskLegacyId              : Integer;
  taskType                  : String enum { TUTORIAL; MISSION; GROUP; STEP; CHECKPOINT; };
  status                    : String enum { COMPLETED; IN_PROGRESS; };
  progress                  : Integer default 0;
  completionTime            : Int64;
  completionDate            : Timestamp;
  contentLanguage           : String(10);
  siteLanguage              : String(10);
  submissionIdStarted       : UUID;
  submissionIdCompleted     : UUID;
  titleSnapshot             : String(255);
  progressNote              : String(1000);
  event                     : Association to Events;
}

entity UserMetaData : cuid, LegacyKeyed {
  user                      : Association to Users;
  ![key]                    : String(255);
  value                     : String(2000);
}

entity DeveloperEnvironmentTabs : cuid, LegacyKeyed {
  user                      : Association to Users;
  tabName                   : String(255);
  tabOrder                  : Integer;
  links                     : Composition of many DeveloperEnvironmentLinks on links.tab = $self;
}

entity DeveloperEnvironmentLinks : cuid, LegacyKeyed {
  tab                       : Association to DeveloperEnvironmentTabs;
  title                     : String(255);
  url                       : String(1000);
  linkOrder                 : Integer;
}

entity Events : cuid, managed, LegacyKeyed {
  name                      : String(255);
  startDate                 : Timestamp;
  endDate                   : Timestamp;
  timeZone                  : String(50);
  mission                   : Association to Missions;
  taskRecords               : Association to many TaskRecords on taskRecords.event = $self;
  prizes                    : Association to many Prizes on prizes.event = $self;
}

entity Prizes : cuid, LegacyKeyed {
  name                      : String(255);
  event                     : Association to Events;
}

entity PrizeRecords : cuid, LegacyKeyed {
  user                      : Association to Users;
  event                     : Association to Events;
  prize                     : Association to Prizes;
  completionPathItem        : Association to CompletionPathItems;
  status                    : String(50);
}

entity Tags : cuid, LegacyKeyed {
  name                      : String(255);
  titlePath                 : String(255);
  virtual mdFormat           : String;
}

entity TutorialTags {
  key tutorial              : Association to Tutorials;
  key tag                   : Association to Tags;
}

entity GroupTags : cuid {
  group                     : Association to Groups;
  tag                       : Association to Tags;
}

entity MissionTags : cuid {
  mission                   : Association to Missions;
  tag                       : Association to Tags;
}

entity Accomplishments : cuid, LegacyKeyed {
  name                      : String(255);
  rule                      : String(2000);
  description               : String(1000);
}

entity AccomplishmentRecords : cuid, LegacyKeyed {
  user                      : Association to Users;
  accomplishment            : Association to Accomplishments;
  awardedAt                 : Timestamp;
}

entity CompletionPaths : cuid, LegacyKeyed {
  mission                   : Association to Missions;
  name                      : String(255);
  description               : String(1000);
  slug                      : String(255);
  items                     : Composition of many CompletionPathItems on items.path = $self;
}

entity CompletionPathItems : cuid, LegacyKeyed {
  path                      : Association to CompletionPaths;
  taskLegacyId              : Integer;
  taskType                  : TaskType @assert.range;
  tutorial                  : Association to Tutorials;
  group                     : Association to Groups;
  checkpointTitle           : String(255);
  prize                     : Association to Prizes;
  itemOrder                 : Integer;
}

entity TutorialMeta : cuid, LegacyKeyed {
  tutorial                  : Association to Tutorials;
  reviewedDate              : Timestamp;
  owner                     : String(255);
  monitoredStatus           : String(50);
  notificationNumber        : Integer default 0;
  lastNotificationDate      : Timestamp;
}

entity TutorialContributors : cuid, LegacyKeyed {
  tutorial                  : Association to Tutorials;
  name                      : String(255);
  email                     : String(255);
  role                      : String(50);
}

entity TutorialRepositories : cuid, LegacyKeyed {
  tutorial                  : Association to Tutorials;
  repoUrl                   : String(1000);
  branch                    : String(255);
  owner                     : String(255);
}

entity ActiveLearnerRecords : cuid, LegacyKeyed {
  recordDate                : Date;
  count                     : Integer;
}

entity DashboardMonitoredRecords : cuid, LegacyKeyed {
  event                     : Association to Events;
  metric                    : String(255);
  value                     : Integer;
  recordedAt                : Timestamp;
}

entity StepFailures : cuid, LegacyKeyed {
  taskRecord                : Association to TaskRecords;
  stepNumber                : Integer;
  failureDate               : Timestamp;
  errorMessage              : String(2000);
}

entity NGDSFailedMessages : cuid, LegacyKeyed {
  payload                   : LargeString;
  errorMessage              : String(2000);
  createdAt                 : Timestamp;
  retryCount                : Integer default 0;
  maxRetries                : Integer default 10;
  status                    : String(30) enum { PENDING; RETRYING; FAILED; SUCCESS; };
}

entity ImsConfig : cuid, LegacyKeyed {
  ![key]                    : String(255);
  value                     : String(2000);
}

@cds.autoexpose @readonly
entity TimeZones {
  key code      : String(50);
  name          : String(100);
  utcOffset     : String(10);
}

entity JobLocks {
  key jobName               : String(100);
  lockedBy                  : String(255);
  lockedAt                  : Timestamp;
  expiresAt                 : Timestamp;
}

entity PrimaryAccounts : cuid, LegacyKeyed {
  uuid                      : String(36);
  status                    : String(50);
}

entity SecondaryAccounts : cuid, LegacyKeyed {
  uuid                      : String(36);
  primaryAccount            : Association to PrimaryAccounts;
  status                    : String(50);
  mergedAt                  : Timestamp;
}

entity PrivacyProtectionActions : cuid, LegacyKeyed {
  userUuid                  : String(36);
  actionType                : String(50);
  requestedAt               : Timestamp;
  completedAt               : Timestamp;
  status                    : String(50);
}

entity FeaturedTasks : cuid, LegacyKeyed {
  taskLegacyId              : Integer;
  taskType                  : String(20) enum { TUTORIAL; MISSION; GROUP; };
  featuredOrder             : Integer;
}

entity FailedEmails : cuid {
  to                        : String(2000);
  cc                        : String(2000);
  subject                   : String(500);
  body                      : LargeString;
  errorMessage              : String(2000);
  createdAt                 : Timestamp;
  retryCount                : Integer default 0;
  maxRetries                : Integer default 3;
  status                    : String(20) enum { PENDING; SENT; FAILED; } default 'PENDING';
}

entity ContentFiles : managed {
  key slug                  : String(255);
  key version               : Integer;
  content                   : LargeBinary;
  contentHash               : String(64);
  sizeBytes                 : Integer;
  compressedBytes           : Integer;
  mimeType                  : String(100) default 'text/html';
}

entity ContentManifest : managed {
  key version               : Integer;
  status                    : String(20) enum { PUBLISHING; ACTIVE; SUPERSEDED; ROLLED_BACK; };
  trigger                   : String(500);
  fileCount                 : Integer;
  totalSizeBytes            : Int64;
  changedSlugs              : LargeString;
  hugoVersion               : String(20);
  publishDurationMs         : Integer;
}

entity PipelineLog : cuid, managed {
  pipelineType    : String(20) enum { CONTENT_PUBLISH; HUGO_BUILD; MTA_DEPLOY; SCHEDULED_JOB; GITHUB_DISPATCH; };
  status          : String(10) enum { RUNNING; SUCCESS; FAILED; };
  startedAt       : Timestamp;
  finishedAt      : Timestamp;
  durationMs      : Integer;
  initiator       : String(255);
  summary         : String(2000);
  errorDetails    : LargeString;
  metadata        : LargeString;
  statusCriticality : Integer @Core.Computed;
}
