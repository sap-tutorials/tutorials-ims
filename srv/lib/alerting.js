// srv/lib/alerting.js
// Fail-open push-alert helper. Never throws — sits BESIDE existing failure
// signals (metrics/log/PipelineLog), never replaces them. Gating is DB-backed
// and admin-editable: ChatSettings.alertsEnabled via the alert-settings
// resolver (NOT an env var — project rule: tunable behavior lives in the DB,
// toggled live in the admin UI). Default OFF until an admin enables it.
import cds from '@sap/cds'
import { isAlertingEnabled } from './runtime-config/alert-settings.js'

const LOG = cds.log('alerting')
let svcPromise  // memoised connection

export async function raise (input) {
  try {
    if (!(await isAlertingEnabled())) return
    svcPromise ??= cds.connect.to('alerts')
    const svc = await svcPromise
    await svc.raise(input)
  } catch (e) {
    // Never propagate — alerting must not break the path it watches.
    svcPromise = undefined // allow a later reconnect attempt
    LOG.warn('alert raise failed (swallowed):', e?.message ?? e)
  }
}

// Test-only: reset the memoised connection between cases.
export function _resetForTest () { svcPromise = undefined }
