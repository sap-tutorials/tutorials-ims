import cds from '@sap/cds';
import { embedSlugs } from '../lib/embedding-pipeline.js';
import { logPipelineStart, logPipelineEnd } from '../lib/pipeline-log.js';

const LOG = cds.log('rag-reconcile');

export async function reconcileAll({ activeSlugs, slugsWithStaleHashes, slugsWithoutEmbeddings, settings }) {
  const activeSet = activeSlugs instanceof Set ? activeSlugs : new Set(activeSlugs);
  const candidateSet = new Set(
    [...slugsWithStaleHashes, ...slugsWithoutEmbeddings].filter((s) => activeSet.has(s))
  );
  const candidates = [...candidateSet];
  if (candidates.length === 0) return { candidates: 0, embedded: 0, skipped: 0, failed: 0 };
  const result = await embedSlugs(candidates, settings);
  return { candidates: candidates.length, ...result };
}

export async function runReconciliationJob() {
  const { ChatSettings, ContentManifest, ContentFiles, Steps, TutorialEmbedding, Tutorials } =
    cds.entities('com.sap.developers.ims');

  const settings = await SELECT.one.from(ChatSettings);
  if (!settings?.ragEnabled) {
    LOG.info('ragEnabled=false, skipping reconciliation');
    return { skipped: true };
  }

  const pipelineId = await logPipelineStart('SCHEDULED_JOB', 'reconciliation-cron', { job: 'embedding-reconciliation' });
  try {
    const manifest = await SELECT.one.from(ContentManifest).where({ status: 'ACTIVE' });
    if (!manifest) {
      LOG.info('no active manifest, skipping reconciliation');
      const summary = JSON.stringify({ skipped: true, reason: 'no active manifest' });
      await logPipelineEnd(pipelineId, 'SUCCESS', summary);
      return { skipped: true, reason: 'no active manifest' };
    }

    const activeFiles = await SELECT.from(ContentFiles).columns('slug').where({ version: manifest.version });
    const activeSlugs = activeFiles.map((f) => f.slug);
    const activeSet = new Set(activeSlugs);

    const stepRows = await SELECT.from(Steps).columns('tutorial_ID', 'stepOrder', 'contentHash');
    const embedRows = await SELECT.from(TutorialEmbedding).columns('tutorial_ID', 'stepNumber', 'contentHash', 'embeddingModel');
    const tutorials = await SELECT.from(Tutorials).columns('ID', 'slug');
    const tToSlug = new Map(tutorials.map((t) => [t.ID, t.slug]));

    const embedKey = (tid, stepNum) => `${tid}:${stepNum}`;
    const embedMap = new Map(embedRows.map((e) => [embedKey(e.tutorial_ID, e.stepNumber), e]));

    const stale = new Set();
    const missing = new Set();
    for (const s of stepRows) {
      const slug = tToSlug.get(s.tutorial_ID);
      if (!slug || !activeSet.has(slug)) continue;
      const e = embedMap.get(embedKey(s.tutorial_ID, s.stepOrder));
      if (!e) { missing.add(slug); continue; }
      if (e.contentHash !== s.contentHash) stale.add(slug);
      if (e.embeddingModel !== settings.embeddingModel) stale.add(slug);
    }

    const result = await reconcileAll({
      activeSlugs: activeSet,
      slugsWithStaleHashes: [...stale],
      slugsWithoutEmbeddings: [...missing],
      settings
    });
    await logPipelineEnd(pipelineId, 'SUCCESS', JSON.stringify(result));
    LOG.info('reconciliation complete', result);
    return result;
  } catch (err) {
    await logPipelineEnd(pipelineId, 'FAILED', null, err.message || String(err));
    throw err;
  }
}
