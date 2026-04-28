using { com.sap.developers.ims as ims } from '../db/schema';

@path: '/api/v1'
@requires: 'ConsolidationScope'
service ConsolidationService {
  action userMerge(primaryUuid : String, secondaryUuid : String);
  function getMergeStatus(uuid : String) returns {
    primaryUuid   : String;
    status        : String;
    mergedAt      : Timestamp;
    secondaryCount : Integer;
  };
}
