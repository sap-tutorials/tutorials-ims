@protocol: ['websocket', 'rest']
@requires: 'any'
@path: 'event-stream'
service EventStreamService {
  event tutorialCompleted {
    bucketName    : String;
    completeDate  : String;
    tutorialTitle : String;
  }

  function getEventBuckets(eventLegacyId : Integer) returns many {
    bucketName  : String;
    count       : Integer;
    percentage  : Decimal;
  };
}
