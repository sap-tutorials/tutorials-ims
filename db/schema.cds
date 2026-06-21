namespace com.sap.developers.ims;

using { managed, cuid } from '@sap/cds/common';
using { com.sap.developers.ims.shared } from './_content-shape';
using from './advocates';

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

@assert.unique.slug: [slug]
entity Tutorials : TaskBase {
  slug                      : String(255) @mandatory;
  mdFileUrl                 : String(1000);
  featuredOrder             : Integer;
  // Authoritative step count from the parsed tutorial frontmatter, set by
  // publish-content. Used as the denominator in completion-progress math so
  // that step-progress doesn't depend on whichever Step rows happen to exist
  // in the DB at the moment a user clicks "mark complete" (issue #89).
  stepCount                 : Integer;
  redirectTo                : Association to Tutorials;
  steps                     : Composition of many Steps on steps.tutorial = $self;
  tags                      : Association to many TutorialTags on tags.tutorial = $self;
  meta                      : Composition of many TutorialMeta on meta.tutorial = $self;
  contributors              : Composition of many TutorialContributors on contributors.tutorial = $self;
  repositories              : Composition of many TutorialRepositories on repositories.tutorial = $self;
  categories                : Composition of many TutorialCategories on categories.tutorial = $self;
}

@assert.unique.slug: [slug]
entity Missions : TaskBase {
  slug                      : String(255);
  communityMissionId        : String(255);
  missionType               : MissionType @assert.range;
  // Default false: new and migrated missions are NOT visible until a SuperAdmin
  // toggles published to true. Replaces AEM's role of curating which missions
  // surface on the website. Write-guard at admin-service.js:788. Issue #348.
  published                 : Boolean default false;
  primaryTagRef             : Association to Tags;
  group                     : Association to Groups;
  event                     : Association to Events;
  completionPaths           : Composition of many CompletionPaths on completionPaths.mission = $self;
  tags                      : Composition of many MissionTags on tags.mission = $self;
  categories                : Composition of many MissionCategories on categories.mission = $self;
}

@assert.unique.slug: [slug]
entity Groups : TaskBase {
  slug                      : String(255);
  // Default false: see Missions.published comment above. Same SuperAdmin
  // write-guard at admin-service.js:788. Issue #348.
  published                 : Boolean default false;
  primaryTagRef             : Association to Tags;
  missions                  : Association to many Missions on missions.group = $self;
  tags                      : Composition of many GroupTags on tags.group = $self;
  items                     : Composition of many GroupPathItems on items.group = $self;
  categories                : Composition of many GroupCategories on categories.group = $self;
}

// Historic slugs preserved when an admin renames a Group/Mission. Used by the
// content-store fallback to emit a 301 to the entity's current slug, so old
// URLs and bookmarks survive renames. Append-only; on slug-reuse the row for
// the reclaimed slug is dropped (whoever owns the slug now wins).
//
// Stored as standalone entities with plain Associations (NOT Compositions),
// because draft-activation rebuilds composition children from the draft side,
// which would wipe rows written by a `before('UPDATE')` hook on the parent.
// See #91 follow-up.
entity GroupSlugRedirects : cuid, managed {
  group                     : Association to Groups;
  slug                      : String(255) @mandatory;
}

entity MissionSlugRedirects : cuid, managed {
  mission                   : Association to Missions;
  slug                      : String(255) @mandatory;
}

@assert.unique.tutorialStep : [tutorial, stepOrder]
entity Steps : TaskBase {
  tutorial                  : Association to Tutorials;
  stepOrder                 : Integer;
  contentHash               : String(64);
}

entity Checkpoints : TaskBase { }

@assert.unique.sapId : [sapId]
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

// Issue #172 PR 6 — Pilot enablement.
// Typed user profile for branching-condition evaluation. Replaces the master
// spec's "three String columns on UserMetaData" direction (PR 1 reviewer
// mandated a separate entity to avoid overloading the key/value store).
//
// `key user : Association to Users` — one row per user; HANA table PK is
// USER_ID only (no ID column). Canonical lookup:
//   SELECT.one.from(UserLearningPreferences).where({ user_ID: dbUser.ID })
//
// `@assert.range` is kept as model-level documentation / future-proofing if the
// entity is ever exposed for direct OData write. CAP's @assert.range fires only
// at the OData protocol layer, NOT on programmatic CQL writes from action
// handlers — the action handler's enum-validation loop is the actual runtime
// gate (see srv/developer-service.js setLearningPreferences).
//
// Spec: docs/superpowers/specs/2026-06-12-172-pr6-pilot-enablement-design.md §4.1
entity UserLearningPreferences : managed {
  key user       : Association to Users;
  deployment     : String(20) @assert.range enum { cloud; onprem; };
  role           : String(20) @assert.range enum { developer; architect; sysadmin; student; };
  cloud          : String(20) @assert.range enum { btp; aws; gcp; };
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
  label                     : String(255);
  titlePath                 : String(255);
  virtual mdFormat           : String;
}

