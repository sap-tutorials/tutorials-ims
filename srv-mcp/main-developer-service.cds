// srv-mcp/main-developer-service.cds
//
// Remote API spec for the main tutorials-srv DeveloperService.
// Defines ONLY the two *For actions that srv-mcp uses for its write-forward
// path. Named MainDeveloperService (not DeveloperService) to avoid the
// "Duplicate definition of DeveloperService" build error when both
// srv-mcp/developer-service.cds and this file are in the build tree.
//
// (#1105 C1 — internal service-to-service write path)

service MainDeveloperService @(path: '/api') {

  // #1105 C1 — internal write action for step completion.
  // Called by srv-mcp with a client_credentials token from tutorials-xsuaa
  // and actingSapId = the developer's JWT user_uuid (resolved from the MCP token).
  @(requires: 'InternalWrite')
  action completeStepFor(actingSapId : String, slug : String, stepNumber : Integer) returns {
    completedSteps : array of Integer;
    points         : Integer;
  };

  // #1105 C1 — internal write action for progress reset.
  @(requires: 'InternalWrite')
  action resetTutorialProgressFor(actingSapId : String, slug : String) returns {
    newAttemptNumber           : Integer;
    previousAttemptCompletedAt : DateTime;
    supersededRecordCount      : Integer;
  };
}
