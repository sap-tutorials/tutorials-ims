using { external.devtoberfest as ext } from '../db/external/devtoberfest';

// Read-only cross-container access to Devtoberfest Planner data
// (devtoberfest-planner-db, via synonyms + @cds.persistence.exists facades).
@requires: 'authenticated-user'
service DevtoberfestService @(path: '/devtoberfest') {
  @readonly entity Edition as projection on ext.Edition;
  @readonly entity Track as projection on ext.Track;
  @readonly entity Trackowner as projection on ext.Trackowner;
  @readonly entity Session as projection on ext.Session;
  @readonly entity Speaker as projection on ext.Speaker;
  @readonly entity Sessionspeaker as projection on ext.Sessionspeaker;
  @readonly entity Speakerconsent as projection on ext.Speakerconsent;
  @readonly entity Emailtemplate as projection on ext.Emailtemplate;
  @readonly entity VhStatus as projection on ext.VhStatus;
  @readonly entity VhBroadcastingpref as projection on ext.VhBroadcastingpref;
  @readonly entity VhSessionlength as projection on ext.VhSessionlength;
  @readonly entity VhWeek as projection on ext.VhWeek;
  @readonly entity VhEmailtemplatetype as projection on ext.VhEmailtemplatetype;
  @readonly entity VhEmailtemplatemode as projection on ext.VhEmailtemplatemode;
}
