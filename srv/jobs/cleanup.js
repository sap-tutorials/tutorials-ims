import cds from '@sap/cds';

export async function cleanupStepFailures(olderThanDays = 90) {
  const { StepFailures } = cds.entities('com.sap.developers.ims');
  const LOG = cds.log('jobs/cleanup');
  const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
  const result = await DELETE.from(StepFailures).where({ failureDate: { '<': cutoff } });
  LOG.info(`Cleaned up step failures older than ${olderThanDays} days: ${result} removed`);
  return result;
}

export async function cleanupContentVersions(keepCount = 3, olderThanDays = 7) {
  const { ContentManifest, ContentFiles } = cds.entities('com.sap.developers.ims');
  const LOG = cds.log('jobs/cleanup');
  const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();

  const candidates = await SELECT.from(ContentManifest)
    .where({ status: { in: ['SUPERSEDED', 'ROLLED_BACK'] }, createdAt: { '<': cutoff } })
    .orderBy('version desc')
    .columns('version', 'status', 'createdAt');

  // Always keep the N most recent superseded versions for rollback
  const toPrune = candidates.slice(keepCount);
  if (toPrune.length === 0) {
    LOG.info('No content versions to prune');
    return 0;
  }

  const versions = toPrune.map(r => r.version);
  await DELETE.from(ContentFiles).where({ version: { in: versions } });
  await DELETE.from(ContentManifest).where({ version: { in: versions } });

  LOG.info(`Pruned ${toPrune.length} old content versions (kept last ${keepCount}, cutoff ${olderThanDays}d)`);
  return toPrune.length;
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

export async function cleanupPipelineLog(retentionDays = 30) {
  const { PipelineLog } = cds.entities('com.sap.developers.ims');
  const LOG = cds.log('jobs/cleanup');
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  const result = await DELETE.from(PipelineLog).where({ startedAt: { '<': cutoff } });
  LOG.info(`Cleaned up pipeline log entries older than ${retentionDays} days: ${result} removed`);
  return result;
}

export async function cleanupStuckPublishing(olderThanMinutes = 60) {
  const { ContentManifest } = cds.entities('com.sap.developers.ims');
  const LOG = cds.log('jobs/cleanup');
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const stuck = await SELECT.from(ContentManifest)
    .where({ status: 'PUBLISHING', createdAt: { '<': cutoff } })
    .columns('version');
  if (stuck.length === 0) {
    LOG.info('No stuck PUBLISHING manifests found');
    return 0;
  }
  const versions = stuck.map(r => r.version);
  await UPDATE(ContentManifest)
    .where({ version: { in: versions } })
    .set({ status: 'FAILED' });
  LOG.info(`Marked ${stuck.length} stuck PUBLISHING manifests as FAILED (older than ${olderThanMinutes}m)`);
  return stuck.length;
}

export async function pruneOrphanEmbeddings() {
  const { ContentManifest, ContentFiles, Tutorials, TutorialEmbedding } =
    cds.entities('com.sap.developers.ims');
  const LOG = cds.log('jobs/cleanup');

  const manifest = await SELECT.one.from(ContentManifest).where({ status: 'ACTIVE' });
  if (!manifest) {
    LOG.info('pruneOrphanEmbeddings: no active manifest, skipping');
    return 0;
  }

  const files = await SELECT.from(ContentFiles).columns('slug').where({ version: manifest.version });
  const activeSlugs = new Set(files.map(f => f.slug));

  const tutorials = await SELECT.from(Tutorials).columns('ID', 'slug');
  const orphanIds = tutorials.filter(t => !activeSlugs.has(t.slug)).map(t => t.ID);

  if (orphanIds.length === 0) {
    LOG.info('pruneOrphanEmbeddings: no orphan tutorial embeddings to prune');
    return 0;
  }

  const result = await DELETE.from(TutorialEmbedding).where({ tutorial_ID: { in: orphanIds } });
  LOG.info(`pruneOrphanEmbeddings: deleted ${result} orphan embedding rows for ${orphanIds.length} tutorials`);
  return result;
}