// Master taxonomy for the /browse/ Categories facet (#201). Seeded once
// via db/data/com.sap.developers.ims-Categories.csv; v1 admins edit only
// label/sortOrder/seedDescription. Add/remove categories is a v2 follow-up.
entity Categories : cuid, managed {
  slug             : String(64) @mandatory;
  label            : String(255) @mandatory;
  sortOrder        : Integer default 100;
  seedDescription  : LargeString;  // editable; tunes classifier accuracy
}

entity MissionCategories : cuid {
  mission   : Association to Missions;
  category  : Association to Categories;
  score     : Decimal(5, 4) default 1.0;  // cosine score; manual writes = 1.0
}

entity GroupCategories : cuid {
  group     : Association to Groups;
  category  : Association to Categories;
  score     : Decimal(5, 4) default 1.0;
}

entity TutorialCategories : cuid {
  tutorial  : Association to Tutorials;
  category  : Association to Categories;
  score     : Decimal(5, 4) default 1.0;
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

@assert.unique.slug : [slug]
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
  // Issue #172 — branching paths. Items in the same path with the same
  // (altGroupKey, itemOrder) form one alt-group; null on linear backbone items.
  altGroupKey               : String(40);
  altGroupLabel             : String(120);
  altCondition              : String(500);
}

entity GroupPathItems : cuid, LegacyKeyed {
  group                     : Association to Groups;
  tutorial                  : Association to Tutorials @mandatory;
  itemOrder                 : Integer;
  // Issue #172 — branching paths inside a Group's tutorial list.
  altGroupKey               : String(40);
  altGroupLabel             : String(120);
  altCondition              : String(500);
}

@assert.unique.tutorial : [tutorial]
entity TutorialMeta : cuid, managed, LegacyKeyed {
  tutorial                  : Association to Tutorials;
  reviewedDate              : Timestamp;
  owner                     : String(255);
  ownerEmail                : String(255);
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

entity ContentFiles : shared.ContentFilesAspect {}

entity ContentManifest : shared.ContentManifestAspect {}

// Plain-text projection of published Hugo HTML, indexed for full-text search.
// Replaced (not versioned) on every publish so search reflects current content.
@cds.autoexpose: false
entity TutorialBodyText : shared.TutorialBodyTextAspect {}

// Issue #172 PR 3 — branch/skip spec sidecar; see db/_content-shape.cds.
@cds.autoexpose: false
entity BranchSpecs : shared.BranchSpecsAspect {}

@cds.autoexpose: false
entity RepoCatalog : shared.RepoCatalogAspect {}

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
  virtual cfLogsUrl : String @Core.Computed;
  items           : Composition of many PipelineLogItems on items.pipelineLog = $self;
  jobItems        : Composition of many JobLogItems     on jobItems.jobLog   = $self;
}

// Per-slug failures captured during a pipeline run. Lets admins drill from a
// PipelineLog row into the specific tutorials that had issues.
entity PipelineLogItems : cuid {
  pipelineLog : Association to PipelineLog;
  slug        : String(255);
  phase       : String(20) enum { CONTENT; METADATA; BODYTEXT; EMBEDDINGS; };
  severity    : String(10) enum { ERROR; WARN; };
  message     : String(2000);
  severityCriticality : Integer @Core.Computed;
}

// Per-record output captured during a scheduled-job run. Lets admins drill from
// a JobExecutionLog row into the individual records the job processed
// (accounts merged, embeddings updated, notifications sent, ...).
entity JobLogItems : cuid {
  jobLog    : Association to PipelineLog;
  itemKey   : String(255);
  itemKind  : String(30) enum {
    ACCOUNT_MERGE; TUTORIAL_EMBEDDING; NOTIFICATION; NGDS_RETRY; CONTENT_VERSION; OTHER;
  };
  status    : String(10) enum { SUCCESS; SKIPPED; WARN; ERROR; };
  message   : String(2000);
  statusCriticality : Integer @Core.Computed;
}

