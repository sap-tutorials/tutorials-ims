namespace external.devtoberfest;

// @cds.persistence.exists proxies over cross-container synonyms to the
// Devtoberfest Planner's DTF_*_V1 views (devtoberfest-planner-db). Read-only.
// Column names/types mirror the DEPLOYED view contract (workbook D4a).

@cds.persistence.exists
entity Edition {
  key ID                    : String(36);
      createdAt             : Timestamp;
      createdBy             : String(255);
      modifiedAt            : Timestamp;
      modifiedBy            : String(255);
      year                  : String(4);
      name                  : String(100);
      startDate             : Date;
      endDate               : Date;
      isCurrent             : Boolean;
}

@cds.persistence.exists
entity Track {
  key ID                    : String(36);
      createdAt             : Timestamp;
      createdBy             : String(255);
      modifiedAt            : Timestamp;
      modifiedBy            : String(255);
      edition_ID            : String(36);
      name                  : String(100);
      description           : String(500);
      dayOfWeek             : String(5000);
      isActivityTrack       : Boolean;
      acronym               : String(10);
}

@cds.persistence.exists
entity Trackowner {
  key ID                    : String(36);
      track_ID              : String(36);
      email                 : String(255);
      name                  : String(100);
}

@cds.persistence.exists
entity Session {
  key ID                    : String(36);
      createdAt             : Timestamp;
      createdBy             : String(255);
      modifiedAt            : Timestamp;
      modifiedBy            : String(255);
      sessionCode           : String(20);
      track_ID              : String(36);
      title                 : String(200);
      abstract              : LargeString;
      status                : String(5000);
      broadcastingPreference: String(5000);
      sessionLength         : String(5000);
      week                  : String(5000);
      scheduledDate         : Date;
      scheduledTime         : Time;
      recordingDate         : Date;
      meetingTitle          : String(200);
      zoomURL               : String(500);
      zoomInviteDetails     : LargeString;
      youtubeURL            : String(500);
      linkedinURL           : String(500);
      communityEventURL     : String(500);
      calendarInvite        : LargeString;
      tutorialSlug          : String(255);
      tutorialTitle         : String(255);
      tutorial_ID           : String(36);
}

@cds.persistence.exists
entity Speaker {
  key ID                    : String(36);
      createdAt             : Timestamp;
      createdBy             : String(255);
      modifiedAt            : Timestamp;
      modifiedBy            : String(255);
      firstName             : String(100);
      lastName              : String(100);
      email                 : String(255);
      company               : String(200);
      role                  : String(200);
      photo                 : LargeBinary;
      bio                   : LargeString;
      photoType             : String(5000);
}

@cds.persistence.exists
entity Sessionspeaker {
  key ID                    : String(36);
      session_ID            : String(36);
      speaker_ID            : String(36);
      speakerOrder          : Integer;
}

@cds.persistence.exists
entity Speakerconsent {
  key ID                    : String(36);
      createdAt             : Timestamp;
      createdBy             : String(255);
      modifiedAt            : Timestamp;
      modifiedBy            : String(255);
      speaker_ID            : String(36);
      edition_ID            : String(36);
      consentSentDate       : Date;
      consentReceived       : Boolean;
      consentReceivedDate   : Date;
}

@cds.persistence.exists
entity Emailtemplate {
  key ID                    : String(36);
      createdAt             : Timestamp;
      createdBy             : String(255);
      modifiedAt            : Timestamp;
      modifiedBy            : String(255);
      name                  : String(100);
      type                  : String(5000);
      mode                  : String(5000);
      subject               : String(500);
      bodyTemplate          : LargeString;
      track_ID              : String(36);
}

@cds.persistence.exists
entity VhStatus {
  key code                  : String(20);
}

@cds.persistence.exists
entity VhBroadcastingpref {
  key code                  : String(20);
}

@cds.persistence.exists
entity VhSessionlength {
  key code                  : String(5);
}

@cds.persistence.exists
entity VhWeek {
  key code                  : String(2);
}

@cds.persistence.exists
entity VhEmailtemplatetype {
  key code                  : String(20);
}

@cds.persistence.exists
entity VhEmailtemplatemode {
  key code                  : String(20);
}
