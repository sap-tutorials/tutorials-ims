import cds from '@sap/cds';

export async function acquireLock(jobName, instanceId, durationMs) {
  const { JobLocks } = cds.entities('com.sap.developers.ims');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMs);

  try {
    await INSERT.into(JobLocks).entries({
      jobName, lockedBy: instanceId,
      lockedAt: now.toISOString(), expiresAt: expiresAt.toISOString()
    });
    return true;
  } catch (e) {
    // Row exists — try to claim expired lock
  }

  const result = await UPDATE(JobLocks)
    .where({ jobName, expiresAt: { '<': now.toISOString() } })
    .set({ lockedBy: instanceId, lockedAt: now.toISOString(), expiresAt: expiresAt.toISOString() });

  if (result === 0) return false;

  // Verify we actually hold the lock (guards against concurrent UPDATE race)
  const [row] = await SELECT.from(JobLocks).where({ jobName }).columns('lockedBy');
  return row?.lockedBy === instanceId;
}

export async function releaseLock(jobName, instanceId) {
  const { JobLocks } = cds.entities('com.sap.developers.ims');
  await DELETE.from(JobLocks).where({ jobName, lockedBy: instanceId });
}
