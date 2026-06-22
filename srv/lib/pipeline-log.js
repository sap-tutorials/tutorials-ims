import cds from '@sap/cds';

const { randomUUID } = await import('node:crypto');

/**
 * Start a pipeline log entry. Returns the log ID for later completion.
 *
 * Optional `id` parameter lets callers reuse an external correlation ID
 * (e.g. ContentManifest.sessionId for the chunked publish path so the
 * PipelineLog row 1:1's the manifest row). When omitted, a fresh UUID
 * is allocated.
 */
export async function logPipelineStart(pipelineType, initiator, metadata, namespace = 'com.sap.developers.ims', { id } = {}) {
  const { PipelineLog } = cds.entities(namespace);
  const ID = id || randomUUID();
  const startedAt = new Date().toISOString();

  await INSERT.into(PipelineLog).entries({
    ID,
    pipelineType,
    status: 'RUNNING',
    startedAt,
    initiator: initiator || 'system',
    metadata: metadata ? JSON.stringify(metadata) : null
  });

  return ID;
}

/**
 * Complete a pipeline log entry with final status.
 */
export async function logPipelineEnd(logId, status, summary, errorDetails, namespace = 'com.sap.developers.ims') {
  const { PipelineLog } = cds.entities(namespace);
  const finishedAt = new Date().toISOString();

  const entry = await SELECT.one.from(PipelineLog, logId).columns('startedAt');
  const durationMs = entry?.startedAt
    ? new Date(finishedAt).getTime() - new Date(entry.startedAt).getTime()
    : null;

  await UPDATE(PipelineLog, logId).set({
    status,
    finishedAt,
    durationMs,
    summary: summary?.slice(0, 2000) || null,
    errorDetails: errorDetails || null
  });
}

/**
 * Wrap an async function with pipeline logging.
 * Logs start before execution, success/failure after.
 */
export async function logPipeline(pipelineType, initiator, fn, metadata, namespace = 'com.sap.developers.ims') {
  const logId = await logPipelineStart(pipelineType, initiator, metadata, namespace);
  try {
    const result = await fn();
    const summary = typeof result === 'string' ? result : undefined;
    await logPipelineEnd(logId, 'SUCCESS', summary, undefined, namespace);
    return result;
  } catch (err) {
    await logPipelineEnd(logId, 'FAILED', null, err.message || String(err), namespace);
    throw err;
  }
}

/**
 * Record a per-slug failure or warning under an in-flight pipeline log.
 * Items show up as a sub-table on the PipelineLog Object Page so admins can
 * drill from a run into the specific tutorials that had issues.
 */
export async function logPipelineItem(logId, { slug, phase, severity, message }, namespace = 'com.sap.developers.ims') {
  if (!logId) return;
  const { PipelineLogItems } = cds.entities(namespace);
  await INSERT.into(PipelineLogItems).entries({
    ID: randomUUID(),
    pipelineLog_ID: logId,
    slug: (slug || '').slice(0, 255) || null,
    phase,
    severity: severity || 'ERROR',
    message: (message ? String(message) : '').slice(0, 2000) || null
  });
}

/**
 * Record a per-record outcome under an in-flight scheduled-job log.
 * Items show up as a sub-table on the JobExecutionLog Object Page so admins can
 * drill from a run into the individual records the job processed.
 */
export async function logJobItem(logId, { itemKey, itemKind, status, message }, namespace = 'com.sap.developers.ims') {
  if (!logId) return;
  const { JobLogItems } = cds.entities(namespace);
  await INSERT.into(JobLogItems).entries({
    ID: randomUUID(),
    jobLog_ID: logId,
    itemKey: (itemKey || '').slice(0, 255) || null,
    itemKind: itemKind || 'OTHER',
    status: status || 'SUCCESS',
    message: (message ? String(message) : '').slice(0, 2000) || null
  });
}
