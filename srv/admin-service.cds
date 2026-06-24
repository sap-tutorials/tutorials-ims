using { com.sap.developers.ims as ims } from '../db/schema';
using from '../db/views';
using from '../app/admin-annotations';

@path: '/admin'
@requires: 'Admin'
// Photo uploads (Advocates.uploadPhoto bound action) embed base64 image
// bytes in the OData $batch payload. A 4 MB JPEG inflates to ~5.4 MB
// base64 + JSON envelope; the CAP default body_parser limit (1mb)
// rejects with 413. The client-side check at AdvocatePhotoController.js
// caps file uploads at 5 MB raw → ~7 MB after base64 + envelope, so 8mb
// gives a small safety margin without inviting abuse.
@cds.server.body_parser.limit: '8mb'
service AdminService {

  // Full CRUD entity projections
  // @cds.search declares searchable elements for OData $search → HANA
  // CONTAINS. Wired through to the searchable Users value-help on
  // Tutorials.author (see app/admin-annotations.cds). Spec
  // 2026-06-24-tutorial-authorship-fk.
  @cds.search: { displayName, firstName, lastName, email, sapId }
  entity Users as projection on ims.Users;
  @cds.redirection.target: true
  @Capabilities.ChangeTracking : { Supported: true }
  entity Tutorials as projection on ims.Tutorials {
    *,
    cast(legacyId as String) as legacyIdStr : String,
    meta            : Association to TutorialMeta             on meta.tutorial.ID           = ID,
    feedbackSummary : Association to TutorialFeedbackAggregate on feedbackSummary.tutorialSlug = slug,
    feedbackItems   : Association to many TutorialFeedback     on feedbackItems.tutorialSlug   = slug,
    // PR-3 of spec 2026-06-24-tutorials-admin-tile-expansion-design.
    // Inverse associations so the Tutorials admin OP can render per-tutorial
    // facets for validation specs, code-check specs, AI authoring requests,
    // and aggregated completion stats. Each projects a target entity
    // already exposed on AdminService (or a new view, for stats).
    // Specs use the existing tutorial Association FK; submissions and stats
    // join by slug because they predate the FK pattern.
    validationSpecs       : Association to many ValidateAnswerSpecs        on validationSpecs.tutorial = $self,
    validationSubmissions : Association to many ValidateAnswerSubmissions  on validationSubmissions.tutorialSlug = slug,
    codeCheckSpecs        : Association to many CodeCheckSpecs             on codeCheckSpecs.tutorial = $self,
    codeCheckSubmissions  : Association to many CodeCheckSubmissions       on codeCheckSubmissions.tutorialSlug = slug,
    aiRequests            : Association to many AuthorAiRequests           on aiRequests.tutorial = $self,
    completionStats       : Association to TutorialCompletionStats         on completionStats.tutorialSlug = slug,
    // Read-only flattened User fields for the new Tutorials.author FK
    // (spec 2026-06-24-tutorial-authorship-fk). Admin UI gets labeled
    // cells without needing $expand; OData consumers see plain columns.
    // Writes are silently no-op (derived via path expression through
    // the nullable `author` association — null author_ID → null
    // flattened columns, the desired blank-cell behavior).
    author.email       as authorEmail       : String @Common.FieldControl: #ReadOnly,
    author.sapId       as authorSapId       : String @Common.FieldControl: #ReadOnly,
    author.displayName as authorDisplayName : String @Common.FieldControl: #ReadOnly,
    author.firstName   as authorFirstName   : String @Common.FieldControl: #ReadOnly,
    author.lastName    as authorLastName    : String @Common.FieldControl: #ReadOnly
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
  entity Categories         as projection on ims.Categories;
  entity MissionCategories  as projection on ims.MissionCategories;
  entity GroupCategories    as projection on ims.GroupCategories;
  entity TutorialCategories as projection on ims.TutorialCategories;
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

  @odata.singleton
  @requires: 'Admin'
  entity KnowledgeGraphSettings as projection on ims.KnowledgeGraphSettings;

  @odata.draft.enabled
  @requires: 'Admin'
  entity DevtoberfestConfig as projection on ims.DevtoberfestConfig;

  @readonly
  entity EventRegistrations as projection on ims.EventRegistrations;

  // PR-3 of spec 2026-06-24-tutorials-admin-tile-expansion-design.
  // Read-only projections of validation, code-check, and AI-author
  // entities so the Tutorials admin Object Page can render per-tutorial
  // facets (driven by inverse associations defined on the Tutorials
  // projection above). Each entity already lives on AnalyticsService
  // for query-side aggregation; surfacing on AdminService is purely
  // for the tile's drill-down UI.
  @readonly entity ValidateAnswerSpecs       as projection on ims.ValidateAnswerSpecs;
  @readonly entity ValidateAnswerSubmissions as projection on ims.ValidateAnswerSubmissions;
  @readonly entity CodeCheckSpecs            as projection on ims.CodeCheckSpecs;
  @readonly entity CodeCheckSubmissions      as projection on ims.CodeCheckSubmissions;
  @readonly entity AuthorAiRequests          as projection on ims.AuthorAiRequests;
  @readonly entity TutorialCompletionStats   as projection on ims.TutorialCompletionStats;

  // Code list entities for enum dropdowns (no DB table needed)
  @readonly @cds.persistence.skip entity ExperienceLevels { key code : String(255); }
  @readonly @cds.persistence.skip entity TaskStatuses     { key code : String(50); }
  @readonly @cds.persistence.skip entity MissionTypes     { key code : String(20); }
  @readonly @cds.persistence.skip entity TaskTypes        { key code : String(20); }
  @readonly @cds.persistence.skip entity AdvocateRegions  { key code : String(16); label : String(40); }

  // Code list for AdvocateLinks.kind — mirrors the enum on db/advocates.cds.
  // The two are kept in sync by hand; this list is the source of truth for
  // the admin DDLB (rendered via @Common.ValueListWithFixedValues), and the
  // @assert.range enum on the underlying field rejects writes that bypass
  // the dropdown (CSV import, REST, etc.). When you add a new social-link
  // kind, edit BOTH (this list + db/advocates.cds:AdvocateLinks.kind).
  @readonly @cds.persistence.skip entity AdvocateLinkKinds { key code : String(32); label : String(40); }

  // Analytics-specific code lists (label included for human-readable dropdowns).
  // taskType differs from TaskTypes above: analytics records carry TUTORIAL,
  // MISSION, GROUP — never CHECKPOINT — because completion is recorded against
  // the parent task, not the checkpoint step.
  @readonly @cds.persistence.skip entity AnalyticsTaskTypes { key code : String(20);  label : String(50); }
  @readonly @cds.persistence.skip entity AnalyticsLevels    { key code : String(50);  label : String(50); }

  // Pipeline / Job log dropdowns. PipelineTypes excludes SCHEDULED_JOB because
  // the Pipeline Log projection already filters that out (scheduled jobs land
  // in JobExecutionLog). Both lists carry display labels so the Type/Status
  // filters render readable text instead of raw enum keys.
  @readonly @cds.persistence.skip entity PipelineTypes      { key code : String(20);  label : String(50); }
  @readonly @cds.persistence.skip entity PipelineStatuses   { key code : String(10);  label : String(20); }

  // Account-merge status dropdown. Mirrors AccountMergeStatus enum from
  // IMS Java (com.sap.developers.ims.model.account.AccountMergeStatus):
  // CREATED, IN_PROGRESS, SCHEDULED, COMPLETED, FAILED.
  @readonly @cds.persistence.skip entity AccountMergeStatuses { key code : String(20); label : String(30); }

  // ChangeView Change Type dropdown. Mirrors @cap-js/change-tracking's
  // Changes.modification enum (Create/Update/Delete). ValueList ties to
  // ChangeView.modificationLabel (the i18n-resolved label), so the
  // dropdown values are literally 'Create' / 'Update' / 'Delete' rather
  // than the raw db-level enum codes.
  @readonly @cds.persistence.skip entity ChangeTypes { key code : String(8); label : String(8); }

  // Privacy / DSR audit action type dropdown. Mirrors the enum on
  // PrivacyProtectionActions.actionType (SEARCH/DOWNLOAD/ANONYMIZE), the
  // three GDPR DSR fulfilment actions tracked by ims_privacy_protection_audit.
  @readonly @cds.persistence.skip entity PrivacyActionTypes { key code : String(20); label : String(30); }

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
  // Bulk-purge sap.changelog.Changes rows. Designed for admins to clear the
  // 74k+ rows of migration-trigger noise from migrate-from-hana.js runs without
  // waiting for the weekly cron. Defaults: olderThanDays=0 (purge all),
  // migrationOnly=true (only createdBy='migration', leaves real admin-edit
  // audit history intact). Set olderThanDays>0 to scope by date.
  action clearChangeLog(olderThanDays : Integer, migrationOnly : Boolean) returns {
    deleted : Integer;
  };

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
  action testNotificationEmail(to: String, level: Integer) returns {
    success : Boolean;
    error   : String;
  };

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

  // --- Categories ---
  action classifyCategories(
    kind   : String enum { ![all]; mission; group; tutorial },
    ids    : array of String,
    force  : Boolean
  ) returns {
    processed : Integer;
    succeeded : Integer;
    failed    : Integer;
    skipped   : Integer;
  };

  action embedAllSeeds() returns {
    processed : Integer;
  };

  // PR 6 — Pilot enablement. Read-only support surface; admins read all rows
  // (no per-row filter — inherits Admin gate from the service level). UI annotations
  // live in app/admin-annotations.cds (Task 8). Edit-on-behalf is out of scope for v1.
  // Spec: §4.2
  @readonly entity LearningPreferences as projection on ims.UserLearningPreferences;

  // Developer Advocates — admin CRUD. Spec: docs/superpowers/specs/2026-06-17-developer-advocates-design.md
  // Note: I tried adding a `virtual photoIconUrl` element here so the OP
  // HeaderInfo.ImageUrl could resolve to the public REST endpoint, but
  // OData v4 drill-down treats virtual non-primitive paths weirdly and
  // spams "invalid segment: photoIconUrl" errors on every read. Reverted.
  // The header avatar is a v2 follow-up; primary use case is the
  // uploadPhoto / clearPhoto bound actions which work without the virtual.
  @odata.draft.enabled
  entity Advocates as projection on ims.Advocates actions {
    // Bound action for the Object Page photo-upload flow. The Fiori
    // UploadSet against the `photo` composition silently drops bytes
    // through the draft layer; this action is the explicit, working
    // path: admin clicks Upload Photo, picks a file, the AdminService
    // handler runs sharp -> 256/64 WebP, upserts AdvocatePhotos, and
    // flips Advocates.hasPhoto + photoUpdatedAt. The bytes come in as
    // base64 to keep the OData payload self-describing.
    //
    // Instance-bound (no @cds.odata.bindingparameter.collection): FE V4
    // OP header actions invoke against a single-row context, not the
    // entity set. Tom 2026-06-18 hit "Action uploadPhoto must be called
    // on a collection of AdminService.Advocates" when the action was
    // collection-bound but the press handler passed an OP context.
    action uploadPhoto(photoBase64 : String, mimeType : String) returns Advocates;

    // Pair with an action to clear a photo without deleting the advocate.
    action clearPhoto() returns Advocates;
  };
  entity AdvocateTopics  as projection on ims.AdvocateTopics;
  entity AdvocateLinks   as projection on ims.AdvocateLinks;
  entity AdvocatePhotos  as projection on ims.AdvocatePhotos;

  // Phase 2-B (#464): Secrets-visibility metadata-only.
  // Full CRUD over tracked-secret rows. NOT @odata.singleton — this is a list,
  // not a singleton (unlike ChatSettings / KnowledgeGraphSettings).
  @requires: 'Admin'
  entity Secrets as projection on ims.Secrets actions {

    // Phase 2-C (#465): Set a secret's value in BTP Credential Store.
    // Overwrites if value already exists. Stamps lastRotatedAt as a
    // side-effect (admins see immediate feedback in the tile).
    action setSecretValue(value: String) returns {
      written : Boolean;
      lastRotatedAt : Timestamp;
    };

    // Phase 2-C (#465): Generate a fresh value AND write it. For self-gen
    // kinds (salt, content-api-key), mints 32 bytes hex via crypto.randomBytes.
    // For vendor-side kinds (github-pat, service-key, smtp-credential, other),
    // returns structured guidance instead of throwing — tile renders a
    // friendly dialog with the rotationDocsUrl link.
    //
    // Discriminated by the `rotated` flag:
    //   rotated=true  → newValue + written + lastRotatedAt + revealExpiresAt populated;
    //                   rotationDocsUrl is absent/null.
    //   rotated=false → reason='vendor-side' + rotationDocsUrl populated (echoed from row);
    //                   newValue + written + revealExpiresAt are absent/null.
    // Clients must inspect `rotated` first, then read the corresponding subset.
    // CAP serializes unpopulated nullable fields as absent (not literal null) in JSON.
    action rotateSecretValue() returns {
      rotated : Boolean;
      reason : String;          // 'self-generated' | 'vendor-side'
      newValue : String;        // populated only when rotated=true
      written : Boolean;        // populated only when rotated=true
      lastRotatedAt : Timestamp;
      revealExpiresAt : Timestamp;
      rotationDocsUrl : String; // populated when rotated=false (echoed from row)
    };

    // Phase 2-C (#465): Delete the credstore entry. Keeps the HANA metadata
    // row. Idempotent — clearing a non-existent value is a no-op.
    action clearSecretValue() returns {
      cleared : Boolean;
    };

    // Phase 2-C (#465): Reveal the current secret value for short-lived
    // display in the admin tile. Returns plaintext + server-supplied
    // expiresAt (~30s). Each invocation emits an audit event via
    // `audit.log('SecurityEvent', { data: { action: 'SecretValueRead', ... } })`
    // through the `auditEvent()` helper in srv/admin-service.js (custom
    // OData functions don't fire CRUD interceptors; `'SecurityEvent'` is
    // the only registered event name in the @cap-js/audit-logging plugin's
    // CDS service definition — the discriminator lives in `data.action`).
    function revealSecretValue() returns {
      value : String;
      expiresAt : Timestamp;
    };
  };

  // Severity-classified expiry warnings, used by the admin-shell notifications
  // popover. Read-only function (NOT action) — invokable via GET; no CSRF
  // token required for the popover fetch.
  @requires: 'Admin'
  function secretWarnings() returns array of {
    ![key]            : String(120);
    description       : String(500);
    daysRemaining     : Integer;
    severity          : String(10);
    rotationOwner     : String(120);
    rotationDocsUrl   : String(500);
  };

  @odata.singleton @requires: 'Admin'
  entity UiEventsSettings as projection on ims.UiEventsSettings;

  @odata.singleton @requires: 'Admin'
  entity SearchSettings as projection on ims.SearchSettings;

  @odata.singleton @requires: 'Admin'
  entity NavigatorSettings as projection on ims.NavigatorSettings;

  @odata.singleton @requires: 'Admin'
  entity DisplaySettings as projection on ims.DisplaySettings;

  @odata.singleton @requires: 'Admin'
  entity TenantSettings as projection on ims.TenantSettings;

  // Read the source markdown for a single tutorial.
  // PR-2 of spec 2026-06-24-tutorials-admin-tile-expansion-design.
  //
  // Returns the decompressed upstream `.md` content from
  // ContentFiles.sourceContent, plus the persisted sourceHash and
  // contentHash (for future correlation work). Returns null markdown
  // if the active ContentFiles row has no sourceContent (legacy rows
  // pre-PR #591).
  //
  // Drift detection (compare local-source-bytes vs remote-sourceHash)
  // is intentionally NOT done here — local source lives in GitHub,
  // outside the admin tile's reach. The daily content-drift workflow
  // (.github/workflows/source-drift-check.yml) owns that comparison.
  //
  // Why an action instead of a virtual field: ContentFiles.sourceContent
  // is a LargeBinary BLOB and CDS QL on HANA can't safely SELECT it
  // alongside metadata (LOB locator expiry). The action uses raw SQL
  // to grab the BLOB, decompresses it, and returns plain text.
  action getTutorialSource(slug: String) returns {
    markdown    : String;     // decompressed upstream .md text (null if not captured)
    sourceHash  : String;     // SHA-256 of the raw upstream bytes (null for legacy rows)
    contentHash : String;     // SHA-256 of the rendered HTML
  };
}
