using { com.sap.developers.ims as ims } from '../db/schema';

@path: '/scanner'
@requires: 'authenticated-user'
service ScannerService {

  function getContestant(accountNumber : String) returns {
    tutorialsCompleted : Integer;
    groupsCompleted    : Integer;
    missionsCompleted  : Integer;
    prizeRecords       : String;
  };

  function claimPrize(recordId : String) returns String;
}
