import cds from '@sap/cds';

export const legacyHeader = ['PARENT_TASK_ID', 'CHILD_TASK_ID', 'ITEM_ORDER'];

export async function* rows(db, opts = {}) {
  const pageSize = opts.pageSize ?? 5000;
  const { Steps, GroupPathItems } = cds.entities('com.sap.developers.ims');

  // Step -> Tutorial edges
  let offset = 0;
  while (true) {
    const page = await db.run(
      SELECT.from(Steps)
        .columns('legacyId', 'stepOrder', 'tutorial.legacyId as parentLegacyId')
        .where({ tutorial_ID: { '!=': null } })
        .orderBy('legacyId asc')
        .limit(pageSize, offset)
    );
    if (!page.length) break;
    for (const r of page) yield [r.parentLegacyId, r.legacyId, r.stepOrder ?? ''];
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  // Tutorial -> Group edges (GroupPathItems.tutorial is not null)
  offset = 0;
  while (true) {
    const page = await db.run(
      SELECT.from(GroupPathItems)
        .columns('legacyId', 'itemOrder', 'group.legacyId as parentLegacyId', 'tutorial.legacyId as childLegacyId')
        .where({ tutorial_ID: { '!=': null } })
        .orderBy('legacyId asc')
        .limit(pageSize, offset)
    );
    if (!page.length) break;
    for (const r of page) yield [r.parentLegacyId, r.childLegacyId, r.itemOrder ?? ''];
    if (page.length < pageSize) break;
    offset += pageSize;
  }
}
