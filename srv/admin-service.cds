using { com.sap.developers.ims as ims } from '../db/schema';
using { com.sap.developers.ims.external as external } from '../db/external-content';
using from '../db/knowledge-graph-communities';
using from '../db/knowledge-graph-ondemand';
using from '../db/community-blogs';
using from '../db/homepage-featured';
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
  entity Users as projection on ims.Users actions {
    @(requires: 'Admin')
    action clearKhorosLink() returns { status: String };
  };
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
    author.lastName    as authorLastName    : String @Common.FieldControl: #ReadOnly,
    // #918 — populated by after('READ') decorator in admin-service.js.
    // True iff a KgIsolation row exists for this tutorial slug. Fail-quiet:
    // if the SELECT throws or the sidecar is missing, stays null.
    virtual isolated : Boolean
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
  // Issue #644 — Puzzles is a TaskBase peer of Tutorials/Missions/Groups,
  // exposed for admin CRUD so puzzles can be authored and curated.
  entity Puzzles as projection on ims.Puzzles { *, cast(legacyId as String) as legacyIdStr : String };
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

  // Issue #644 — per-taskType drill-down projections. Each filters TaskRecords
  // on one taskType and adds a typed association to the corresponding content
  // entity by legacyId, so admin tiles can surface a typed "Title" column and
  // a navigable link to the content row. SUPERSEDED filtering and other
  // annotations come from the TaskRecords annotate block — admins flip filters
  // identically across all six surfaces.
  //
  // Mirrors the discriminated-association pattern on db.TaskRecordsAnalytics
  // (views.cds:226) but exposed as @readonly facets per type. Insert/Update/
  // Delete restrictions are enforced via the shared annotation block in
  // app/admin-annotations.cds (TaskRecords is read-only — these inherit).
  @readonly @cds.redirection.target: false
  entity TutorialTaskRecords as projection on ims.TaskRecords {
    *,
    tutorial : Association to ims.Tutorials on tutorial.legacyId = taskLegacyId
  } where taskType = 'TUTORIAL';

  @readonly @cds.redirection.target: false
  entity MissionTaskRecords as projection on ims.TaskRecords {
    *,
    mission : Association to ims.Missions on mission.legacyId = taskLegacyId
  } where taskType = 'MISSION';

  @readonly @cds.redirection.target: false
  entity GroupTaskRecords as projection on ims.TaskRecords {
    *,
    group : Association to ims.Groups on group.legacyId = taskLegacyId
  } where taskType = 'GROUP';

  @readonly @cds.redirection.target: false
  entity StepTaskRecords as projection on ims.TaskRecords {
    *,
    step : Association to ims.Steps on step.legacyId = taskLegacyId
  } where taskType = 'STEP';

  // Checkpoints have no slug or content-store entry, so there is no useful
  // typed association — titleSnapshot from the record itself is the display.
  @readonly @cds.redirection.target: false
  entity CheckpointTaskRecords as projection on ims.TaskRecords {
    *
  } where taskType = 'CHECKPOINT';

  @readonly @cds.redirection.target: false
  entity PuzzleTaskRecords as projection on ims.TaskRecords {
    *,
    puzzle : Association to ims.Puzzles on puzzle.legacyId = taskLegacyId
  } where taskType = 'PUZZLE';
  entity TutorialMeta as projection on ims.TutorialMeta;
  entity TutorialContributors as projection on ims.TutorialContributors;
  entity TutorialRepositories as projection on ims.TutorialRepositories;
  entity ImsConfig as projection on ims.ImsConfig;
  entity StepFailures as projection on ims.StepFailures;
  entity NGDSFailedMessages as projection on ims.NGDSFailedMessages;
  entity DeveloperEnvironmentTabs as projection on ims.DeveloperEnvironmentTabs;
  entity FeaturedTasks as projection on ims.FeaturedTasks;

  @odata.draft.enabled
  entity Alerts as projection on ims.Alerts;

  // Homepage redesign (#639). HomepageShelves is the source of truth for
  // shelves on / and /<verb>/. LegacyRedirects feeds the approuter's
  // dynamic redirect map. HomepageConfig is a singleton with the
  // featured-playlist ID and per-band feature flags.
  //
  // (#759 hotfix) `markReviewed` + `regenerate` are bound to HomepageShelves
  // so Fiori Elements V4 can wire them as OP-header DataFieldForAction
  // entries with auto-bound row context. PR 3b's unbound versions stay
  // on the service level for ListReport bulk fan-out; the bound singletons
  // here power the per-row OP buttons. Return shape is inlined to dodge
  // forward-ref against `type ExplainerActionResult` below.
  @cds.redirection.target: true
  @Capabilities.ChangeTracking : { Supported: true }
  @odata.draft.enabled
  entity HomepageShelves as projection on ims.HomepageShelves actions {
    action markReviewed() returns { processed : Integer; skipped : Integer; cost : String };
    action regenerate()   returns { processed : Integer; skipped : Integer; cost : String };
  };

  @cds.redirection.target: true
  @Capabilities.ChangeTracking : { Supported: true }
  @odata.draft.enabled
  entity LegacyRedirects as projection on ims.LegacyRedirects;

  // #1052 follow-up: `@odata.singleton` is INCOMPATIBLE with
  // `@odata.draft.enabled` — the singleton contract omits the key from the
  // URL, but CAP's draft runtime still requires `ID` for `draftActivate`
  // (verified live: `POST /HomepageConfig(IsActiveEntity=false)/AdminService.draftActivate`
  // returns 400 "Key \"ID\" is missing for entity \"AdminService.HomepageConfig\"").
  // FE V4 detects the broken round-trip and renders the OP read-only — no
  // Edit button. #1052 added `@odata.draft.enabled` but kept `@odata.singleton`,
  // so `draftEdit` succeeded but `draftActivate` couldn't be driven from FE.
  //
  // Fix: expose as a regular keyed entity. The auto-init handler at
  // srv/admin-service.js:601 already writes a single row with a fixed UUID
  // (00000000-0000-0000-0000-00000000c8ae), so the "there is exactly one
  // row" invariant still holds. Matches the peer pattern used by
  // VerbDefinitions / ShelfDefinitions / LegacyRedirects (draft-enabled +
  // Insert/Delete locked down + Update allowed). Deep-link shape becomes
  // `/admin/HomepageConfig(00000000-0000-0000-0000-00000000c8ae)`, wired
  // through app/admin-shell/webapp/controller/Shell.controller.js.
  //
  // No @Common.ValueList fields on this entity → the #1019 @cap-js/ai
  // AICore-kind-resolution hazard does not apply (would have blocked Save).
  @odata.draft.enabled
  @Capabilities.ChangeTracking : { Supported: false }
  @Capabilities.InsertRestrictions.Insertable : false
  @Capabilities.DeleteRestrictions.Deletable  : false
  @Capabilities.UpdateRestrictions.Updatable  : true
  entity HomepageConfig as projection on ims.HomepageConfig;

  // (#759) Per-verb and per-shelf explainer content. Both have fixed
  // cardinality (7 verbs / 4 shelves); CRUD lockdown lives in the
  // Fiori admin app annotations (PR 3). Projection itself is
  // unconstrained — same shape as HomepageConfig. Change-tracking is
  // off (matches HomepageConfig — singleton-set config, not a catalog).
  @Capabilities.ChangeTracking : { Supported: false }
  @odata.draft.enabled
  entity VerbDefinitions as projection on ims.VerbDefinitions actions {
    action markReviewed() returns { processed : Integer; skipped : Integer; cost : String };
    action regenerate()   returns { processed : Integer; skipped : Integer; cost : String };
  };

  @Capabilities.ChangeTracking : { Supported: false }
  @odata.draft.enabled
  entity ShelfDefinitions as projection on ims.ShelfDefinitions actions {
    action markReviewed() returns { processed : Integer; skipped : Integer; cost : String };
    action regenerate()   returns { processed : Integer; skipped : Integer; cost : String };
  };

  // (#1033) Community Blog Posts admin surface. Sources = admin-editable
  // list of RSS feed URLs; Posts = fetched candidates + AI verdict + admin
  // override. Draft-enabled so admins get the standard Fiori edit round-trip.
  //
  // No @Common.ValueList on either projection — deliberately sidesteps the
  // @cap-js/ai AICore-kind-resolution hazard (memory: cap-ai-plugin-aicore-kind-resolution).
  //
  // reclassifyCommunityBlogPost resets a row to PENDING with attemptCount=0
  // so the classifier drain picks it up on the next 15-min tick.
  @odata.draft.enabled
  entity CommunityBlogSources as projection on ims.CommunityBlogSources;

  @odata.draft.enabled
  entity CommunityBlogPosts   as projection on ims.CommunityBlogPosts;

  action reclassifyCommunityBlogPost(ID: UUID) returns Boolean;

  // (#763) For-you candidate pool — admin editing surface.
  // Validator in admin-service.js rejects unknown persona tags at save time.
  @odata.draft.enabled
  entity HomepageForYouCandidatesAdmin as projection on ims.HomepageForYouCandidates;

  @readonly @cds.persistence.skip entity AlertCtaTargets {
    key url   : String(500);
        label : String(100);
  }

  // (#763) Value-help entity for @Common.ValueList bindings on HomepageShelves
  // personaTags / personaHidden. Served in-memory from KNOWN_TAGS by the READ
  // handler in admin-service.js — no DB table, no persistence.
  @readonly @cds.persistence.skip entity PersonaTagChoices {
    key tag : String(40);
  }

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
    // Issue #943: one-shot backfill for Concepts.embedding. Distinct from
    // seedEmbeddings (which handles TutorialEmbedding via embedSlugs). Runs
    // srv/jobs/concept-embedding-backfill.js:runConceptEmbeddingBackfill()
    // synchronously and returns the summary. Auth via @requires: 'Admin' at
    // the entity level.
    action seedConceptEmbeddings() returns {
      processed : Integer;
      failed    : Integer;
      latencyMs : Integer;
    };
  };

  @odata.singleton
  @requires: 'Admin'
  entity KnowledgeGraphSettings as projection on ims.KnowledgeGraphSettings actions {
    // Phase 4.5 (#746): operator-grade api.sap.com seed trigger.
    // Single source of truth with scripts/seed-api-docs.cjs (both call
    // srv/lib/seed-api-docs.js's runSeedApiDocs). Dry-run when commit=false.
    action seedApiDocs(commit: Boolean) returns {
      planned   : Integer;
      committed : Integer;
    };
    // Phase 4.6 (#747): operator-grade SAP-samples corpus bootstrap.
    // Fire-and-forget invocation of the weekly fetch-samples cron with
    // sinceIsoOverride to bypass the MAX-or-abort first-run gate.
    action seedSamples(commit: Boolean) returns {
      started : Boolean;
      reason  : String;
    };
    // Phase 4.7 (#748): operator-grade HelpDocs corpus bootstrap
    // (help.sap.com + cap.cloud.sap + ui5.sap.com).
    // Fire-and-forget invocation of the weekly fetch-help-docs cron with
    // sinceIsoOverride to bypass the MAX-or-abort first-run gate.
    action seedHelpDocs(commit: Boolean) returns {
      started : Boolean;
      reason  : String;
    };
    // Phase 4.8 (#765): operator-grade CommunityEvents corpus bootstrap
    // (Khoros CodeJams + Devtoberfest RSS). Fire-and-forget invocation
    // of the twice-weekly fetch-community-events cron with
    // sinceIsoOverride to bypass the MAX-or-abort first-run gate.
    action seedCommunityEvents(commit: Boolean) returns {
      started : Boolean;
      reason  : String;
    };
  };

  // Phase 4.5 (#746): per-cron last-run health surface for the admin
  // "Cron health" tile on the Board view. Only fetch-api-docs currently
  // writes rows here; Phase 4.1-4.4 retrofit is out of scope.
  @readonly @requires: 'Admin'
  entity JobLastRun as projection on ims.JobLastRun;

  // ─────────────────────────────────────────────────────────────────
  // #756: generic admin trigger for any registered cron job.
  // Operators can list all 24 registered jobs (with computed next-run
  // timestamp) and trigger any of them manually. Trigger is fire-and-forget;
  // completion observed via JobLastRun + the SecurityEvent audit log.
  // ─────────────────────────────────────────────────────────────────
  @odata.singleton
  @requires: 'Admin'
  entity JobControls {
    key label : String default 'Job controls';
  } actions {
    action listJobs() returns array of {
      jobName     : String;
      schedule    : String;
      ttlMs       : Integer;
      description : String;
      nextRunIso  : String;
      // #750: ISO timestamps of cron firings in (now, now+24h], capped at 50
      // per job. Empty for monthly crons whose next firing falls outside the
      // window — nextRunIso still populated via fallback.
      nextRunsIso : array of String;
      wedged      : Boolean;                                    // #1021
    };

    // #1023: currently-executing scheduled jobs. Read from PipelineLog rows
    // where pipelineType='SCHEDULED_JOB' AND status='RUNNING'; jobName pulled
    // from metadata JSON (see srv/jobs/scheduler.js: logPipelineStart writes
    // { jobName }). Powers the Cron health tile's RUNNING state so operators
    // can tell "job is executing right now" apart from "last run failed."
    action listRunningJobs() returns array of {
      jobName   : String;
      startedAt : Timestamp;
    };

    action runJob(jobName: String) returns {
      jobName   : String;
      started   : Boolean;
      skipped   : Boolean;
      reason    : String;
      startedAt : Timestamp;
    };

    // #1021: DELETE the stuck cds.outbox.Messages row for jobName. Used
    // by the Cron health panel's "Force unwedge" button. DELETE-only —
    // does NOT auto-trigger a run. Emits SecurityEvent audit with
    // outcome='unwedged'.
    action forceUnwedge(jobName: String) returns {
      jobName   : String;
      cleared   : Boolean;
      reason    : String;
    };
  };

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

  // Issue #622 — read-only recipient list for the "Last Chance Emails"
  // admin section. Powers the dropdown for sendLastChanceEmail and the
  // preview list for sendLastChanceEmailsAllDormant. One row per
  // FK-resolved author with ≥1 stale active tutorial. Underlying view
  // definition + caveats in db/views.cds.
  @readonly entity DormantAuthors            as projection on ims.DormantAuthors;

  // Code list entities for enum dropdowns (no DB table needed)
  @readonly @cds.persistence.skip entity ExperienceLevels { key code : String(255); }
  @readonly @cds.persistence.skip entity TaskStatuses     { key code : String(50); }
  @readonly @cds.persistence.skip entity MissionTypes     { key code : String(20); }
  @readonly @cds.persistence.skip entity TaskTypes        { key code : String(20); }
  // Issue #715 — Event Type dropdown. Mirrors the EventType enum in
  // db/schema.cds:19 (DEVTOBERFEST/TECHED/CODEJAM/CHALLENGE/OTHER); label
  // surfaces a friendly display ("Devtoberfest") in place of the all-caps code.
  @readonly @cds.persistence.skip entity EventTypes       { key code : String(20); label : String(40); }
  // Issue #718 — Alerts severity & audience dropdowns. Codes mirror the
  // inline enums on db/schema.cds:467-471 exactly; @assert.range on the
  // underlying fields rejects writes that bypass the dropdown.
  @readonly @cds.persistence.skip entity AlertSeverities  { key code : String(20); label : String(40); }
  @readonly @cds.persistence.skip entity AlertAudiences   { key code : String(20); label : String(40); }
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
  // Bulk-purge sap.changelog.Changes rows for entities whose @changelog
  // tracking was retroactively dropped (configuration singletons +
  // AI-generated KG tables — see #658). Pass an empty array (or omit) to
  // use the NOISE_ENTITIES default list. Idempotent.
  action purgeNoiseChangeLog(entities : array of String) returns {
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
  action sendLastChanceEmail(
    authorEmail : String,
    dryRun      : Boolean
  ) returns {
    success           : Boolean;
    recipientTo       : String;
    recipientCc       : array of String;
    tutorialsIncluded : Integer;
    tutorialSlugs     : array of String;
    error             : String;
  };
  action sendLastChanceEmailsAllDormant(
    dryRun : Boolean
  ) returns {
    authorsProcessed : Integer;
    emailsSent       : Integer;
    emailsFailed     : Integer;
    authorsSkipped   : Integer;
    errors           : array of String;
    preview          : array of {
      authorEmail   : String;
      tutorialCount : Integer;
      worstLevel    : Integer;
    };
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

  // --- #805 Observability live snapshot ---
  // Returns JSON-encoded string (avoids modelling the nested counters/gauges/
  // histograms shape in CDS). The admin-shell tile JSON.parses the string.
  // The plain /admin/metrics/live Express route (basic-auth) returns the same
  // shape for on-call curl. See docs/developers/architecture/observability.md.
  function getMetricsSnapshot() returns String;

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

  // (#759 PR 3a) Homepage explainer AI generation actions.
  // One action per kind (verb / shelf / shelf-entry) so Fiori list-report
  // actions stay scoped to the entity their list displays (FE V4 doesn't
  // handle polymorphic actions cleanly). Shared return shape; shared
  // orchestrator in srv/lib/explainer-generator.js.
  //
  // mode 'fill-blanks'         → process only rows where authoringStatus='BLANK'; ids ignored
  // mode 'regenerate-selected' → process exactly the ids supplied, regardless of status
  //
  // Hard cap: ids.length > 100 returns HTTP 400 (CAP_EXCEEDED).
  // Kill-switch: env AICORE_EXPLAINER_GENERATOR_DISABLED=true → HTTP 503.
  //
  // cost is a USD string like '$0.62' for surfacing in the admin success toast.
  type ExplainerActionResult : {
    processed : Integer;
    skipped   : Integer;
    cost      : String;
  };

  action generateVerbExplainers       (ids : array of String, mode : String) returns ExplainerActionResult;
  action generateShelfExplainers      (ids : array of String, mode : String) returns ExplainerActionResult;
  action generateShelfEntryExplainers (ids : array of String, mode : String) returns ExplainerActionResult;

  action markVerbExplainerReviewed       (id : String) returns ExplainerActionResult;
  action markShelfExplainerReviewed      (id : String) returns ExplainerActionResult;
  action markShelfEntryExplainerReviewed (id : String) returns ExplainerActionResult;

  // (#790) Bulk Mark-reviewed actions — flip every AI_SEEDED row in `ids`
  // to REVIEWED in one round-trip. BLANK and REVIEWED rows are filtered
  // out server-side (see srv/admin-service.js:runBulkMarkReviewed). No
  // confirm dialog on the UI side because the flip is reversible by
  // re-generating. Used by the multi-select LineItem action in
  // app/admin/{verb,shelf,homepage}/webapp/manifest.json.
  action bulkMarkVerbExplainerReviewed(ids       : array of String) returns ExplainerActionResult;
  action bulkMarkShelfExplainerReviewed(ids      : array of String) returns ExplainerActionResult;
  action bulkMarkShelfEntryExplainerReviewed(ids : array of String) returns ExplainerActionResult;

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
  entity Advocates as projection on ims.Advocates {
    *,
    // Tutorials facets — the projection-alias form (user.authoredTutorials
    // as authoredTutorials) did NOT generate working OData paths. PR
    // 2026-06-25-advocate-op-fixes moved these to real Associations on
    // ims.Advocates with explicit on-conditions joining via user_ID. The
    // wildcard `*` above pulls them through; no rename needed.
    // Virtual editable mirror of user.email. Fiori V4 won't edit through a
    // foreign association inline; the after-READ handler hydrates this from
    // user.email and the before-UPDATE / SAVE-on-drafts handlers propagate
    // it back to Users.email.
    // @Core.Computed: false overrides CAP's auto-tag of virtual elements
    // as computed (which FE V4 honors as read-only, hiding the edit field).
    // Spec: docs/superpowers/specs/2026-06-25-advocate-email-edit-design.md §4
    //   + 2026-06-25-advocate-op-fixes-design.md §4.1
    virtual emailEdit : String(255) @Core.Computed: false,
  } actions {
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

  // #777 followup (2026-06-30) — admin-facing projection on the canonical
  // 4-source author/owner view, bridged through Users.ID for association
  // compatibility (see db/views.cds:MyTutorialsByUserId).
  // Sourced by the Advocate Object Page's ownedTutorials facet
  // (db/advocates.cds). Read-only by construction; the AdminService is
  // already @requires:'Admin' at service level, making any extra guard
  // redundant — but admin-service.js adds a belt-and-suspenders
  // before('READ') check anyway.
  @readonly
  @cds.autoexpose: false
  entity MyTutorials as projection on ims.MyTutorialsByUserId;

  // Phase 2-B (#464): Secrets-visibility metadata-only.
  // Full CRUD over tracked-secret rows. NOT @odata.singleton — this is a list,
  // not a singleton (unlike ChatSettings / KnowledgeGraphSettings).
  //
  // #1018: `hasValue` is a virtual Boolean populated by an after('READ')
  // handler in admin-service.js that probes BTP Credential Store per row
  // (5-min cached). Renders as a red "Missing value" badge in the FE List
  // Report — see app/admin-annotations.cds for the UI.Criticality wiring.
  @requires: 'Admin'
  entity Secrets as projection on ims.Secrets {
    *,
    virtual null as hasValue : Boolean
  } actions {

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
  //
  // #1018: the `reason` field discriminates 'expiry' (row's expiresAt is
  // within the CRITICAL/WARNING/INFO thresholds) from 'missing-value' (row
  // exists in HANA but its credstore value is null / unreachable). Missing
  // values are always CRITICAL and always have daysRemaining=null.
  @requires: 'Admin'
  function secretWarnings() returns array of {
    ![key]            : String(120);
    description       : String(500);
    daysRemaining     : Integer;
    severity          : String(10);
    reason            : String(20);   // 'expiry' | 'missing-value'
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

// ── Rebuild-button action (issue: rebuild-button, spec: 2026-06-24-admin-tutorial-rebuild-button) ──
// Declared via `extend service` + `extend entity ... with actions` so the
// existing Tutorials projection at lines 20-26 stays untouched. The split
// form is required by the CDS compiler — `entity Tutorials actions { ... }`
// inside a single `extend service` block parses as a new entity declaration
// and conflicts with the existing projection. Handler implementation in
// srv/admin-service.js.
extend service AdminService with {
  type RebuildContentResult {
    dispatched : Boolean;
    slug       : String;
    debounced  : Boolean;
    workflowUrl: String;
  };
}

extend entity AdminService.Tutorials with actions {
  @Core.OperationAvailable: true
  @Common.IsActionCritical : true
  action rebuildContent() returns AdminService.RebuildContentResult;
};

// #948: On-demand KG extraction request queue — read-only admin view.
// The drain job (srv/jobs/kg-ondemand-job.js) writes via db.tx, bypassing
// the service; the AdminService surface is observe-only for operators.
extend service AdminService with {
  @readonly
  entity KgOnDemandRequests as projection on ims.KgOnDemandRequests;
}
extend service AdminService with {

  // LR-facing aggregate. One row per detected community.
  // topConceptSlugs is computed at read time by the
  // after('READ', 'KgCommunities') decorator in srv/admin-service.js
  // — not persisted; recomputed per request against KgCommunity.
  //
  // alreadyPromoted is now materialized in the underlying view via a
  // LEFT JOIN Missions on communityFingerprint (#986). Previously it
  // was a virtual null column populated by an after('READ') handler,
  // but that meant the LR's default filter — set by SPV #default in
  // app/admin-annotations.cds — evaluated against NULL at the DB layer
  // and dropped every row. See db/knowledge-graph-communities.cds.
  @readonly
  entity KgCommunities as projection on ims.KgCommunitySummaryV {
    *,
    virtual null as topConceptSlugs : String(255),
  };

  // OP-facing memberships. Rows keyed to (communityId, vertexKey).
  @readonly
  entity KgCommunityMembers as projection on ims.KgCommunity;

  // Drafts a Mission from the community's tutorial members, ordered A→Z.
  // Curator finishes the draft in the Missions LR (write description,
  // reorder, drop tutorials, publish). Returns the new Mission ID so
  // FE can navigate to it. See srv/admin-service.js for the handler.
  // Guarded to SuperAdmin (matches the write-guard pattern used by
  // Missions.published — req.user.is('SuperAdmin') at admin-service.js:1585).
  @requires: 'SuperAdmin'
  action promoteCommunityToMission(
    communityId : Integer,
    missionSlug : String(255),
    title       : String(255)
  ) returns AdminService.Missions;
}

// (#1032) Featured missions carousel — editorial rows + read-only snapshot.
// @assert.unique.concept on HomepageFeaturedTopics enforces one row per concept.
// recomputeFeaturedTopics is SuperAdmin-gated (manual trigger); inline recompute
// after CREATE/UPDATE/DELETE is handled in srv/admin-service.js.
// Concepts is exposed read-only here as a value-help entity for the concept_ID
// field on FeaturedTopics (Common.ValueList in app/admin-annotations.cds).
extend service AdminService with {
  @odata.draft.enabled
  @requires: 'Admin'
  entity FeaturedTopics as projection on ims.HomepageFeaturedTopics;

  @readonly
  @requires: 'Admin'
  entity FeaturedTopicsSnapshotView as projection on ims.FeaturedTopicsSnapshot;

  // (#1032) Value-help for concept_ID on FeaturedTopics.
  // Read-only projection mirroring KnowledgeGraphService.Concepts.
  @readonly
  @requires: 'Admin'
  entity Concepts as projection on ims.Concepts { ID, slug, name, status };

  @requires: 'SuperAdmin'
  action recomputeFeaturedTopics() returns { count : Integer; computedAt : Timestamp; };
}

// (#1031) Homepage video band admin surfaces.
// - Videos: editable projection on ext.Videos (only `excludeFromHomepage` is
//   admin-writable; other columns read-only via app/admin-annotations.cds).
// - HomepageVideoRotationView: read-only join over the sidecar for the
//   "what's in rotation now" viewer at /admin-ui/#video-rotation.
// - recomputeHomepageVideoRotation: SuperAdmin manual trigger; runs the same
//   body as the 4h cron. Precedent: recomputeFeaturedTopics (#1032).
extend service AdminService with {
  @odata.draft.enabled
  @requires: 'Admin'
  entity Videos as projection on external.Videos;

  @readonly
  @requires: 'Admin'
  entity HomepageVideoRotationView as projection on ims.HomepageVideoRotation;

  @requires: 'SuperAdmin'
  action recomputeHomepageVideoRotation() returns {
    inserted   : Integer;
    poolSize   : Integer;
    durationMs : Integer;
  };
}
