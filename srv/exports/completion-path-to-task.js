import cds from '@sap/cds';

export const legacyHeader = ['PATH_ID', 'TUTORIAL_ID', 'GROUP_ID', 'CHECKPOINT_TITLE', 'PRIZE_ID', 'ITEM_ORDER'];

export async function* rows(db, opts = {}) {
  const pageSize = opts.pageSize ?? 5000;
  const { CompletionPathItems } = cds.entities('com.sap.developers.ims');
  let offset = 0;
  while (true) {
    const page = await db.run(
      SELECT.from(CompletionPathItems)
        .columns('legacyId', 'taskType', 'itemOrder',
                 'path.legacyId as pathLegacyId',
                 'tutorial.legacyId as tutorialLegacyId',
                 'group.legacyId as groupLegacyId',
                 'checkpointTitle',
                 'prize.legacyId as prizeLegacyId')
        .orderBy('legacyId asc')
        .limit(pageSize, offset)
    );
    if (!page.length) return;
    for (const r of page) {
      const tut = r.taskType === 'TUTORIAL'   ? (r.tutorialLegacyId ?? '')  : '';
      const grp = r.taskType === 'GROUP'      ? (r.groupLegacyId ?? '')     : '';
      const chk = r.taskType === 'CHECKPOINT' ? (r.checkpointTitle ?? '')   : '';
      yield [r.pathLegacyId ?? '', tut, grp, chk, r.prizeLegacyId ?? '', r.itemOrder ?? ''];
    }
    if (page.length < pageSize) return;
    offset += pageSize;
  }
}
