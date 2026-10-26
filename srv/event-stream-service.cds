@protocol: ['websocket', 'rest']
@requires: 'any'
@path: 'event-stream'
service EventStreamService {
  event tutorialCompleted {
    bucketName    : String;
    completeDate  : String;
    tutorialTitle : String;
  }

  // Fired once per active event for EVERY tutorial completion (track or not) —
  // drives the hero "total activity" counter, independent of the per-track bars.
  event completionTick {
    tutorialTitle : String;
  }

  // Returns the event's display metadata alongside the completion buckets so the
  // event-display page can render the real event name + logo instead of a
  // theme-hardcoded label (#2133). `hasLogo` gates the anonymous
  // GET /api/event-logo?eventLegacyId=N fetch on the client.
  function getEventBuckets(eventLegacyId : Integer) returns {
    eventName        : String;
    eventType        : String;
    hasLogo          : Boolean;
    totalCompletions : Integer;   // ALL window tutorial completions (hero total), track-independent
    buckets          : many {
      bucketName  : String;
      count       : Integer;
      percentage  : Decimal;
    };
  };
}
