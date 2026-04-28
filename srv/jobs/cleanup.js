import cds from '@sap/cds';

export async function cleanupStepFailures(olderThanDays = 90) {
  const { StepFailures } = cds.entities('com.sap.developers.ims');
  const LOG = cds.log('jobs/cleanup');
  const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
  const result = await DELETE.from(StepFailures).where({ failureDate: { '<': cutoff } });
  LOG.info(`Cleaned up step failures older than ${olderThanDays} days: ${result} removed`);
  return result;
}

export async function cleanupUnusedTags() {
  const { Tags, TutorialTags } = cds.entities('com.sap.developers.ims');
  const LOG = cds.log('jobs/cleanup');
  const usedTagIds = await SELECT.from(TutorialTags).columns('tag_ID');
  const usedSet = new Set(usedTagIds.map(r => r.tag_ID));
  const allTags = await SELECT.from(Tags).columns('ID');
  const unused = allTags.filter(t => !usedSet.has(t.ID));
  if (unused.length === 0) return 0;
  await DELETE.from(Tags).where({ ID: { in: unused.map(t => t.ID) } });
  LOG.info(`Cleaned up ${unused.length} unused tags`);
  return unused.length;
}
