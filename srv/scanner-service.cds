using { com.sap.developers.ims as ims } from '../db/schema';

@path: '/scanner'
@requires: 'MobileApp'
service ScannerService {

  function getContestant(accountNumber : String, eventId : Integer) returns {
    lastName           : String;
    firstInitial       : String;
    tutorialsCompleted : Integer;
    groupsCompleted    : Integer;
    missionsCompleted  : Integer;
    claimedCount       : Integer;
    claimedPrizeNames  : array of String;
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

  // #badge-v2: per-event aggregate for the badge scanner's event-stats panel.
  // Scoped on TaskRecords.event_ID (badge/app-space path). Unresolvable eventId
  // returns a zeroed shape (eventName null), never rejects.
  function getEventStats(eventId : Integer) returns {
    eventName              : String;
    prizesClaimed          : Integer;
    prizesAvailable        : Integer;
    earnedAwaitingHandover : Integer;
    participants           : Integer;
    participantsClaimed    : Integer;
    tutorialsCompleted     : Integer;
    groupsCompleted        : Integer;
    missionsCompleted      : Integer;
  };
}
