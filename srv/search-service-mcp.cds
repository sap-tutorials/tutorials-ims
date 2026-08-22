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

  /** Search the public SAP community events catalog — CodeJams, Devtoberfest,
      TechEd, and user-group events. Anonymous: the same events shown on the
      homepage events band, but fully searchable and filterable. Returns events
      ordered by start date (soonest first).
      @param query        Free-text match on event title and description (case-insensitive).
      @param eventType    Optional filter: 'codejam' | 'teched' | 'devtoberfest' | 'usergroup'.
      @param region       Optional region: 'AMERICAS' | 'EMEA' | 'APJ' | 'VIRTUAL' | 'ALL' (default 'ALL').
      @param upcomingOnly When true (default), only events not yet ended. Set false to include past events.
      @param limit        Max results, [1, 50]. Default 20. */
  @(requires: 'any')
  function search_events(
    query        : String,
    eventType    : String,
    region       : String,
    upcomingOnly : Boolean,
    limit        : Integer
  ) returns array of {
    slug        : String;
    title       : String;
    eventType   : String;
    description : String;
    location    : String;
    region      : String;
    isVirtual   : Boolean;
    startDate   : Date;
    endDate     : Date;
    url         : String;
  };
}
