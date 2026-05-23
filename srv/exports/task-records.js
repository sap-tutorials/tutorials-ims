import cds from '@sap/cds';

export const legacyHeader = [
  'ID', 'USER_ID', 'TASK_ID', 'TASK_TYPE', 'STATUS', 'PROGRESS',
  'COMPLETION_TIME', 'COMPLETION_DATE', 'CONTENT_LANGUAGE', 'SITE_LANGUAGE',
  'SUBMISSION_ID_STARTED', 'SUBMISSION_ID_COMPLETED', 'TITLE_SNAPSHOT',
  'PROGRESS_NOTE', 'EVENT', 'CREATED_AT', 'MODIFIED_AT'
];

export async function* rows(db, opts = {}) {
  const pageSize = opts.pageSize ?? 5000;
  const { TaskRecords } = cds.entities('com.sap.developers.ims');
  let offset = 0;
  while (true) {
    const page = await db.run(
      SELECT.from(TaskRecords)
        .columns('ID','user_ID','taskLegacyId','taskType','status','progress',
                 'completionTime','completionDate','contentLanguage','siteLanguage',
                 'submissionIdStarted','submissionIdCompleted','titleSnapshot',
                 'progressNote','event_ID','createdAt','modifiedAt','legacyId')
        .orderBy('legacyId asc')
        .limit(pageSize, offset)
    );
    if (!page.length) return;
    for (const r of page) {
      yield [
        r.ID, r.user_ID, r.taskLegacyId, r.taskType, r.status, r.progress ?? '',
        r.completionTime ?? '', r.completionDate ?? '',
        r.contentLanguage ?? '', r.siteLanguage ?? '',
        r.submissionIdStarted ?? '', r.submissionIdCompleted ?? '',
        r.titleSnapshot ?? '', r.progressNote ?? '',
        r.event_ID ?? '', r.createdAt ?? '', r.modifiedAt ?? ''
      ];
    }
    if (page.length < pageSize) return;
    offset += pageSize;
  }
}
