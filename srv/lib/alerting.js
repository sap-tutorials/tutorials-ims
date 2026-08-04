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

// #1469: on-demand, result-returning sibling to raise(). Used ONLY by the
// admin "Send test alert" action so the admin sees whether the alert path
// actually fired. Same fail-open contract (never throws) but returns a
// structured outcome instead of swallowing silently. Reuses the memoised
// svcPromise. Callers must pass a unique resource.resourceName per click so
// the plugin's dedup window (dedupWindowMs) never silently drops the test.
export async function raiseTest (input) {
  try {
    if (!(await isAlertingEnabled())) return { outcome: 'disabled' }
    svcPromise ??= cds.connect.to('alerts')
    const svc = await svcPromise
    await svc.raise(input)
    return { outcome: 'delivered' }
  } catch (e) {
    svcPromise = undefined // allow a later reconnect attempt
    const reason = e?.message ?? String(e)
    LOG.warn('test alert raise failed:', reason)
    return { outcome: 'error', reason }
  }
}

// Test-only: reset the memoised connection between cases.
export function _resetForTest () { svcPromise = undefined }
