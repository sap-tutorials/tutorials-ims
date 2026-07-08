// srv/jobs/community-blogs-classify-job.js
// (#1033) 15-min classifier drain. Thin wrapper around classifyPendingBatch.

import cds from '@sap/cds';
import { classifyPendingBatch } from '../lib/community-blogs-classifier.js';

const LOG = cds.log('community-blogs-classify-job');

export async function runCommunityBlogsClassify(/* logId */) {
  const summary = await classifyPendingBatch();
  LOG.info('runCommunityBlogsClassify:', JSON.stringify(summary));
  return summary;
}
