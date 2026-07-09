using { com.sap.developers.ims as ims } from '../db/schema';
using from './developer-service';

// Phase 2 (#1105) — authenticated MCP curated tools. Doc-comments become MCP
// tool descriptions; every function is @requires:'authenticated-user' so CAP
// enforces before the @cap-js/mcp adapter dispatches (works identically for
// JWT and PAT auth because req.user is populated identically upstream).
extend service DeveloperService {

  /** List the signed-in user's tutorials. Filter by status: 'in_progress',
      'completed', or 'all' (default). Limit clamped to 50.
      @param status  One of 'in_progress' | 'completed' | 'all'.
      @param limit   Max results, [1, 50]. Default 20. */
  @(requires: 'authenticated-user')
  function get_my_tutorials(status: String, limit: Integer) returns array of {
    slug           : String;
    title          : String;
    status         : String;
    completedSteps : array of Integer;
    totalSteps     : Integer;
    lastActivityAt : Timestamp;
    attemptNumber  : Integer;
  };

  /** List the signed-in user's missions with progress rollup. Filter by
      status: 'in_progress', 'completed', 'not_started', 'all' (default).
      @param status  One of 'in_progress' | 'completed' | 'not_started' | 'all'.
      @param limit   Max results, [1, 50]. Default 10. */
  @(requires: 'authenticated-user')
  function get_my_missions(status: String, limit: Integer) returns array of {
    slug             : String;
    title            : String;
    status           : String;
    completedCount   : Integer;
    totalCount       : Integer;
    nextTutorialSlug : String;
  };

  /** List the signed-in user's events. 'upcoming' shows future events,
      'past' shows completed events, 'registered' shows events the user is
      registered for.
      @param when   One of 'upcoming' | 'past' | 'registered'.
      @param limit  Max results, [1, 50]. Default 20. */
  @(requires: 'authenticated-user')
  function get_my_events(when: String, limit: Integer) returns array of {
    slug       : String;
    name       : String;
    eventType  : String;
    startDate  : Timestamp;
    endDate    : Timestamp;
    registered : Boolean;
  };

  /** Return the set of step numbers the signed-in user has completed on the
      given tutorial, plus attempt number and last activity timestamp.
      Empty array + attemptNumber=1 for tutorials the user has never started.
      @param slug  Lowercase canonical tutorial slug. */
  @(requires: 'authenticated-user')
  function get_my_completed_steps(slug: String) returns {
    slug           : String;
    completedSteps : array of Integer;
    attemptNumber  : Integer;
    lastActivityAt : Timestamp;
  };

  /** Return a single step's HTML plus metadata. Enables LLMs to fetch the
      exact step the user is asking about instead of the whole tutorial body.
      @param slug        Lowercase canonical tutorial slug.
      @param stepNumber  1-indexed step number. */
  @(requires: 'authenticated-user')
  function get_tutorial_step(slug: String, stepNumber: Integer) returns {
    slug        : String;
    stepNumber  : Integer;
    stepTitle   : String;
    html        : String;
    textLength  : Integer;
    totalSteps  : Integer;
  };

  /** Mark a step of a tutorial as completed for the signed-in user.
      Idempotent: re-completing an already-completed step is a no-op.
      PAT callers must carry write scope; JWT/OAuth (browser) callers are
      always allowed.
      @param slug        Lowercase canonical tutorial slug.
      @param stepNumber  1-indexed step number. */
  @(requires: 'authenticated-user')
  action complete_step(slug: String, stepNumber: Integer) returns {
    completedSteps : array of Integer;
    points         : Integer;
  };

  /** Reset the signed-in user's progress on a tutorial. Supersedes the
      current attempt and starts a fresh one; emits a TutorialProgressReset
      audit event with the old attempt's metadata and a nullable tokenSource
      field ('pat' | null) so admins can distinguish MCP-driven from
      browser-driven resets.
      PAT callers must carry write scope; JWT/OAuth (browser) callers are
      always allowed.
      @param slug  Lowercase canonical tutorial slug. */
  @(requires: 'authenticated-user')
  action reset_tutorial_progress(slug: String) returns {
    newAttemptNumber           : Integer;
    previousAttemptCompletedAt : DateTime;
    supersededRecordCount      : Integer;
  };
}
