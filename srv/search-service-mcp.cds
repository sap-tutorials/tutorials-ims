using from './search-service';

// Phase 2 (#1105) — anonymous get_tutorial_step on SearchService.
// Published tutorial HTML is public content — no authentication required.
// Reuses the DeveloperService handler symbol (handleGetTutorialStep) so the
// fetch + slice logic lives in exactly one place.
extend service SearchService {

  /** Return a single published tutorial step in the requested `format`. No
      authentication required — published tutorial content is public. Shares
      the DeveloperService handler; the return shape is identical. Exactly one
      body is returned in `content`; `contentFormat` echoes which representation
      it is.
      @param slug        Lowercase canonical tutorial slug.
      @param stepNumber  1-indexed step number.
      @param format      'markdown' (default, token-efficient source markdown
                         matching /tutorials/<slug>.md) or 'html' (sliced HTML). */
  @(requires: 'any')
  function get_tutorial_step(slug: String, stepNumber: Integer, format: String) returns {
    slug          : String;
    stepNumber    : Integer;
    stepTitle     : String;
    content       : String;
    contentFormat : String;
    textLength    : Integer;
    totalSteps    : Integer;
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

  /** Search the public external-channels catalog — SAP and community YouTube
      channels, blogs, podcasts, and feeds. Anonymous: the same published
      channels shown on the /channels directory, fully searchable and
      filterable. Only published channels with a working link are returned,
      ordered by category then name.
      @param query      Free-text match on channel name, purpose, and tags (case-insensitive).
      @param category   Optional exact-match filter on the channel category.
      @param platform   Optional exact-match filter on the channel platform (e.g. 'YouTube', 'Blog', 'Podcast').
      @param ownerScope Optional owner filter: 'sap' | 'community' | 'all' (default 'all').
      @param limit      Max results, [1, 50]. Default 20. */
  @(requires: 'any')
  function search_channels(
    query      : String,
    category   : String,
    platform   : String,
    ownerScope : String,
    limit      : Integer
  ) returns array of {
    name        : String;
    url         : String;
    purpose     : String;
    category    : String;
    subcategory : String;
    platform    : String;
    isSapOwned  : Boolean;
    ownerType   : String;
    ownerName   : String;
    status      : String;
    focusAreas  : array of String;
    tags        : array of String;
    slug        : String;
  };

  /** Public semantic/vector search over the SAP developer content corpus.
      Anonymous: the caller sends TEXT ONLY — the server embeds the query
      server-side and returns scored content references. It NEVER returns raw
      embedding vectors and NEVER accepts a caller-supplied vector. Off (503)
      unless ChatSettings.semanticSearchEnabled is set. Fails open ([]) on any
      retrieval error so a backfill gap never surfaces as an error to an agent.
      @param query    Free-text query. Empty → []. The server embeds this.
      @param corpus   'tutorials' (default) | 'concepts' | 'external' | 'teched' | 'all'.
      @param topK     Max results, clamped [1, 50]. Default ChatSettings.embeddingTopK (5).
      @param minScore Cosine floor; rows below are dropped. Default ChatSettings.embeddingMinScore (0.25). */
  @(requires: 'any')
  function semantic_search(
    query    : String,
    corpus   : String,
    topK     : Integer,
    minScore : Decimal
  ) returns array of {
    slug        : String;
    title       : String;
    stepNumber  : Integer;
    snippet     : String;
    score       : Decimal;
    url         : String;
    contentType : String;
  };
}
