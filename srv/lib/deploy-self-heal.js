// srv/lib/deploy-self-heal.js
//
// Self-heals CAP-sourced static content after a Cloud Foundry deploy.
//
// WHY THIS EXISTS
// ---------------
// The approuter serves the Hugo static site (concepts, developer-advocates,
// homepage shelves, etc.) from its container filesystem. Two things make that
// content fragile across a deploy:
//
//   1. `mbt build` bakes `hugo/public/` into the MTA archive. That content is
//      only correct if the pre-build fetch pointed at a backend that actually
//      HAS the data. A local `cds watch` (the default CAP_BASE_URL) has ZERO
//      published concepts, so an operator who forgets to point build:all at a
//      populated backend ships an EMPTY concepts index (incident 2026-07-12).
//
//   2. The content-rebuild workflow (rebuild-content.yml → /admin/rebuild)
//      swaps fresh content onto the approuter's EPHEMERAL disk. Every
//      `cf deploy` / restart / cell migration resets that disk to the baked
//      MTA droplet — silently reverting whatever the rebuild added.
//
// Either way, the durable source of truth (HANA) is fine; only the static
// pages baked into / served from the approuter go stale. This module closes
// the loop: on the first boot after any new deploy, the srv dispatches a
// catalog-only content rebuild, which re-fetches from THIS backend (which has
// the data) and re-pushes fresh static content to the approuter.
//
// ONCE PER DEPLOY, NOT PER RESTART
// --------------------------------
// A crash loop must NOT dispatch a rebuild on every restart. We key a JobLocks
// sentinel on `VCAP_APPLICATION.application_version` — Cloud Foundry mints a
// fresh version GUID on every `cf push`/deploy (including a same-commit
// redeploy, which is exactly what happened on 2026-07-12). Crash-restarts of
// the SAME droplet reuse the same version, so the sentinel is already held and
// we skip. This mirrors srv/lib/purge-stale-changelog.js:autoPurgeOnce.
//
// FAIL-OPEN
// ---------
// Every fault path (no version, lock error, dispatch error) is swallowed and
// logged. This is a housekeeping task, never a boot requirement — it must not
// crash srv startup.

import cds from '@sap/cds';
import { acquireLock } from '../jobs/job-lock.js';
import { scheduleRebuild } from './rebuild-trigger.js';

const LOG = cds.log('deploy-self-heal');

// JobLocks sentinel held for 30 minutes. The dispatch itself fires within the
// rebuild-trigger debounce window (~60s); the generous hold is a recovery
// valve — if a deploy's rebuild genuinely failed, a restart >30 min later
// re-attempts. Well under any legitimate deploy cadence.
const SENTINEL_HOLD_MS = 30 * 60 * 1000;

/**
 * Resolve the Cloud Foundry application version GUID. Fresh on every deploy.
 * Returns null when not running on CF (local dev) — callers skip in that case,
 * since local dev has no ephemeral-approuter problem to heal.
 *
 * @returns {string|null}
 */
export function currentDeployVersion() {
  const raw = process.env.VCAP_APPLICATION;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw).application_version;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * One-shot, called from cds.on('served'). Dispatches a catalog-only content
 * rebuild the first time srv boots under a given deploy version, guarded by a
 * JobLocks sentinel so exactly one CF instance triggers per deploy.
 *
 * @param {Object} [opts]
 * @param {string} [opts.version]  Override the resolved deploy version (tests).
 * @returns {Promise<{triggered: boolean, reason: string}>}
 *   - {triggered:true}  a rebuild was dispatched by this caller
 *   - {triggered:false, reason:'no-version'}  not on CF / no version → skip
 *   - {triggered:false, reason:'already-triggered'}  sentinel already held
 *   - {triggered:false, reason:'error'}  a fault path swallowed the failure
 */
export async function selfHealOnDeploy({ version } = {}) {
  const deployVersion = version ?? currentDeployVersion();
  if (!deployVersion) {
    LOG.debug('No CF deploy version (local dev?) — skipping deploy self-heal');
    return { triggered: false, reason: 'no-version' };
  }

  // Sentinel name embeds the version so a NEW deploy always gets a fresh,
  // unheld lock name. Truncate the GUID for readability in the JobLocks table;
  // CF version GUIDs are unique in their first segment.
  const jobName = `deploy-self-heal-${deployVersion}`;
  const instanceId = process.env.CF_INSTANCE_INDEX || '0';

  try {
    const acquired = await acquireLock(jobName, instanceId, SENTINEL_HOLD_MS);
    if (!acquired) {
      LOG.info(`Sentinel ${jobName} already held — deploy already self-healed`);
      return { triggered: false, reason: 'already-triggered' };
    }

    // Intentionally do NOT release the lock — the JobLocks row IS the sentinel
    // for this deploy version. Same discipline as autoPurgeOnce.
    await scheduleRebuild('deploy-self-heal', { mode: 'catalog-only' });
    LOG.info(
      `New deploy version ${deployVersion} — dispatched catalog-only rebuild to refresh approuter static content`,
    );
    return { triggered: true, reason: 'dispatched' };
  } catch (err) {
    // Never fatal. A stale approuter is a degraded surface, not a down one,
    // and an admin write or a manual `gh workflow run` still heals it.
    LOG.warn('Deploy self-heal failed (non-fatal):', err.message ?? err);
    return { triggered: false, reason: 'error' };
  }
}
