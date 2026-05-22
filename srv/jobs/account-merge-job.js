import cds from '@sap/cds';
import { mergeAccounts } from '../lib/account-merge.js';
import { logJobItem } from '../lib/pipeline-log.js';

export async function processAccountMerges(logId) {
  const { PrimaryAccounts, SecondaryAccounts } = cds.entities('com.sap.developers.ims');
  const LOG = cds.log('jobs/account-merge');

  const pending = await SELECT.from(SecondaryAccounts).where({ status: 'SCHEDULED' });
  let processed = 0, failed = 0, skipped = 0;

  for (const secondary of pending) {
    const primary = await SELECT.one.from(PrimaryAccounts, secondary.primaryAccount_ID);
    if (!primary) {
      LOG.warn(`Primary account not found for secondary ${secondary.uuid}`);
      skipped++;
      await logJobItem(logId, {
        itemKey: secondary.uuid,
        itemKind: 'ACCOUNT_MERGE',
        status: 'SKIPPED',
        message: `Primary account ${secondary.primaryAccount_ID} not found`
      });
      continue;
    }

    try {
      await mergeAccounts(primary.uuid, secondary.uuid);
      processed++;
      await logJobItem(logId, {
        itemKey: secondary.uuid,
        itemKind: 'ACCOUNT_MERGE',
        status: 'SUCCESS',
        message: `Merged into ${primary.uuid}`
      });
    } catch (err) {
      LOG.error(`Failed to merge ${secondary.uuid} → ${primary.uuid}:`, err.message);
      await UPDATE(SecondaryAccounts, secondary.ID).set({ status: 'FAILED' });
      failed++;
      await logJobItem(logId, {
        itemKey: secondary.uuid,
        itemKind: 'ACCOUNT_MERGE',
        status: 'ERROR',
        message: err.message
      });
    }
  }

  LOG.info(`Processed ${processed} account merges`);
  return { pending: pending.length, processed, failed, skipped };
}
