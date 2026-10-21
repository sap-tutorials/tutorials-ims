using { com.sap.developers.ims as ims } from '../db/schema';

@path: '/drawings'
@requires: 'Admin'
service DrawingService {

  function listEvents() returns many {
    legacyId  : Integer;
    name      : String;
    startDate : Timestamp;
  };
}
