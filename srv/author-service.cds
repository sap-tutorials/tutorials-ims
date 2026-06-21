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
  @readonly entity Tags as projection on ims.Tags;

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
}