entity ChatSettings : cuid, managed {
  enabled              : Boolean default false;
  deploymentId         : String(100);
  modelName            : String(100);
  temperature          : Decimal(3, 2);
  maxTokens            : Integer;
  maxRequestsPerUser   : Integer default 100;
  bannerText           : String(500);

  // RAG / vector grounding (see docs/developers/architecture/joule.md "Tutorial Grounding")
  ragEnabled           : Boolean default false;
  embeddingModel       : String(100) default 'text-embedding-3-small';
  embeddingTopK        : Integer default 5;
  embeddingMinScore    : Decimal(4, 3) default 0.25;

  // AI code-check spike (issue #171). When false, /api/codecheck → 503
  // and the checkCode tool is omitted from toolsForContext().
  codeCheckEnabled     : Boolean default false;

  // AI free-text grader (issue #209). When false, /api/validate-answer → 503
  // and the dispatch short-circuits without calling the LLM.
  validateAnswerEnabled : Boolean default false;

  // Branching paths runtime master flag (issue #172). When false:
  //   - /api/branches/decide → 404
  //   - /build/mission/<slug> omits `recommendation`
  //   - getBranchRecommendation chat tool not registered
  //   - Renderers degrade to "show all branches, no recommendation"
  branchingEnabled     : Boolean default false;
}

// Phase 2-A foundation (#463). Mirrors the ChatSettings singleton pattern.
// Resolver at srv/lib/runtime-config/kg-settings.js layers DB > env > default.
// CSV seed at db/data/...-KnowledgeGraphSettings.csv MUST stay empty so HDI
// redeploy doesn't clobber operator-set values (see feedback_cap_csv_seeds_clobber_admin_data).
//
// All 4 columns are nullable on purpose. Null means "fall through to env"
// in the resolver. With a fresh deploy + no row + KNOWLEDGE_GRAPH_ENABLED=true
// in mtaext, behavior is identical to today. After an admin saves the row,
// DB values win.
entity KnowledgeGraphSettings : cuid, managed {
  enabled                    : Boolean;
  extractBuildCap            : Integer       @assert.range: [0, 100000];
  mergeSimThreshold          : Decimal(3, 2) @assert.range: [0.01, 1.00];
  mergeSimThresholdExtract   : Decimal(3, 2) @assert.range: [0.01, 1.00];
}

entity TutorialEmbedding {
  key tutorial_ID  : UUID;
  key stepNumber   : Integer;
  contentHash      : String(64);
  embeddingModel   : String(100);
  embedding        : Vector(1536);
  stepText         : LargeString;
  charCount        : Integer;
  createdAt        : Timestamp @cds.on.insert: $now;
}

entity TutorialFeedback : managed {
  key ID            : UUID;
  tutorialSlug      : String(200) @mandatory;
  submittedAt       : Timestamp default $now;
  wasAuthenticated  : Boolean default false;
  submitterIpHash   : String(64);
  ratingUseCase     : Integer @assert.range: [0, 10];
  ratingRelevance   : Integer @assert.range: [0, 10];
  ratingDuration    : Integer @assert.range: [0, 10];
  ratingStructure   : Integer @assert.range: [0, 10];
  ratingInteresting : Integer @assert.range: [0, 10];
  ratingVisuals     : Integer @assert.range: [0, 10];
  npsScore          : Integer @assert.range: [0, 10];
  comment           : String(2000);
}

// Author-supplied code-check material per (tutorial, step). Server-only:
// the referenceSolution column NEVER reaches the client. Populated by
// the publish-content pipeline; read by srv/lib/code-check-tool.js.
entity CodeCheckSpecs : managed {
  key tutorial         : Association to Tutorials;
  key stepNumber       : Integer;
  goal                 : LargeString @mandatory;
  language             : String(40);
  hints                : LargeString;        // JSON-encoded string[]
  referenceSolution    : LargeString;        // server-only
  hasReference         : Boolean default false;
}

// Every learner submission. Drives offline grader-quality evaluation.
// 'verdict' allows 'error' as a server-side outcome value (the LLM JSON
// schema only emits 'pass' | 'partial' | 'fail').
@analytics.exposed: true
entity CodeCheckSubmissions : managed {
  key ID               : UUID;
  user                 : Association to Users;
  tutorialSlug         : String(200) @mandatory;
  stepNumber           : Integer @mandatory;
  submittedCode        : LargeString @mandatory;
  language             : String(40);
  verdict              : String(10);
  summary              : LargeString;
  suggestions          : LargeString;        // JSON-encoded string[]
  correctAspects       : LargeString;        // JSON-encoded string[]
  modelName            : String(80);
  promptTokens         : Integer;
  completionTokens     : Integer;
  latencyMs            : Integer;
  errorReason          : String(200);
}

