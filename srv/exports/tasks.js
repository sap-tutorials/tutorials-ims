import cds from '@sap/cds';

export const legacyHeader = [
  'ID', 'TITLE', 'DESCRIPTION', 'STATUS', 'DELETION_REASON',
  'PRIMARY_TAG', 'EXPERIENCE_TAG', 'AVERAGE_TIME_TO_COMPLETE',
  'TASK_TYPE', 'CREATED_AT', 'MODIFIED_AT'
];

export async function* rows(db, opts = {}) {
  const pageSize = opts.pageSize ?? 5000;
  const { Tasks } = cds.entities('com.sap.developers.ims');
  let offset = 0;
  while (true) {
    const page = await db.run(
      SELECT.from(Tasks)
        .orderBy('taskType asc', 'legacyId asc')
        .limit(pageSize, offset)
    );
    if (!page.length) return;
    for (const r of page) {
      yield [
        r.legacyId,
        r.title ?? '',
        r.description ?? '',
        r.status ?? '',
        r.deletionReason ?? '',
        r.primaryTag ?? '',
        r.experienceTag ?? '',
        r.averageTimeToComplete ?? '',
        r.taskType,
        r.createdAt ?? '',
        r.modifiedAt ?? ''
      ];
    }
    if (page.length < pageSize) return;
    offset += pageSize;
  }
}
