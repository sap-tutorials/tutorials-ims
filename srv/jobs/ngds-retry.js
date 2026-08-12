import cds from '@sap/cds';
import { logJobItem } from '../lib/pipeline-log.js';
import * as metrics from '../lib/metrics.js';
import * as alerting from '../lib/alerting.js';

// Alert-decision policy for a single retry run. Pure — no I/O — so the
// thresholds and severities are unit-testable in isolation. Thresholds are
// code constants by design (issue: NGDS silent-failure visibility).
export const BACKLOG_THRESHOLD = 20;

export function buildRetryAlerts({ failed = 0, exhausted = 0, pendingRemaining = 0 } = {}) {
  const alerts = [];
  if (exhausted > 0) {
    alerts.push({
      eventType: 'NgdsSendExhausted',
      severity: 'ERROR',
      subject: `NGDS: ${exhausted} message(s) permanently dropped`,
      body: `retryNgds marked ${exhausted} message(s) FAILED_PERMANENTLY this run; `
          + `${pendingRemaining} still pending. Their NGDS badge events are lost.`,
    });
  }
  if (failed > 0 || pendingRemaining >= BACKLOG_THRESHOLD) {
    alerts.push({
      eventType: 'NgdsBacklog',
      severity: 'WARNING',
      subject: `NGDS feed unhealthy: ${pendingRemaining} pending, ${failed} failed this run`,
      body: `retryNgds: failed=${failed}, exhausted=${exhausted}, pendingRemaining=${pendingRemaining}. `
          + `NGDS may be unreachable or misconfigured.`,
    });
  }
  return alerts;
}

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
      if (newCount >= msg.maxRetries) {
        update.status = 'FAILED_PERMANENTLY';
        exhausted++; // newly exhausted this run — permanently dropped
      }
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

  const pendingRemaining = pending.length - retried - exhausted;
  metrics.gauge('ngds.failed_messages.pending', pendingRemaining);
  if (failed > 0) metrics.counter('ngds.retry.failed', failed);
  if (exhausted > 0) metrics.counter('ngds.retry.exhausted', exhausted);
  for (const alert of buildRetryAlerts({ failed, exhausted, pendingRemaining })) {
    await alerting.raise({
      ...alert,
      category: 'ALERT',
      resource: { resourceName: 'ngds-retry', resourceType: 'job' },
    });
  }

  return { pending: pending.length, retried, exhausted, failed };
}
