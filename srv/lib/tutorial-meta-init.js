import cds from '@sap/cds';
import { getNextLegacyId } from './legacy-id.js';

export async function backfillMissingTutorialMeta() {
  const db = await cds.connect.to('db');
  const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
  const all = await SELECT.from(Tutorials).columns('ID');
  let created = 0;
  for (const t of all) {
    const exists = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: t.ID });
    if (exists) continue;
    await INSERT.into(TutorialMeta).entries({
      ID: cds.utils.uuid(), tutorial_ID: t.ID,
      owner: null, reviewedDate: null,
      monitoredStatus: 'ACTIVE', notificationNumber: 0,
      lastNotificationDate: null,
      legacyId: await getNextLegacyId('TutorialMeta', db)
    });
    created++;
  }
  return { created };
}
