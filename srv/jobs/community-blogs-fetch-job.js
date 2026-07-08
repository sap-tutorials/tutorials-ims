// srv/jobs/community-blogs-fetch-job.js
// (#1033) 30-min RSS fetch job. Thin wrapper around fetchAllSources.

import cds from '@sap/cds';
import { fetchAllSources } from '../lib/community-blogs-fetcher.js';

const LOG = cds.log('community-blogs-fetch-job');

/**
 * Standard cron chassis signature (see srv/jobs/scheduler.js). The
 * chassis logs PipelineLog start/end + JobLastRun automatically; we
 * just return a summary.
 */
export async function runCommunityBlogsFetch(/* logId */) {
  const summary = await fetchAllSources();
  LOG.info('runCommunityBlogsFetch:', JSON.stringify(summary));
  return summary;
}
