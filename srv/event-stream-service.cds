@protocol: ['websocket', 'rest']
@requires: 'any'
@path: 'event-stream'
service EventStreamService {
  event tutorialCompleted {
    bucketName    : String;
    completeDate  : String;
    tutorialTitle : String;
  }

  // Returns the event's display metadata alongside the completion buckets so the
  // event-display page can render the real event name + logo instead of a
  // theme-hardcoded label (#2133). `hasLogo` gates the anonymous
  // GET /api/event-logo?eventLegacyId=N fetch on the client.
  function getEventBuckets(eventLegacyId : Integer) returns {
    eventName   : String;
    eventType   : String;
    hasLogo     : Boolean;
    buckets     : many {
      bucketName  : String;
      count       : Integer;
      percentage  : Decimal;
    };
  };
}
