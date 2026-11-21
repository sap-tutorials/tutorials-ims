using { com.sap.developers.ims } from '../db/schema';
using from '../db/views';

// AuthorSageService — isolated IAS-authenticated author surface for the SAGE
// VS Code extension. Exposes ONLY the 5 operations SAGE actually uses; no
// AdminService dependency (rebuildContent / AI features excluded by design).
//
// Auth: IAS tokens carry no XSUAA scopes — `authenticated-user` is the only
// viable gate here.
//
// ACTION PATH ANALYSIS (Task 5 — src/lib/ims/imsApiClient.ts in sage-tutorial-extension):
//   Reads:
//     GET /author/MyOwnedTutorials   (line 175 — imsApiClient.getMyTutorials)
//     GET /author/Tags               (line 155 — imsApiClient.searchTags)
//   Actions (all bare/unqualified — no "AuthorSageService." prefix):
//     POST /author/isSlugAvailable   (line 159 — imsApiClient.isSlugAvailable)
//     POST /author/reviewTutorial    (line 188 — imsApiClient.reviewTutorial)
//     POST /author/snoozeTutorial    (line 195 — imsApiClient.snoozeTutorial)
//
// WHY no @path alias on the actions:
//   CAP OData4 accepts BOTH the qualified form (AuthorSageService.isSlugAvailable)
//   AND the bare/unqualified form (isSlugAvailable) for unbound action imports.
//   The smoke test at test/smoke/author-service.test.js line 62 confirms this
//   pattern on the production AuthorService (POST /author/generateOsVariants, bare).
//   In srv-sage's isolated CF deployment only AuthorSageService is served at
//   /author/, so the bare paths are unambiguous. No @path alias needed.
//
// (#task-3 — srv-sage author service model; task-5 — action path confirmed)

@path: '/author'
@requires: 'authenticated-user'
service AuthorSageService {

  // MyOwnedTutorials — Sage's "My Tutorials" panel.
  // Priority filter: 1 (strict author FK), 3 (ownerEmail), 4 (owner name).
  // Excludes priority 2 (pure contributor). See ADR 0006 §2026-08-19.
  @Capabilities.ChangeTracking : { Supported: true }
  @readonly entity MyOwnedTutorials as
    projection on ims.MyTutorialsView { *, tutorial_ID as ID } where bestPriority in (1, 3, 4);

  // Tags — read-only tag catalogue for the tutorial editor.
  // Note: SUBSTR_AFTER(name, '>') actualTag is HANA-only; omitted here because
  // srv-sage runs against the same HANA container and may surface it via raw
  // column. Task 4 handler can re-add if needed.
  @Capabilities.ChangeTracking : { Supported: true }
  @readonly entity Tags as projection on ims.Tags;

  // isSlugAvailable — UX hint (not a lock) before creating a new tutorial.
  // Returns false if a matching slug already exists (case-insensitive).
  action isSlugAvailable(slug : String) returns Boolean;

  // reviewTutorial — marks tutorial as reviewed; returns review timestamp
  // and running notification count.
  action reviewTutorial(tutorialId : UUID) returns {
    reviewedDate       : Timestamp;
    notificationNumber : Integer;
  };

  // snoozeTutorial — snoozes review notifications; returns next notification
  // date and running notification count.
  action snoozeTutorial(tutorialId : UUID, days : Integer) returns {
    notificationDate   : Timestamp;
    notificationNumber : Integer;
  };
}
