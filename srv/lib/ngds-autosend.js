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
import * as metrics from './metrics.js';

const AUTOSEND_CONFIG_KEY = 'ngds.autosend.enabled';
// Cutover watermark. When set to an ISO date (e.g. '2026-08-01T00:00:00Z'),
// completions whose completionDate predate it are NOT sent — legacy IMS already
// credited those achievements. Missing/blank/invalid → no date suppression
// (the migration-stamp guard below still applies). Admin-editable via ImsConfig.
const AUTOSEND_EPOCH_KEY = 'ngds.autosend.epoch';

// context.user_id must be an SCI/IAS uid (P-number, S-number, or the legacy
// I-number form) for NGDS to resolve a universal id. When Users.sapId is absent
// or holds a non-canonical value (e.g. a migrated 32-char hex community id), a
// send is guaranteed to fail downstream with "Cannot find universal id" /
// "Cannot find Community userId" — so we suppress it here rather than emit an
// unresolvable key and pollute NGDSFailedMessages. Case-insensitive; the API
// accepts the letter prefix in either case.
const CANONICAL_SAP_ID = /^[PSIps]\d{6,}$/;

// NGDS-eligible task types. Legacy NGDSTaskRecordEventHandler only enqueued
// TUTORIAL, GROUP, and MISSION — STEP/CHECKPOINT/PUZZLE/PETOBERFEST were never
// sent. Keep parity so puzzle/petoberfest completions (which flow through the
// same createTaskRecord path) do not leak into the badging feed.
const NGDS_ELIGIBLE_TASK_TYPES = new Set(['TUTORIAL', 'GROUP', 'MISSION']);

// Cache the DB flag briefly so a burst of completions doesn't hit ImsConfig on
// every send. 60s is short enough that flipping the kill-switch takes effect
// within a minute (matches the alert cache-bust expectation elsewhere). The
// cutover epoch shares the same TTL window.
let _flagCache = { value: false, at: 0 };
let _epochCache = { value: null, at: 0 };
const FLAG_TTL_MS = 60 * 1000;

export function resetAutoSendFlagCache() {
  _flagCache = { value: false, at: 0 };
  _epochCache = { value: null, at: 0 };
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
 * Resolve the cutover epoch (ms since epoch) from ImsConfig, cached for FLAG_TTL_MS.
 * Returns null when unset/blank/invalid → the caller applies no date suppression.
 * Exported for the admin config surface.
 */
export async function resolveAutoSendEpoch(db) {
  const now = Date.now();
  if (now - _epochCache.at < FLAG_TTL_MS) return _epochCache.value;
  let epochMs = null;
  try {
    const { ImsConfig } = cds.entities('com.sap.developers.ims');
    const row = await db.run(
      SELECT.one.from(ImsConfig).columns('value').where({ key: AUTOSEND_EPOCH_KEY })
    );
    const raw = row?.value;
    if (raw != null && String(raw).trim() !== '') {
      const t = new Date(raw).getTime();
      if (Number.isFinite(t)) epochMs = t;
      else cds.log('ngds').warn(`ngds autosend epoch "${raw}" is not a valid date; ignoring`);
    }
  } catch (err) {
    // Fail OPEN on the epoch read (unlike the enable flag): a read fault should
    // not silently drop genuinely-new completions. The migration-stamp guard
    // still protects against replaying historical rows.
    cds.log('ngds').warn('ngds autosend epoch read failed; no date suppression:', err.message);
    epochMs = null;
  }
  _epochCache = { value: epochMs, at: now };
  return epochMs;
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
 *                                     legacyId/taskLegacyId/taskType/status/user_ID;
 *                                     createdBy + completionDate drive the
 *                                     historical-completion guards)
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

    // Historical-completion guard #1 (migration stamp): rows carried over from
    // legacy IMS (createdBy='migration') were already credited by legacy's own
    // NGDS sender. This also covers a record migrated as IN_PROGRESS and then
    // finished on the new platform — legacy owns that achievement's lifecycle.
    if (record.createdBy === 'migration') {
      metrics.counter('ngds.autosend.skipped.migration');
      return;
    }

    const database = db || await cds.connect.to('db');
    if (!(await isAutoSendActive(database))) return;

    // Historical-completion guard #2 (cutover epoch): skip completions earned
    // before go-live even on a non-migration row. Belt-and-suspenders with the
    // stamp guard above (either firing suppresses the send).
    const epochMs = await resolveAutoSendEpoch(database);
    if (epochMs != null) {
      const when = record.completionDate || record.modifiedAt;
      const t = when ? new Date(when).getTime() : NaN;
      if (Number.isFinite(t) && t < epochMs) {
        metrics.counter('ngds.autosend.skipped.pre_epoch');
        return;
      }
    }

    // Identity gate: only send when the user carries a canonical SCI/IAS uid.
    // A missing or non-canonical sapId (e.g. a migrated hex community id) is
    // unresolvable downstream, so suppress + count rather than emit a doomed
    // key and queue it in NGDSFailedMessages for pointless retries.
    if (!(await hasResolvableIdentity(record, database))) {
      metrics.counter('ngds.autosend.skipped.no_identity');
      cds.log('ngds').debug?.('ngds autosend skipped: no resolvable sapId for user', record.user_ID);
      return;
    }

    // Import lazily so unit tests that never enable auto-send don't pull the
    // client (and its cds.connect.to('ngds')) into their graph.
    const { sendTaskRecordToNgds } = await import('./ngds-client.js');
    const outcome = await sendTaskRecordToNgds(record, database);
    if (outcome && outcome.success) metrics.counter('ngds.autosend.sent');
    else metrics.counter('ngds.autosend.failed');
  } catch (err) {
    // Never let an auto-send fault propagate into the completion transaction.
    cds.log('ngds').error('maybeAutoSendCompletion failed (non-fatal):', err.message);
  }
}

/**
 * True when the record's user has a canonical SCI/IAS uid in Users.sapId. Reads
 * only the sapId column. Fails CLOSED (no uid resolvable → false) so a lookup
 * fault never emits an unresolvable key.
 */
async function hasResolvableIdentity(record, db) {
  if (!record.user_ID) return false;
  try {
    const { Users } = cds.entities('com.sap.developers.ims');
    const user = await db.run(
      SELECT.one.from(Users).columns('sapId').where({ ID: record.user_ID })
    );
    const sapId = user?.sapId;
    return typeof sapId === 'string' && CANONICAL_SAP_ID.test(sapId.trim());
  } catch (err) {
    cds.log('ngds').warn('ngds autosend identity check failed; treating as unresolvable:', err.message);
    return false;
  }
}
