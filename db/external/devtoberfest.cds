namespace external.devtoberfest;

// @cds.persistence.exists proxies over cross-container synonyms to the
// Devtoberfest Planner's DTF_*_V1 views (devtoberfest-planner-db). Read-only.
// Column names/types mirror the DEPLOYED view contract (workbook D4a).

@cds.persistence.exists
entity Edition {
  key ID                    : String(36);
      CREATEDAT             : Timestamp;
      CREATEDBY             : String(255);
      MODIFIEDAT            : Timestamp;
      MODIFIEDBY            : String(255);
      YEAR                  : String(4);
      NAME                  : String(100);
      STARTSAT              : Timestamp;
      ENDSAT                : Timestamp;
      TIMEZONE              : String(50);
      ISCURRENT             : Boolean;
}

@cds.persistence.exists
entity Track {
  key ID                    : String(36);
      CREATEDAT             : Timestamp;
      CREATEDBY             : String(255);
      MODIFIEDAT            : Timestamp;
      MODIFIEDBY            : String(255);
      EDITION_ID            : String(36);
      NAME                  : String(100);
      DESCRIPTION           : String(500);
      DAYOFWEEK             : String(5000);
      ISACTIVITYTRACK       : Boolean;
      ACRONYM               : String(10);
      COLOR                 : String(16);
      EMOJI                 : String(8);
}

@cds.persistence.exists
entity Trackowner {
  key ID                    : String(36);
      TRACK_ID              : String(36);
      EMAIL                 : String(255);
      NAME                  : String(100);
}

@cds.persistence.exists
entity Session {
  key ID                    : String(36);
      CREATEDAT             : Timestamp;
      CREATEDBY             : String(255);
      MODIFIEDAT            : Timestamp;
      MODIFIEDBY            : String(255);
      SESSIONCODE           : String(20);
      TRACK_ID              : String(36);
      TITLE                 : String(200);
      ABSTRACT              : LargeString;
      STATUS                : String(5000);
      BROADCASTINGPREFERENCE: String(5000);
      SESSIONLENGTH         : String(5000);
      WEEK                  : String(5000);
      SCHEDULEDSTART        : Timestamp;
      SCHEDULEDTIMEZONE     : String(50);
      RECORDINGSTART        : Timestamp;
      MEETINGTITLE          : String(200);
      ZOOMURL               : String(500);
      ZOOMINVITEDETAILS     : LargeString;
      YOUTUBEURL            : String(500);
      LINKEDINURL           : String(500);
      COMMUNITYEVENTURL     : String(500);
      CALENDARINVITE        : LargeString;
      ACTIVITY_ID           : String(36);
}

@cds.persistence.exists
entity Activity {
  key ID                    : String(36);
      CREATEDAT             : Timestamp;
      CREATEDBY             : String(255);
      MODIFIEDAT            : Timestamp;
      MODIFIEDBY            : String(255);
      TITLE                 : String(200);
      TRACK_ID              : String(36);
      STATUS                : String(5000);
      WEEK                  : String(5000);
      POINTS                : Integer;
      TASK_ID               : String(36);
      TASKTYPE              : String(20);
      TASKSLUG              : String(255);
      TASKTITLE             : String(255);
}

@cds.persistence.exists
entity Speaker {
  key ID                    : String(36);
      CREATEDAT             : Timestamp;
      CREATEDBY             : String(255);
      MODIFIEDAT            : Timestamp;
      MODIFIEDBY            : String(255);
      FIRSTNAME             : String(100);
      LASTNAME              : String(100);
      EMAIL                 : String(255);
      COMPANY               : String(200);
      ROLE                  : String(200);
      PHOTO                 : LargeBinary;
      BIO                   : LargeString;
      PHOTOTYPE             : String(5000);
}

@cds.persistence.exists
entity Sessionspeaker {
  key ID                    : String(36);
      SESSION_ID            : String(36);
      SPEAKER_ID            : String(36);
      SPEAKERORDER          : Integer;
}

@cds.persistence.exists
entity Speakerconsent {
  key ID                    : String(36);
      CREATEDAT             : Timestamp;
      CREATEDBY             : String(255);
      MODIFIEDAT            : Timestamp;
      MODIFIEDBY            : String(255);
      SPEAKER_ID            : String(36);
      EDITION_ID            : String(36);
      CONSENTSENTDATE       : Timestamp;
      CONSENTRECEIVED       : Boolean;
      CONSENTRECEIVEDDATE   : Timestamp;
}

@cds.persistence.exists
entity Emailtemplate {
  key ID                    : String(36);
      CREATEDAT             : Timestamp;
      CREATEDBY             : String(255);
      MODIFIEDAT            : Timestamp;
      MODIFIEDBY            : String(255);
      NAME                  : String(100);
      TYPE                  : String(5000);
      MODE                  : String(5000);
      SUBJECT               : String(500);
      BODYTEMPLATE          : LargeString;
      TRACK_ID              : String(36);
}

@cds.persistence.exists
entity VhStatus {
  key CODE                  : String(20);
}

@cds.persistence.exists
entity VhBroadcastingpref {
  key CODE                  : String(20);
}

@cds.persistence.exists
entity VhSessionlength {
  key CODE                  : String(5);
}

@cds.persistence.exists
entity VhWeek {
  key CODE                  : String(2);
}

@cds.persistence.exists
entity VhEmailtemplatetype {
  key CODE                  : String(20);
}

@cds.persistence.exists
entity VhEmailtemplatemode {
  key CODE                  : String(20);
}
