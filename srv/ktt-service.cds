using { com.sap.developers.ims as ims } from '../db/ktt';

@path: '/ktt'
@requires: 'any'
service KttService {

  @readonly entity Lessons as projection on ims.KttLessons;

  @(requires: 'authenticated-user')
  action completeLesson(lessonSlug: String, legacyId: Integer, title: String)
    returns { ok: Boolean; alreadyDone: Boolean };

  @(requires: 'authenticated-user')
  action syncProgress(localJson: LargeString)
    returns { xp: Integer; streak: Integer; mastered: array of String };

  function banter(context: String) returns String;
}