// Author-supplied free-text-grader specs per (tutorial, step, questionId).
// Populated by the publish-content pipeline; read by srv/lib/validate-answer-tool.js.
// Server-only — `correctAnswer` lives ONLY here for AI-graded questions.
// The parser (Task 2) strips correctAnswer from the public Hugo frontmatter
// when aiGrading: true, so the LLM grader's reference answer never enters
// the <script id="tutorial-data"> JSON shipped to clients.
entity ValidateAnswerSpecs : managed {
  key tutorial      : Association to Tutorials;
  key stepNumber    : Integer;
  key questionId    : String(40);
  questionText      : LargeString @mandatory;
  correctAnswer     : LargeString @mandatory;
  ruleType          : String(40);          // e.g. 'exact-match', 'regex', 'regex-begins-with'
  aiGrading         : Boolean default false;
}

// Every learner submission. Drives offline grader-quality evaluation.
// 'verdict' allows 'error' as a server-side outcome value (the LLM JSON
// schema only emits 'pass' | 'partial' | 'fail').
@analytics.exposed: true
entity ValidateAnswerSubmissions : managed {
  key ID            : UUID;
  user              : Association to Users;
  tutorialSlug      : String(200) @mandatory;
  stepNumber        : Integer @mandatory;
  questionId        : String(40) @mandatory;
  questionText      : LargeString;         // captured for offline eval
  correctAnswer     : LargeString;         // captured for offline eval
  submittedAnswer   : LargeString @mandatory;
  verdict           : String(10);          // 'pass'|'partial'|'fail'|'error'
  summary           : LargeString;
  hint              : LargeString;         // null on pass/fail; populated on partial
  modelName         : String(80);
  promptVersion     : String(10);
  promptTokens      : Integer;
  completionTokens  : Integer;
  latencyMs         : Integer;
  errorReason       : String(200);
}

// Issue #173 — author-side AI assist requests (initially OS-variant generation
// for the VS Code authoring plugin, but the `feature` column makes it forward-
// compatible for future authoring-AI flows). v1 persists sourceMarkdown and
// variants verbatim — no PII concern since this is author-supplied content,
// not end-user input. Future eval harnesses consume these rows directly.
@analytics.exposed: true
entity AuthorAiRequests : managed {
  key ID            : UUID;
  authorId          : String(80);          // XSUAA user ID, plain (SAP-employee authors only)
  feature           : String(40) @mandatory;  // 'os-variants' (initial); future flows extend this
  sourceOS          : String(20);
  targetOSes        : String(80);          // comma-joined list, e.g. 'macOS,Linux'
  sourceMarkdown    : LargeString;
  variants          : LargeString;         // JSON-stringified array of {os, markdown}
  sourceLength      : Integer;
  variantsLength    : Integer;
  model             : String(80);
  tokensUsed        : Integer;
  durationMs        : Integer;
  errorCode         : String(200);         // null on success
}

/**
 * UIEvent — anonymous client-side telemetry for the / vs /browse/ A/B test (#204).
 *
 * Deliberately NOT @PersonalData: sessionId is per-tab anonymous (browser-generated
 * UUID v4 in sessionStorage, cleared on tab close). userAgent is truncated. No
 * userId, IP, or fingerprint. Stays outside the anonymization cascade. See
 * docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md.
 */
entity UIEvent {
  key ID            : UUID;
      sessionId     : String(36) @mandatory;           // browser-generated UUID v4
      surface       : String(32) @mandatory;           // '/', '/browse/', '/tutorials/'
      eventType     : String(32) @mandatory;           // page_view | filter_change | card_click | pagination_change | rail_show_all_click | scroll_depth | page_leave | referred_view
      timestamp     : Timestamp @mandatory;            // browser-side (ms precision)
      receivedAt    : Timestamp default $now;          // server-side
      payload       : LargeString;                     // JSON-serialized type-specific fields
      userAgent     : String(512);                     // truncated to first 512 chars
      buildAt       : String(32);                      // hugo build hash for diff-attribution
}

// ── Issue #172: branching paths telemetry ───────────────────────────────────

type BranchSurface : String(20) enum {
  missionAltGroup;
  tutorialBranch;
  tutorialSkip;
}

type BranchReasonKind : String(20) enum {
  condition;
  ranker;
  default;
}

type BranchSource : String(20) enum {
  pageLoad;
  click;
  jouleTool;
}

