import cds from '@sap/cds';
import { acquireLock, releaseLock } from '../jobs/job-lock.js';

const LOCK_NAME = 'content-publish';
const LOCK_DURATION_MS = 30 * 60 * 1000;
const INSTANCE_ID = process.env.CF_INSTANCE_GUID || `local-${process.pid}`;

export function createSessionHelpers({ namespace }) {
  async function getNextVersion() {
    const { ContentManifest } = cds.entities(namespace);
    const max = await SELECT.one.from(ContentManifest).columns('max(version) as v');
    return (max?.v || 0) + 1;
  }

  async function beginPublishSession({ trigger, hugoVersion, expectedSlugCount }) {
    const locked = await acquireLock(LOCK_NAME, INSTANCE_ID, LOCK_DURATION_MS, namespace);
    if (!locked) {
      const err = new Error('Another publish in progress');
      err.statusCode = 409;
      throw err;
    }

    try {
      const version = await getNextVersion();
      const sessionId = cds.utils.uuid();
      const { ContentManifest } = cds.entities(namespace);

      await INSERT.into(ContentManifest).entries({
        version,
        status: 'PUBLISHING',
        sessionId,
        trigger: (trigger || 'unknown').slice(0, 500),
        fileCount: 0,
        totalSizeBytes: 0,
        changedSlugs: JSON.stringify([]),
        hugoVersion: hugoVersion || null,
        lastAppendAt: new Date().toISOString()
      });

      return { sessionId, version, expectedSlugCount: expectedSlugCount || 0 };
    } catch (err) {
      await releaseLock(LOCK_NAME, INSTANCE_ID, namespace).catch(() => {});
      throw err;
    }
  }

  return { beginPublishSession };
}
