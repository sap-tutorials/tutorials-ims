import cds from '@sap/cds';

export function buildNgdsPayload({ uuid, taskLegacyId, taskType, taskTitle, completionDate, eventLegacyId, sapId }) {
  return {
    context: 'developers.sap.com',
    trackingInfo: {
      userId: uuid,
      timestamp: completionDate
    },
    imsData: {
      taskId: taskLegacyId,
      taskType,
      eventId: eventLegacyId || undefined
    },
    interactionData: {
      title: taskTitle,
      completionDate,
      sapAccountNumber: sapId || undefined
    }
  };
}

export async function sendToNgds(payloadData) {
  const { NGDSFailedMessages } = cds.entities('com.sap.developers.ims');
  const payload = buildNgdsPayload(payloadData);

  try {
    const ngds = await cds.connect.to('ngds');
    await ngds.send('POST', '/ngds/developers/ims', payload);
    return { success: true };
  } catch (err) {
    const LOG = cds.log('ngds');
    LOG.error('NGDS send failed, storing for retry:', err.message);
    await INSERT.into(NGDSFailedMessages).entries({
      payload: JSON.stringify(payload),
      errorMessage: err.message,
      createdAt: new Date().toISOString(),
      retryCount: 0,
      status: 'PENDING'
    });
    return { success: false, error: err.message };
  }
}

export async function retryFailedMessages() {
  const { NGDSFailedMessages } = cds.entities('com.sap.developers.ims');
  const LOG = cds.log('ngds');

  const pending = await SELECT.from(NGDSFailedMessages)
    .where({ status: 'PENDING' });

  let retried = 0;
  for (const msg of pending) {
    if (msg.retryCount >= msg.maxRetries) {
      await UPDATE(NGDSFailedMessages, msg.ID).set({ status: 'FAILED_PERMANENTLY' });
      continue;
    }
    try {
      const ngds = await cds.connect.to('ngds');
      await ngds.send('POST', '/ngds/developers/ims', JSON.parse(msg.payload));
      await DELETE.from(NGDSFailedMessages, msg.ID);
      retried++;
    } catch (err) {
      const newCount = msg.retryCount + 1;
      const update = { retryCount: newCount };
      if (newCount >= msg.maxRetries) update.status = 'FAILED_PERMANENTLY';
      await UPDATE(NGDSFailedMessages, msg.ID).set(update);
      LOG.warn(`NGDS retry failed (${newCount}/${msg.maxRetries}):`, err.message);
    }
  }
  return retried;
}
