using { com.sap.developers.ims as ims } from '../db/schema';

@path: '/api'
@requires: 'any'
// See note on SearchService: `@graphql` alone REPLACES the OData mount and
// 404's /api/completeStep, /api/setKhorosLink, /api/getKhorosProfile, etc.
@protocol: ['odata', 'graphql', 'mcp']
service DeveloperService {

  // Exposed entities (restricted projections)
  //
  // Authorship surfacing (spec 2026-06-24-tutorial-authorship-fk):
  // Public-authenticated fields are author email + displayName +
  // firstName + lastName (already effectively public via tutorial
  // bylines and /api/advocates). authorSapId is the internal JWT
  // user_uuid claim and stays AdminService-only — the smoke test
  // in test/smoke/tutorial-author-fk.smoke.test.js asserts this.
  @(requires: 'authenticated-user')
  @(restrict: [{ grant: '*', to: 'Tutorial.API' }])
  @readonly entity Tutorials as projection on ims.Tutorials {
    *,
    author.email       as authorEmail       : String,
    author.displayName as authorDisplayName : String,
    author.firstName   as authorFirstName   : String,
    author.lastName    as authorLastName    : String
  } excluding { meta, contributors, repositories };

  @(requires: 'authenticated-user')
  @(restrict: [{ grant: '*', to: 'Tutorial.API' }])
  @readonly entity TaskRecords as projection on ims.TaskRecords;

  // Public Events surface (#646). No associations exposed — admins manage
  // mission/prize/registration linkage via AdminService; public callers only
  // need the slim metadata to filter by type, date range, name.
  @(requires: 'authenticated-user')
  @(restrict: [{ grant: '*', to: 'Tutorial.API' }])
  @readonly entity Events as projection on ims.Events {
    ID, legacyId, name, startDate, endDate, timeZone, eventType
  };

  // Singleton sentinel UUID; safe to expose — already in seed CSV, required because CDS projections need a key.
  // PR 6 — added branchingEnabled so /me/ can show the "branching is currently disabled"
  // info-strip when the master flag is off. ChatConfig keeps @requires: 'any' (anonymous-readable)
  // because Vue islands fetch it on mount before any auth handshake; branchingEnabled is a
  // non-sensitive platform flag.
  @odata.singleton
  @(requires: 'any')
  @readonly
  entity ChatConfig as projection on ims.ChatSettings { ID, enabled, bannerText, branchingEnabled };

  // Frontend endpoints (slug-based, used by tutorials-ims UI)
  @(requires: 'authenticated-user')
  action completeStep(slug : String, stepNumber : Integer) returns {
    completedSteps : array of Integer;
    points         : Integer;
  };

  @(requires: 'authenticated-user')
  action resetTutorialProgress(slug : String) returns {
    newAttemptNumber           : Integer;
    previousAttemptCompletedAt : DateTime;
    supersededRecordCount      : Integer;
  };

  // Task 17 (#600) — explicit declaration for the audit event emitted by
  // resetTutorialProgress. Makes the audit contract first-class (visible
  // in OData $metadata, typed for downstream consumers, discoverable via
  // ORD) instead of an ad-hoc `cds.emit` string. Payload shape MUST match
  // the emit call in srv/developer-service.js (handler emits user,
  // tutorialSlug, attemptNumber, supersededRecordCount,
  // previousAttemptCompletedAt). `user` is dbUser.ID, NOT the email.
  // Extended 2026-07-09 (#1105) with tokenSource (nullable) so admins can
  // distinguish browser-driven from MCP-driven resets.
  event TutorialProgressReset : {
    user                       : String;
    tutorialSlug               : String;
    attemptNumber              : Integer;
    supersededRecordCount      : Integer;
    previousAttemptCompletedAt : DateTime;
    tokenSource                : String; // null | 'jwt' | 'pat'
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

  // Past completions for /me page (signed-in user only)
  @(requires: 'authenticated-user')
  function getMyCompletions() returns many {
    slug                  : String;
    title                 : String;
    primaryTag            : String;
    experienceTag         : String;
    averageTimeToComplete : Integer;
    completionDate        : DateTime;
    attemptNumber         : Integer;
  };

  // App Space progress (replaces AEM /bin/sapdx/tutorials/v3/progress/series)
  @(requires: 'authenticated-user')
  function getEventProgress(missionLegacyId : Integer) returns {
    eventId   : Integer;
    eventType : String;
    type      : String;
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
    eventType : String;
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

  @requires: 'any'
  action submitTutorialFeedback(
    tutorialSlug      : String,
    ratingUseCase     : Integer,
    ratingRelevance   : Integer,
    ratingDuration    : Integer,
    ratingStructure   : Integer,
    ratingInteresting : Integer,
    ratingVisuals     : Integer,
    npsScore          : Integer,
    comment           : String,
    wasAuthenticated  : Boolean,
    honeypot          : String
  ) returns { submissionId : UUID };

  // PR 6 — Pilot enablement. The before-READ row filter (in srv/developer-service.js)
  // scopes every authenticated GET to the caller's own row only.
  // Spec: §4.2
  @(requires: 'authenticated-user')
  @readonly entity LearningPreferences as projection on ims.UserLearningPreferences {
    user, deployment, role, cloud
  };

  // PR 6 — Self-service write surface. PUT-style: all three fields are written every time;
  // values omitted by the caller are explicitly cleared to null.
  // Spec: §4.2, §7.2
  @(requires: 'authenticated-user')
  action setLearningPreferences(
    deployment : String,
    role       : String,
    cloud      : String
  ) returns LearningPreferences;

  // #1030 — Homepage Row 3 events band region preference. Null = clear (fall
  // through to browser-TZ hint on next visit). VIRTUAL and ALL are UI filter
  // modes; AMERICAS/EMEA/APJ are physical regions.
  @(requires: 'authenticated-user')
  action setPreferredEventRegion(region : String) returns Boolean;

  // Issue #566 — SAP Community (Khoros) profile linkage. Display-only unlock
  // in v1; foundation for future Devtoberfest-style consumers.
  @(requires: 'authenticated-user')
  action setKhorosLink(input: String) returns {
    status     : String;
    khorosId   : String;
    khorosLogin: String;
    name       : String;
  };

  @(requires: 'authenticated-user')
  action clearKhorosLink() returns {
    status : String;
  };

  @(requires: 'authenticated-user')
  function getKhorosProfile() returns {
    linked     : Boolean;
    khorosId   : String;
    khorosLogin: String;
    name       : String;
    rank       : String;
    avatarUrl  : String;
    profileUrl : String;
  };

  // Developer Advocates — public read. The hasPhoto flag is INCLUDED so the
  // Vue island can pick `<img>` vs InitialsAvatar without a wasted 404.
  // Public clients construct photo URLs as /api/advocates/:slug/photo from
  // slug + photoUpdatedAt. Spec: docs/superpowers/specs/2026-06-17-developer-advocates-design.md
  @(requires: 'any')
  @readonly entity Advocates as projection on ims.Advocates {
    *,
    topics, links
  };
}
