import cds from '@sap/cds';

export const legacyHeader = ['ID', 'NAME', 'MISSION_ID', 'ITEM_ORDER'];

export async function* rows(db, opts = {}) {
  const pageSize = opts.pageSize ?? 5000;
  const { CompletionPaths } = cds.entities('com.sap.developers.ims');
  let offset = 0;
  while (true) {
    const page = await db.run(
      SELECT.from(CompletionPaths)
        .columns('legacyId', 'name', 'mission.legacyId as missionLegacyId')
        .orderBy('legacyId asc')
        .limit(pageSize, offset)
    );
    if (!page.length) return;
    for (const r of page) yield [r.legacyId, r.name ?? '', r.missionLegacyId ?? '', ''];
    if (page.length < pageSize) return;
    offset += pageSize;
  }
}
