import cds from '@sap/cds';
import { acquireLock } from '../jobs/job-lock.js';

const LOG = cds.log('purge-stale-changelog');

/**
 * Entities whose `@changelog` was removed in #658. The auto-purge helper
 * defaults to this list when called without an explicit `entities` argument.
 *
 * If a future PR drops @changelog from another entity, add it here AND bump
 * the sentinel version in srv/server.js so the auto-purge re-runs to clean
 * up the legacy rows.
 */
export const NOISE_ENTITIES = Object.freeze([
  'com.sap.developers.ims.ChatSettings',
  'com.sap.developers.ims.KnowledgeGraphSettings',
  'com.sap.developers.ims.UiEventsSettings',
  'com.sap.developers.ims.TenantSettings',
  'com.sap.developers.ims.DisplaySettings',
  'com.sap.developers.ims.SearchSettings',
  'com.sap.developers.ims.NavigatorSettings',
  'com.sap.developers.ims.Concepts',
  'com.sap.developers.ims.ConceptEdges',
]);

/**
 * Bulk-delete `sap.changelog.Changes` rows by `entity`. Returns the number of
 * rows removed. When `entities` is empty / nullish / not an array, the
 * NOISE_ENTITIES default list is used.
 *
 * @param {Object}   [opts]
 * @param {string[]} [opts.entities] Explicit entity allowlist.
 * @returns {Promise<{deleted: number}>}
 */
export async function purgeStaleChangelog({ entities } = {}) {
  const list =
    Array.isArray(entities) && entities.length > 0 ? entities : NOISE_ENTITIES;
  const Changes = cds.entities('sap.changelog').Changes;
  const deleted = await DELETE.from(Changes).where({ entity: { in: list } });
  LOG.info(`Deleted ${deleted} changelog rows across ${list.length} entities`);
  return { deleted };
}

/**
 * One-shot wrapper called from cds.on('served'). Uses the JobLocks-based
 * lock primitive so exactly one CF instance runs the purge on each deploy.
 * The `version` string is part of the lock name; bump it (`-v2`, `-v3`, …)
 * when a future PR adds new entities to NOISE_ENTITIES and the legacy rows
 * need a fresh sweep.
 *
 * Returns `{ deleted, alreadyRan }`. `alreadyRan: true` means the sentinel
 * row was already present in `JobLocks` and this caller did not delete
 * anything.
 *
 * The lock is held for 10 minutes (deliberately generous — the actual
 * DELETE runs in seconds, but we never release the lock so the row acts
 * as a permanent sentinel). When the lock expires after 10 minutes,
 * `acquireLock` will let a future deploy take it over. That's intentional
 * — if NOISE_ENTITIES is bumped without changing the version suffix,
 * the next deploy MORE-THAN-10-minutes later will re-sweep, which is a
 * harmless idempotent DELETE.
 */
export async function autoPurgeOnce({ version = 'v1' } = {}) {
  const jobName = `changelog-noise-purge-${version}`;
  const instanceId = process.env.CF_INSTANCE_INDEX || '0';
  const TEN_MINUTES = 10 * 60 * 1000;

  const acquired = await acquireLock(jobName, instanceId, TEN_MINUTES);
  if (!acquired) {
    LOG.info(`Sentinel ${jobName} already held; skipping auto-purge`);
    return { deleted: 0, alreadyRan: true };
  }

  // Intentionally do NOT release the lock — the JobLocks row is the sentinel.
  // The 10-minute expiry is the recovery valve in case a future entity-list
  // bump needs to re-sweep without writing a one-off migration.
  const result = await purgeStaleChangelog();
  return { ...result, alreadyRan: false };
}
