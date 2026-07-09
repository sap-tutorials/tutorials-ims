using from './search-service';

// Phase 2 (#1105) — anonymous get_tutorial_step on SearchService.
// Published tutorial HTML is public content — no authentication required.
// Reuses the DeveloperService handler symbol (handleGetTutorialStep) so the
// fetch + slice logic lives in exactly one place.
extend service SearchService {

  /** Return a single step's HTML plus metadata. No authentication required —
      published tutorial content is public. Shares the DeveloperService
      handler; the return shape is identical.
      @param slug        Lowercase canonical tutorial slug.
      @param stepNumber  1-indexed step number. */
  @(requires: 'any')
  function get_tutorial_step(slug: String, stepNumber: Integer) returns {
    slug        : String;
    stepNumber  : Integer;
    stepTitle   : String;
    html        : String;
    textLength  : Integer;
    totalSteps  : Integer;
  };
}
