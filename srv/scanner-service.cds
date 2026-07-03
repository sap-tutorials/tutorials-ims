using { com.sap.developers.ims as ims } from '../db/schema';

@path: '/scanner'
@requires: 'MobileApp'
service ScannerService {

  function getContestant(accountNumber : String) returns {
    tutorialsCompleted : Integer;
    groupsCompleted    : Integer;
    missionsCompleted  : Integer;
    prizeRecords       : String;
  };

  // #889: accountNumber is required so the server can verify that
  // PrizeRecords.user_ID matches the contestant the operator just scanned.
  // Without it any MobileApp-scope caller could claim any prize by legacyId.
  function claimPrize(recordId : String, accountNumber : String) returns String;
}
