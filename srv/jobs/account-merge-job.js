import cds from '@sap/cds';
import { mergeAccounts } from '../lib/account-merge.js';

export async function processAccountMerges() {
  const { PrimaryAccounts, SecondaryAccounts } = cds.entities('com.sap.developers.ims');
  const LOG = cds.log('jobs/account-merge');

  const pending = await SELECT.from(SecondaryAccounts).where({ status: 'SCHEDULED' });
  let processed = 0;

  for (const secondary of pending) {
    const primary = await SELECT.one.from(PrimaryAccounts, secondary.primaryAccount_ID);
    if (!primary) {
      LOG.warn(`Primary account not found for secondary ${secondary.uuid}`);
      continue;
    }

    try {
      await mergeAccounts(primary.uuid, secondary.uuid);
      processed++;
    } catch (err) {
      LOG.error(`Failed to merge ${secondary.uuid} → ${primary.uuid}:`, err.message);
      await UPDATE(SecondaryAccounts, secondary.ID).set({ status: 'FAILED' });
    }
  }

  LOG.info(`Processed ${processed} account merges`);
  return processed;
}
