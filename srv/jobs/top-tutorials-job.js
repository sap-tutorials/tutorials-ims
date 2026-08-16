// srv/jobs/top-tutorials-job.js
// Nightly rebuild of TopTutorialsSnapshot at 04:53 UTC. Issue #1782.
// Fail-open: on error the snapshot table is left untouched (atomic replace
// inside recomputeSnapshot's tx) and readers keep yesterday's rows.
// Spec: docs/superpowers/specs/2026-08-14-top-tutorials-ranking-design.md
import cds from '@sap/cds';
import { recomputeSnapshot } from '../lib/top-tutorials-snapshot.js';

const LOG = cds.log('top-tutorials');

export async function runTopTutorials(_logId) {
  const started = Date.now();
  try {
    const { count, computedAt } = await cds.tx(async (tx) => recomputeSnapshot(tx));
    LOG.info(`snapshot rewritten in ${Date.now() - started}ms — ${count} rows at ${computedAt.toISOString()}`);
    return { count, computedAt };
  } catch (err) {
    LOG.error(`snapshot rebuild failed after ${Date.now() - started}ms — table left untouched`, err);
    throw err;
  }
}
