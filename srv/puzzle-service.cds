using { com.sap.developers.ims as ims } from '../db/schema';

// Public puzzle API. Default anonymous (@requires: 'any') like DeveloperService;
// progress/complete override to authenticated-user. The projection deliberately
// omits `solution` so no OData request can select the answer key.
@path: '/puzzle-api'
@requires: 'any'
service PuzzleService {

  @readonly
  entity Puzzles as projection on ims.Puzzles {
    ID, slug, title, description, primaryTag, experienceTag, averageTimeToComplete, layout
  };

  // Grade whole-word submissions server-side. Anonymous allowed.
  action check(slug : String, entries : many {
    slotId : String;
    word   : String;
  }) returns {
    results  : many { slotId : String; correct : Boolean; };
    cells    : many { r : Integer; c : Integer; correct : Boolean; };
    complete : Boolean;
  };

  @(requires: 'authenticated-user')
  action saveProgress(slug : String, filledGrid : LargeString) returns Boolean;

  @(requires: 'authenticated-user')
  function getProgress(slug : String) returns { filledGrid : LargeString; attemptNumber : Integer; };

  @(requires: 'authenticated-user')
  action complete(slug : String) returns { recorded : Boolean; alreadyComplete : Boolean; };

  @(requires: 'authenticated-user')
  action resetPuzzleProgress(slug : String) returns {
    newAttemptNumber           : Integer;
    previousAttemptCompletedAt : DateTime;
    supersededRecordCount      : Integer;
  };

  event PuzzleProgressReset : {
    user                       : String;   // dbUser.ID, NOT email
    puzzleSlug                 : String;
    attemptNumber              : Integer;
    supersededRecordCount      : Integer;
    previousAttemptCompletedAt : DateTime;
    tokenSource                : String;   // null | 'jwt' | 'pat'
  };
}
