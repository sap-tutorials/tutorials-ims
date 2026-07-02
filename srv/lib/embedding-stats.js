// srv/lib/embedding-stats.js
//
// Health/diagnostic stats for the RAG embedding pipeline. Answers "how much
// of the active catalog is covered by embeddings, and how much of that is
// stale?" — surfaced on the admin embeddings tile and used by the
// reconciliation cron to decide what to re-embed.
//
// Coverage is scoped to the currently-ACTIVE ContentManifest so numbers
// track what visitors are actually reading, not orphaned historical rows.

import cds from '@sap/cds';

const LOG = cds.log('rag-stats');

/**
 * Compute embedding coverage + freshness stats for the active catalog.
 *
 * Definitions:
 *   - `slugs` — number of slugs in the ACTIVE ContentManifest's ContentFiles.
 *   - `slugsWithEmbeddings` — subset of those slugs that have ≥1 embedded step.
 *   - `totalSteps` — total Steps rows across tutorials matching those slugs.
 *   - `embeddedSteps` — Steps rows that have a matching TutorialEmbedding
 *     (matched by `(tutorial_ID, stepNumber)`).
 *   - `missing` — Steps rows without any TutorialEmbedding — needs first embed.
 *   - `stale` — Steps rows with an embedding whose `contentHash` no longer
 *     matches the Step's `contentHash` — needs re-embed. Assumes both sides
 *     compute the hash the same way (see embedding-pipeline.js).
 *   - `lastRun` — most recent PipelineLog row tagged `embedding-reconciliation`.
 *     PipelineLog lookup swallows errors (returns null) so a stats call is
 *     never blocked by an audit-table hiccup.
 *
 * Returns an all-zero snapshot with `activeManifest: null` when no manifest
 * is ACTIVE (fresh deploy, mid-rollback, etc.) — callers should render this
 * as "no data" rather than "coverage is 0%".
 *
 * @returns {Promise<{
 *   activeManifest: number | null,
 *   slugs: number,
 *   slugsWithEmbeddings: number,
 *   totalSteps: number,
 *   embeddedSteps: number,
 *   missing: number,
 *   stale: number,
 *   lastRun: { startedAt: Date, status: string, initiator: string } | null
 * }>}
 */
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

    // `(tutorial_ID, stepNumber)` is the join key. TutorialEmbedding stores
    // stepNumber (1-based, matches Steps.stepOrder), not the Step PK.
    const embedKey = (tid, stepNum) => `${tid}:${stepNum}`;
    const embedMap = new Map(embedRows.map((e) => [embedKey(e.tutorial_ID, e.stepNumber), e]));

    for (const s of stepRows) {
      const slug = tToSlug.get(s.tutorial_ID);
      // Guard against Steps rows for tutorials not in the active manifest —
      // possible during rollback windows or after a slug rename.
      if (!slug || !activeSlugSet.has(slug)) continue;
      totalSteps++;
      const e = embedMap.get(embedKey(s.tutorial_ID, s.stepOrder));
      if (!e) {
        missing++;
      } else {
        embeddedSteps++;
        // Stale ≠ missing: the row exists but was computed against different
        // markdown. Reconciliation re-embeds these in the next cron tick.
        if (e.contentHash !== s.contentHash) stale++;
        slugsWithEmbeddingsSet.add(s.tutorial_ID);
      }
    }
  }

  // Last reconciliation cron run. `metadata LIKE '%embedding-reconciliation%'`
  // matches whether the job name lives in metadata JSON or as a substring —
  // PipelineLog schema has drifted historically, so we're lenient here.
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
    // Non-fatal: an audit-table hiccup shouldn't hide the coverage numbers
    // the caller actually wants. Warn and continue with lastRun=null.
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
