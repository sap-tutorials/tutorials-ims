// srv/jobs/community-blogs-fetch-job.js
// (#1033) 30-min RSS fetch job. Thin wrapper around fetchAllSources.

import cds from '@sap/cds';
import { fetchAllSources } from '../lib/community-blogs-fetcher.js';

const LOG = cds.log('community-blogs-fetch-job');

/**
 * Standard cron chassis signature (see srv/jobs/scheduler.js). The
 * chassis logs PipelineLog start/end + JobLastRun automatically; we
 * just return a summary.
 *
 * Fail-loud rule: if EVERY source errored (Cloudflare 403 from CF egress
 * is the recurring cause on `community.sap.com` RSS feeds), throw so the
 * cron chassis writes LASTERRORAT + LASTERRORMESSAGE. Silent 0-insert
 * runs otherwise mask the outage for months — see the memory pointer
 * "silent-swallow-hides-dead-code" in MEMORY.md.
 */
export async function runCommunityBlogsFetch(/* logId */) {
  const summary = await fetchAllSources();
  LOG.info('runCommunityBlogsFetch:', JSON.stringify(summary));
  if (summary.sources > 0 && summary.errored >= summary.sources) {
    throw new Error(
      `community-blogs-fetch: all ${summary.sources} sources errored ` +
      `(fetched=${summary.fetched} inserted=${summary.inserted})`
    );
  }
  return summary;
}
