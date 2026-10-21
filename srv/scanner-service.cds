using { com.sap.developers.ims as ims } from '../db/schema';

@path: '/scanner'
@requires: 'MobileApp'
service ScannerService {

  function getContestant(accountNumber : String, eventId : Integer) returns {
    tutorialsCompleted : Integer;
    groupsCompleted    : Integer;
    missionsCompleted  : Integer;
    claimedCount       : Integer;
    prizeRecords       : String;
  };

  // #889: accountNumber is required so the server can verify that
  // PrizeRecords.user_ID matches the contestant the operator just scanned.
  // Without it any MobileApp-scope caller could claim any prize by legacyId.
  function claimPrize(recordId : String, accountNumber : String) returns String;

  // Task 6: new flow — no pre-existing PrizeRecords row required.
  // Inserts a CLAIMED row for (accountNumber UUID, eventId legacyId) iff
  // current CLAIMED count < 2 (hard cap, enforced atomically).
  // Returns the resulting claimedCount and a message.
  action claimPrizeForContestant(accountNumber : String, eventId : Integer)
    returns { claimedCount : Integer; message : String };
}
