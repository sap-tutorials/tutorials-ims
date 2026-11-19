using { com.sap.developers.ims } from '../db/schema';
using from '../db/views';

// AuthorSageService — isolated IAS-authenticated author surface for the SAGE
// VS Code extension. Exposes ONLY the 5 operations SAGE actually uses; no
// AdminService dependency (rebuildContent / AI features excluded by design).
//
// Auth: IAS tokens carry no XSUAA scopes — `authenticated-user` is the only
// viable gate here. Task 5 confirms the final @path against the shipped
// extension; `'/author'` mirrors the main AuthorService path provisionally.
//
// (#task-3 — srv-sage author service model)

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
