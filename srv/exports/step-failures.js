import cds from '@sap/cds';

export const legacyHeader = [
  'ID', 'TASK_RECORD_ID', 'STEP_NUMBER', 'FAILURE_DATE', 'ERROR_MESSAGE',
  'RULE', 'QUESTION', 'MATCH', 'ANSWER', 'STEP_URL', 'TUTORIAL_ID', 'TITLE',
  'CREATED_AT'
];

export async function* rows(db, opts = {}) {
  const pageSize = opts.pageSize ?? 5000;
  const { StepFailures } = cds.entities('com.sap.developers.ims');
  let offset = 0;
  while (true) {
    const page = await db.run(
      SELECT.from(StepFailures)
        .columns('ID', 'taskRecord_ID', 'stepNumber', 'failureDate', 'errorMessage', 'legacyId')
        .orderBy('legacyId asc')
        .limit(pageSize, offset)
    );
    if (!page.length) return;
    for (const r of page) {
      yield [
        r.ID, r.taskRecord_ID, r.stepNumber ?? '', r.failureDate ?? '', r.errorMessage ?? '',
        '', '', '', '', '', '', '',
        ''
      ];
    }
    if (page.length < pageSize) return;
    offset += pageSize;
  }
}
