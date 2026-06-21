using { com.sap.developers.ims as ims } from '../db/schema';
using from '../db/views';

@path: '/author'
@requires: 'Tutorial.Author'
service AuthorService {

  @Capabilities.ChangeTracking : { Supported: true }
  @readonly entity Tutorials as projection on ims.Tutorials {
    ID, slug, title, primaryTag, status
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

  @Capabilities.ChangeTracking : { Supported: true }
  @readonly entity MyTutorials as projection on ims.MyTutorialsView;

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
