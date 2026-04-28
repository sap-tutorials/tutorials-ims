import cds from '@sap/cds';
import { getNextLegacyId } from '../lib/legacy-id.js';

export async function recordActiveLearners() {
  const { TaskRecords, ActiveLearnerRecords } = cds.entities('com.sap.developers.ims');
  const db = await cds.connect.to('db');
  const LOG = cds.log('jobs/analytics');

  const today = new Date().toISOString().split('T')[0];
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();

  const recentRecords = await SELECT.from(TaskRecords)
    .where({ modifiedAt: { '>=': oneDayAgo } })
    .columns('user_ID');

  const uniqueUsers = new Set(recentRecords.map(r => r.user_ID));

  await INSERT.into(ActiveLearnerRecords).entries({
    recordDate: today,
    count: uniqueUsers.size,
    legacyId: await getNextLegacyId('ActiveLearnerRecords', db)
  });

  LOG.info(`Recorded ${uniqueUsers.size} active learners for ${today}`);
  return uniqueUsers.size;
}
