import cds from '@sap/cds';

const LOG = cds.log('rag-stats');

export async function computeEmbeddingStats() {
  const { ContentManifest, ContentFiles, Tutorials, Steps, TutorialEmbedding, PipelineLog } =
    cds.entities('com.sap.developers.ims');

  const manifest = await SELECT.one.from(ContentManifest).where({ status: 'ACTIVE' });
  if (!manifest) {
    return {
      activeManifest: null,
      slugs: 0,
      slugsWithEmbeddings: 0,
      totalSteps: 0,
      embeddedSteps: 0,
      missing: 0,
      stale: 0,
      lastRun: null
    };
  }

  // Active slugs from the current manifest version
  const files = await SELECT.from(ContentFiles).columns('slug').where({ version: manifest.version });
  const slugs = files.map((f) => f.slug);
  const activeSlugSet = new Set(slugs);

  // Tutorials matching active slugs
  const tutorials = await SELECT.from(Tutorials).columns('ID', 'slug').where({ slug: { in: slugs } });
  const tIds = tutorials.map((t) => t.ID);
  const tToSlug = new Map(tutorials.map((t) => [t.ID, t.slug]));

  let totalSteps = 0;
  let embeddedSteps = 0;
  let missing = 0;
  let stale = 0;
  const slugsWithEmbeddingsSet = new Set();

  if (tIds.length > 0) {
    const stepRows = await SELECT.from(Steps)
      .columns('tutorial_ID', 'stepOrder', 'contentHash')
      .where({ tutorial_ID: { in: tIds } });

    const embedRows = await SELECT.from(TutorialEmbedding)
      .columns('tutorial_ID', 'stepNumber', 'contentHash')
      .where({ tutorial_ID: { in: tIds } });

    const embedKey = (tid, stepNum) => `${tid}:${stepNum}`;
    const embedMap = new Map(embedRows.map((e) => [embedKey(e.tutorial_ID, e.stepNumber), e]));

    // Count embedded steps for denominator (active tutorials only)
    for (const e of embedRows) {
      const slug = tToSlug.get(e.tutorial_ID);
      if (slug && activeSlugSet.has(slug)) embeddedSteps++;
    }

    for (const s of stepRows) {
      const slug = tToSlug.get(s.tutorial_ID);
      if (!slug || !activeSlugSet.has(slug)) continue;
      totalSteps++;
      const e = embedMap.get(embedKey(s.tutorial_ID, s.stepOrder));
      if (!e) {
        missing++;
      } else {
        if (e.contentHash !== s.contentHash) stale++;
        slugsWithEmbeddingsSet.add(s.tutorial_ID);
      }
    }
  }

  // Last reconciliation cron run
  let lastRun = null;
  try {
    const row = await SELECT.one
      .from(PipelineLog)
      .columns('startedAt', 'status', 'initiator')
      .where({ pipelineType: 'SCHEDULED_JOB', metadata: { like: '%embedding-reconciliation%' } })
      .orderBy({ startedAt: 'desc' });
    if (row) {
      lastRun = { startedAt: row.startedAt, status: row.status, initiator: row.initiator };
    }
  } catch (err) {
    LOG.warn('PipelineLog lookup failed', err.message);
  }

  return {
    activeManifest: manifest.version,
    slugs: slugs.length,
    slugsWithEmbeddings: slugsWithEmbeddingsSet.size,
    totalSteps,
    embeddedSteps,
    missing,
    stale,
    lastRun
  };
}
