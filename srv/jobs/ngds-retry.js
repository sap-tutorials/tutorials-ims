import cds from '@sap/cds';
import { logJobItem } from '../lib/pipeline-log.js';

export async function retryNgds(logId) {
  const { NGDSFailedMessages } = cds.entities('com.sap.developers.ims');
  const LOG = cds.log('ngds');

  const pending = await SELECT.from(NGDSFailedMessages).where({ status: 'PENDING' });
  let retried = 0, exhausted = 0, failed = 0;

  for (const msg of pending) {
    if (msg.retryCount >= msg.maxRetries) {
      await UPDATE(NGDSFailedMessages, msg.ID).set({ status: 'FAILED_PERMANENTLY' });
      exhausted++;
      await logJobItem(logId, {
        itemKey: msg.ID,
        itemKind: 'NGDS_RETRY',
        status: 'ERROR',
        message: `Marked FAILED_PERMANENTLY (retryCount ${msg.retryCount} >= maxRetries ${msg.maxRetries})`
      });
      continue;
    }
    try {
      const ngds = await cds.connect.to('ngds');
      await ngds.send('POST', '/ngds/developers/ims', JSON.parse(msg.payload));
      await DELETE.from(NGDSFailedMessages, msg.ID);
      retried++;
      await logJobItem(logId, {
        itemKey: msg.ID,
        itemKind: 'NGDS_RETRY',
        status: 'SUCCESS',
        message: `Replayed after ${msg.retryCount} prior failures`
      });
    } catch (err) {
      const newCount = msg.retryCount + 1;
      const update = { retryCount: newCount };
      if (newCount >= msg.maxRetries) update.status = 'FAILED_PERMANENTLY';
      await UPDATE(NGDSFailedMessages, msg.ID).set(update);
      LOG.warn(`NGDS retry failed (${newCount}/${msg.maxRetries}):`, err.message);
      failed++;
      await logJobItem(logId, {
        itemKey: msg.ID,
        itemKind: 'NGDS_RETRY',
        status: newCount >= msg.maxRetries ? 'ERROR' : 'WARN',
        message: `Retry ${newCount}/${msg.maxRetries} failed: ${err.message}`
      });
    }
  }

  return { pending: pending.length, retried, exhausted, failed };
}
