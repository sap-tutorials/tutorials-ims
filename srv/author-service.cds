using { com.sap.developers.ims as ims } from '../db/schema';
using from '../db/views';
using { AdminService } from './admin-service';

@path: '/author'
@requires: 'Tutorial.Author'
service AuthorService {

  @Capabilities.ChangeTracking : { Supported: true }
  @readonly entity Tutorials as projection on ims.Tutorials {
    *,
    cast(legacyId as String) as legacyIdStr : String
  };

  @readonly entity TutorialFeedback          as projection on ims.TutorialFeedback;
  @readonly entity TutorialFeedbackAggregate as projection on ims.TutorialFeedbackAggregate;

  @readonly entity TutorialChanges as projection on ims.AuthorTutorialChanges;

  // Curated analytics surface for the author Analytics tile (#617). Mirrors
  // the corresponding AnalyticsService projections (srv/analytics-service.cds)
  // minus the SQL ad-hoc playground (runSelectQuery is admin-only). The
  // duplication is the unavoidable consequence of CAP's service-scoped
  // @requires — same underlying ims.* views, two projections.
  @readonly entity Tasks                  as projection on ims.Tasks;
  @readonly entity CompletionAnalytics    as projection on ims.CompletionAnalytics;
  @readonly entity ActiveLearnersDaily    as projection on ims.ActiveLearnersDaily;
  @readonly entity TaskRecords            as projection on ims.TaskRecords;

  @readonly entity CodeCheckSubmissions   as projection on ims.CodeCheckSubmissions {
    ID, tutorialSlug, stepNumber, language, verdict, modelName,
    promptTokens, completionTokens, latencyMs, errorReason,
    createdAt, modifiedAt, user
  };

  @readonly entity ValidateAnswerSubmissions as projection on ims.ValidateAnswerSubmissions {
    ID, tutorialSlug, stepNumber, questionId, verdict, modelName,
    promptVersion, promptTokens, completionTokens, latencyMs,
    errorReason, createdAt, modifiedAt, user
  };

  @readonly entity UIEvents as projection on ims.UIEvent;

  function listExposedEntities() returns array of {
    name    : String;
    sqlName : String;
    label   : String;
  };

  @Capabilities.ChangeTracking : { Supported: true }
  @readonly entity Tags as projection on ims.Tags {
    *,
    // #385 PR-3: HANA-native SUBSTR_AFTER returns the substring after the LAST
    // occurrence of the delimiter — exactly matches Riley's "leaf after last '>'"
    // contract. NOT portable to SQLite. Unit tests gate actualTag assertions
    // behind cds.env.requires.db.kind === 'hana'. Hybrid test
    // (test/hybrid/385-pr3-authorservice.test.js) is the canonical verification.
    // Trade-off pattern: see feedback_hana_boolean_case_when.
    SUBSTR_AFTER(name, '>') as actualTag : String
  };

  // MyTutorials + MyAuthoredTutorials projections expose the underlying
  // view's `tutorial_ID` key column ALSO as `ID` so plain-OData clients
  // (Sage's imsApiClient reads `row.ID`) can consume the row without
  // knowing the CDS view's naming quirk. Backward-compatible: tutorial_ID
  // still appears on the response for existing consumers. See #862 reopen.
  @Capabilities.ChangeTracking : { Supported: true }
  @readonly entity MyTutorials as
    projection on ims.MyTutorialsView { *, tutorial_ID as ID };

  // #862 — MyAuthoredTutorials is the narrow surface for "tutorials I am
  // currently responsible for maintaining". It projects MyTutorialsView
  // filtered to bestPriority = 1 (strict `Tutorials.author_ID` matches only,
  // per db/views.cds MyTutorialsRaw source 1).
  //
  // Rationale for a separate entity (rather than changing MyTutorials'
  // default): #777 landed MyTutorials as a deliberately broad four-source
  // UNION so the advocate roster and admin Tutorial Health surfaces get
  // contributor + legacy-owner matches too. Narrowing that default would
  // break those consumers. Sage's My Tutorials panel wants strict authorship
  // (issue #862); MyAuthoredTutorials gives it a purpose-built endpoint that
  // GET /author/MyAuthoredTutorials returns with zero client-side filtering.
  //
  // Callers wanting *contributor* rows can still hit
  //   GET /author/MyTutorials?$filter=bestPriority ne 1
  // — the underlying view exposes bestPriority as a column.
  @Capabilities.ChangeTracking : { Supported: true }
  @readonly entity MyAuthoredTutorials as
    projection on ims.MyTutorialsView { *, tutorial_ID as ID } where bestPriority = 1;

  // #862 reopen / #923 — MyOwnedTutorials is Sage's "My Tutorials" panel.
  // Originally sourced from MyTutorialsView.bestPriority = 3 (source 3:
  // TutorialMeta.ownerEmail = Users.email). Investigation of the legacy
  // Java IMS source (TutorialMetaSpecifications.java:73-76) revealed
  // that Java's "monitoredByMe" panel — the one Sage's users see today
  // when they open the extension — filters on IMS_DASHBOARD_MONITOR_
  // RECORD, a personal watch list where each user explicitly opts in
  // to track a tutorial. Not TutorialMeta.owner (a maintainer signal).
  //
  // #923 introduced the TutorialMonitors entity (the CAP equivalent of
  // that Java table) plus MyMonitoredTutorialsView. This projection now
  // points at that view — Sage keeps its /author/MyOwnedTutorials URL
  // unchanged. Response shape unchanged (bestPriority column dropped,
  // but Sage never read it). See ADR 0006 §2026-07-02b for the shift.
  //
  // Users who haven't opted-in to monitor anything will see an empty
  // panel — this matches legacy Java behavior. To watch a tutorial,
  // call toggleMonitor below (equivalent to Java's setMonitoredStatus).
  @Capabilities.ChangeTracking : { Supported: true }
  @readonly entity MyOwnedTutorials as
    projection on ims.MyMonitoredTutorialsView { *, tutorial_ID as ID };

  // #923 — Sage's "watch this tutorial" toggle. Mirrors Java IMS's
  // POST /tutorialMeta/setMonitoredStatus?status=<bool> with body [<id>].
  //   status=true  : upsert TutorialMonitors row for (caller, tutorial)
  //   status=false : delete the row (no-op if absent)
  // Returns true when the row is present after the call.
  //
  // Idempotent: calling toggleMonitor(t, true) twice is safe (unique
  // constraint on (user, tutorial) — second call resolves to already-
  // present). Same for two false calls (second is a no-op).
  action toggleMonitor(tutorialId : UUID, status : Boolean) returns Boolean;

  action reviewTutorial(tutorialId : UUID) returns {
    reviewedDate       : Timestamp;
    notificationNumber : Integer;
  };

  action snoozeTutorial(tutorialId : UUID, days : Integer) returns {
    notificationDate     : Timestamp;   // #385 PR-3 rename (was lastNotificationDate)
    notificationNumber   : Integer;
  };

  // Issue #173 — AI-assisted OS variant generation. VS Code authoring plugin posts here.
  type OsValue : String enum { Windows; macOS; Linux; BAS };

  type OsVariantContext : {
    tutorialSlug        : String;
    stepHeading         : String;
    surroundingMarkdown : String;
  };

  type OsVariant : {
    os       : OsValue;
    markdown : LargeString;
  };

  action generateOsVariants(
    sourceMarkdown : LargeString,
    sourceOS       : OsValue,
    targetOSes     : array of OsValue,
    context        : OsVariantContext
  ) returns {
    variants    : array of OsVariant;
    model       : String;
    tokensUsed  : Integer;
    requestId   : String;
  };

  // Issue #172 PR 5 — branch analytics views (Author path).
  // Service-level `@requires: 'Tutorial.Author'` is the only gate. Authors
  // see ONLY the aggregated views — raw BranchDecisions is never projected
  // on AuthorService. Used by the branch-staleness lint rule
  // (scripts/lint-rules/branch-staleness.ts).
  //
  // Same underlying view as AnalyticsService.AnalyticsBranchPerformance
  // (see srv/analytics-service.cds). Two surfaces, one shape.
  @readonly entity AnalyticsBranchPerformance as projection on ims.AnalyticsBranchPerformance;
  @readonly entity AnalyticsBranchTopPick     as projection on ims.AnalyticsBranchTopPick;

  // #385 PR-3 — server-side case-insensitive slug uniqueness check.
  // Sage calls this before creating a new tutorial to surface name conflicts
  // before submitting the write. The check is intentionally a UX hint, not a
  // lock: a benign TOCTOU window exists between the check and a subsequent
  // insert. The write-side @assert.unique.slug constraint catches any race.
  action isSlugAvailable(slug : String) returns Boolean;
}

extend entity AuthorService.Tutorials with actions {
  @Core.OperationAvailable: true
  @Common.IsActionCritical : true
  action rebuildContent() returns AdminService.RebuildContentResult;
};
