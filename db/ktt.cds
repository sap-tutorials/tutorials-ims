namespace com.sap.developers.ims;
using { com.sap.developers.ims as ims, cuid } from './schema';

/** Catalog of KTT lessons — metadata only, so a KTT_LESSON completion
    row in TaskRecords can join to its title/kind in MyCompletions.
    Progress lives in TaskRecords, not here. Seeded from hugo/data/ktt_lessons.json. */
entity KttLessons : cuid {
  legacyId : Integer @assert.unique;   // stable int used as TaskRecords.taskLegacyId
  slug     : String(120) @assert.unique;
  unitId   : String(60);
  title    : String(200);
  order    : Integer default 0;
}
