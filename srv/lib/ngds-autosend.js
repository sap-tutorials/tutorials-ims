// srv/lib/ngds-autosend.js
//
// PROD-only automatic NGDS send on task completion. Legacy Java IMS fired NGDS
// synchronously on every task create/complete via NGDSTaskRecordEventHandler.
// In CAP the completion writes bypass the OData service layer (raw cds.db
// INSERT/UPDATE in developer-service._updateTutorialProgress + createTaskRecord),
// so there is no service `after` hook to attach to — instead the completion
// code paths call maybeAutoSendCompletion() explicitly at the point a record
// transitions to COMPLETED.
//
// Two independent gates, BOTH must pass (see PR discussion / issue follow-up):
//   1. Environment gate — CF space_name === 'prod' (resolveDeployEnvironment).
//      The only non-spoofable runtime signal; DEV and PROD share one XSUAA
//      tenant so we cannot key off host/JWT. Bulk recompute (raw HANA MERGE)
//      and migration (raw SQL) never reach the completion code paths, so they
//      cannot flood NGDS regardless — the env gate is the outer guard.
//   2. DB kill-switch — ImsConfig key 'ngds.autosend.enabled' must equal
//      'true'. Mirrors legacy ApplicationConfigurationService.isServiceEnabled
//      and lets an admin stop the outbound feed instantly without a redeploy.
//      Defaults OFF (missing row → disabled) so enabling is a deliberate act.

import cds from '@sap/cds';
import { resolveDeployEnvironment } from './deploy-environment.js';

const AUTOSEND_CONFIG_KEY = 'ngds.autosend.enabled';

// NGDS-eligible task types. Legacy NGDSTaskRecordEventHandler only enqueued
// TUTORIAL, GROUP, and MISSION — STEP/CHECKPOINT/PUZZLE/PETOBERFEST were never
// sent. Keep parity so puzzle/petoberfest completions (which flow through the
// same createTaskRecord path) do not leak into the badging feed.
const NGDS_ELIGIBLE_TASK_TYPES = new Set(['TUTORIAL', 'GROUP', 'MISSION']);

// Cache the DB flag briefly so a burst of completions doesn't hit ImsConfig on
// every send. 60s is short enough that flipping the kill-switch takes effect
// within a minute (matches the alert cache-bust expectation elsewhere).
let _flagCache = { value: false, at: 0 };
const FLAG_TTL_MS = 60 * 1000;

export function resetAutoSendFlagCache() {
  _flagCache = { value: false, at: 0 };
}

async function isAutoSendEnabledInDb(db) {
  const now = Date.now();
  if (now - _flagCache.at < FLAG_TTL_MS) return _flagCache.value;
  let enabled = false;
  try {
    const { ImsConfig } = cds.entities('com.sap.developers.ims');
    const row = await db.run(
      SELECT.one.from(ImsConfig).columns('value').where({ key: AUTOSEND_CONFIG_KEY })
    );
    enabled = String(row?.value).toLowerCase() === 'true';
  } catch (err) {
    // Fail CLOSED: any config-read fault leaves auto-send disabled rather than
    // risk an unintended outbound burst. Log so operators can see it.
    cds.log('ngds').warn('ngds autosend flag read failed; treating as disabled:', err.message);
    enabled = false;
  }
  _flagCache = { value: enabled, at: now };
  return enabled;
}

/**
 * True when auto-send is active in this runtime: CF space=prod AND the DB
 * kill-switch is on. Exported for tests and for callers that want to short-
 * circuit expensive record resolution before deciding to send.
 */
export async function isAutoSendActive(db, vcapOverride) {
  const env = resolveDeployEnvironment(vcapOverride);
  if (env.id !== 'prod') return false;
  return isAutoSendEnabledInDb(db);
}

/**
 * Fire an NGDS send for a just-persisted TaskRecord IFF it just transitioned to
 * COMPLETED and auto-send is active. Fire-and-forget from the caller's view:
 * never throws (a send failure is queued in NGDSFailedMessages by the client),
 * so a completion write is never rolled back by an NGDS problem.
 *
 * @param {object} opts
 * @param {object} opts.record        the persisted TaskRecord (must carry
 *                                     legacyId/taskLegacyId/taskType/status/user_ID)
 * @param {string} [opts.priorStatus] the record's status BEFORE this write, so
 *                                     we only fire on the edge → COMPLETED and
 *                                     not on repeat saves of an already-complete
 *                                     record. Omit/null when the row is new.
 * @param {object} opts.db            db connection
 */
export async function maybeAutoSendCompletion({ record, priorStatus = null, db }) {
  try {
    if (!record || record.status !== 'COMPLETED') return;
    // Edge-only: skip when the record was ALREADY completed before this write.
    if (priorStatus === 'COMPLETED') return;
    // Legacy parity: only TUTORIAL/GROUP/MISSION are NGDS-eligible.
    if (!NGDS_ELIGIBLE_TASK_TYPES.has(record.taskType)) return;

    const database = db || await cds.connect.to('db');
    if (!(await isAutoSendActive(database))) return;

    // Import lazily so unit tests that never enable auto-send don't pull the
    // client (and its cds.connect.to('ngds')) into their graph.
    const { sendTaskRecordToNgds } = await import('./ngds-client.js');
    await sendTaskRecordToNgds(record, database);
  } catch (err) {
    // Never let an auto-send fault propagate into the completion transaction.
    cds.log('ngds').error('maybeAutoSendCompletion failed (non-fatal):', err.message);
  }
}
