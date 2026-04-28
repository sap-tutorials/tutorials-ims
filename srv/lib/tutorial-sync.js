import cds from '@sap/cds';
import { getNextLegacyId } from './legacy-id.js';

export async function syncTutorialMetadata(metadataSource) {
  const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
  const db = await cds.connect.to('db');
  const LOG = cds.log('tutorial-sync');
  let synced = 0;

  for (const entry of metadataSource) {
    const tutorial = await SELECT.one.from(Tutorials).where({ slug: entry.slug });
    if (!tutorial) {
      LOG.warn(`Tutorial not found for slug: ${entry.slug}`);
      continue;
    }

    const existing = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorial.ID });

    if (existing) {
      await UPDATE(TutorialMeta, existing.ID).set({
        owner: entry.owner,
        reviewedDate: entry.reviewedDate || existing.reviewedDate,
        monitoredStatus: entry.monitoredStatus || existing.monitoredStatus
      });
    } else {
      await INSERT.into(TutorialMeta).entries({
        tutorial_ID: tutorial.ID,
        owner: entry.owner,
        reviewedDate: entry.reviewedDate || null,
        monitoredStatus: 'ACTIVE',
        notificationNumber: 0,
        legacyId: await getNextLegacyId('TutorialMeta', db)
      });
    }
    synced++;
  }

  LOG.info(`Synced ${synced} tutorial metadata records`);
  return { synced };
}
