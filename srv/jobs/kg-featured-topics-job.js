// srv/jobs/kg-featured-topics-job.js
// Nightly rebuild of FeaturedTopicsSnapshot at 04:13 UTC (after PageRank + communities).
// Spec: docs/superpowers/specs/2026-07-06-1032-featured-missions-carousel-design.md §7.4.
import cds from '@sap/cds';
import { recomputeSnapshot } from '../lib/featured-topics-snapshot.js';

const LOG = cds.log('kg-featured-topics');

export async function runKgFeaturedTopics(_logId) {
  const started = Date.now();
  try {
    const { count, computedAt } = await cds.tx(async (tx) => recomputeSnapshot(tx));
    LOG.info(`snapshot rewritten in ${Date.now() - started}ms — ${count} slots at ${computedAt.toISOString()}`);
    return { count, computedAt };
  } catch (err) {
    LOG.error(`snapshot rebuild failed after ${Date.now() - started}ms — snapshot table left untouched`, err);
    throw err;
  }
}