@analytics.exposed
entity BranchDecisions : managed {
  key ID                 : UUID;
  user                   : Association to Users;        // null for anonymous
  surface                : BranchSurface;
  missionSlug            : String(255);
  tutorialSlug           : String(255);
  branchPointId          : String(120);
  recommendedKey         : String(40);
  chosenKey              : String(40);                  // null = recommendation log only
  recommendationKind     : BranchReasonKind;
  confidence             : Decimal(5, 4);               // 0..1
  source                 : BranchSource;
  followedRecommendation : Boolean;
}


// Phase 2-B (#464): Secrets-visibility metadata-only inventory.
// Tracks WHAT credentials exist, WHEN they expire, WHO owns rotation.
// Does NOT store secret values — those stay in CF env / mtaext / GH Actions
// secrets. Phase 2-C (#465) will add encryptedValue + encryptionKeyId
// columns once the encryption-key management decision is made.
//
// Daily cron (srv/jobs/secret-expiry-check.js, 04:11 UTC) computes
// days-remaining and surfaces warnings via /admin/secretWarnings() ↦
// admin-shell notifications popover.
//
// CSV seed at db/data/...-Secrets.csv MUST stay empty per the
// HDI-clobbers-admin-edits footgun ([feedback_cap_csv_seeds_clobber_admin_data]).
// Initial seeding is a one-shot script: scripts/seed-secrets.cjs.
//
// Note: @assert.unique uses the field-level form here because the
// entity-level array form `[![key]]` is ambiguous to the CDS parser
// (the closing `]` of `![key]` collides with the array's closing `]`).
// Field-level uniqueness gives the same constraint.
entity Secrets : cuid, managed {
  ![key]              : String(120) @assert.unique;
  description         : String(500);
  kind                : String(40);
  rotationOwner       : String(120);
  rotationDocsUrl     : String(500);
  expiresAt           : Date;
  lastRotatedAt       : Timestamp;
}


// Phase 3 (#466): UI events telemetry feature flag.
// Resolver at srv/lib/runtime-config/ui-events-settings.js layers DB > env > default.
// CSV seed must stay empty (HDI-clobbers-admin-edits footgun).
entity UiEventsSettings : cuid, managed {
  enabled              : Boolean;
}


// Phase 3 (#466): Search /search/* per-IP rate limit.
// rateLimitMax = requests-per-window; rateLimitWindowMs = rolling window in ms.
// Range upper bound on windowMs at 600000 (10min) prevents an admin from
// configuring a 1-hour rate-limit cell that would persist rejection state
// across deploys.
entity SearchSettings : cuid, managed {
  rateLimitMax         : Integer @assert.range: [0, 100000];
  rateLimitWindowMs    : Integer @assert.range: [1000, 600000];
}


// Phase 3 (#466): Navigator nested-group inclusion flag.
// When true, /build/navigator emits cards for nested groups (richer behavior,
// ~65 extra cards on dev). False matches developers.sap.com chip-counts.
// See issue #364.
entity NavigatorSettings : cuid, managed {
  includeNestedGroups  : Boolean;
}


// Phase 3 (#466): Display dashboard URL used in contributor-notification emails.
// Default fallback (when null) is the prod approuter URL.
entity DisplaySettings : cuid, managed {
  dashboardUrl         : String(500);
}


// Phase 3 (#466): Tenant-wide config bag.
// allowedCorsOrigins: comma-separated origin URLs (raw env-var format).
// rebuildTargetEnv: dev/qa/prod controlling rebuild-trigger workflow_dispatch
//   target. NOT @assert.range enum-constrained at the DB level — only the
//   admin-tile ComboBox enforces the value set. Direct OData PATCH (e.g. via
//   curl by an Admin) bypasses validation. Deliberate: matches the
//   no-write-time-validation stance for the other special-shape Tenant fields.
//   Add @assert.range enum if this becomes painful (Phase 4).
// techUsers: legacy JSON-array format (raw env-var format).
// techUsersMapping: 'tech_id1:real_uuid1;tech_id2:real_uuid2' (raw env-var format).
//
// LargeString chosen for the 3 special-shape fields (CORS, techUsers,
// techUsersMapping) to avoid silent truncation if these grow beyond 2000
// chars in a multi-tenant rollout.
//
// Special-shape fields stored as raw String/LargeString — consumers keep their
// existing parse logic. No write-time validation in this PR (matches today's
// env-var typo failure mode); add @assert.format if validation becomes painful.
entity TenantSettings : cuid, managed {
  allowedCorsOrigins   : LargeString;
  rebuildTargetEnv     : String(10);
  techUsers            : LargeString;
  techUsersMapping     : LargeString;
}
